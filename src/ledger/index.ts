import { createHash, randomUUID } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeSync, fsyncSync } from "node:fs";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import type {
  AppendEventInput, BlobReceipt, DatabaseHandle, EventLedger, EventRecord, Json,
  LedgerOptions, SourceHandle,
} from "./types.js";
import { registerRawByteLimit } from "./internal.js";

interface Statement {
  get(...parameters: unknown[]): unknown;
  all(...parameters: unknown[]): unknown[];
  run(...parameters: unknown[]): { changes: number; lastInsertRowid: number | bigint };
}
interface Transaction<T extends unknown[], R> {
  (...args: T): R;
  immediate(...args: T): R;
}
interface Database {
  exec(sql: string): this;
  pragma(source: string, options?: { simple?: boolean }): unknown;
  prepare(sql: string): Statement;
  transaction<T extends unknown[], R>(fn: (...args: T) => R): Transaction<T, R>;
  close(): void;
}
interface DatabaseConstructor { new(path: string): Database; }
const Database = createRequire(import.meta.url)("better-sqlite3") as DatabaseConstructor;

class InvalidArchiveChunkError extends TypeError {}

const SCHEMA_VERSION = 1;
const MINIMUM_SQLITE = [3, 51, 3] as const;

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalJson(value: Json): string {
  if (typeof value === "number" && !Number.isFinite(value)) throw new TypeError("payload is not valid JSON");
  if (value === null || typeof value !== "object") {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) throw new TypeError("payload is not valid JSON");
    return encoded;
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson((value as Readonly<Record<string, Json>>)[key]!)}`).join(",")}}`;
}

function sqliteVersionSupported(version: string): boolean {
  const parts = version.split(".").map(Number);
  for (let index = 0; index < MINIMUM_SQLITE.length; index += 1) {
    const actual = parts[index] ?? 0;
    const required = MINIMUM_SQLITE[index]!;
    if (actual !== required) return actual > required;
  }
  return true;
}

function writeAll(descriptor: number, bytes: Uint8Array): void {
  let offset = 0;
  while (offset < bytes.byteLength) offset += writeSync(descriptor, bytes, offset);
}

type EventRow = {
  seq: number; event_id: string; schema_version: number; project_id: string;
  session_id: string; correlation_id: string; kind: EventRecord["kind"];
  source_timestamp: string; ingested_at: string; payload_json: string;
  payload_hash: string; previous_event_hash: string | null; event_hash: string;
  capture_status: EventRecord["capture_status"];
};

export function openLedger(options: LedgerOptions): EventLedger {
  if (!Number.isSafeInteger(options.maxRawBytesPerExecution) || options.maxRawBytesPerExecution < 0) {
    throw new RangeError("maxRawBytesPerExecution must be a non-negative safe integer");
  }
  mkdirSync(dirname(options.databasePath), { recursive: true });
  mkdirSync(options.blobDirectory, { recursive: true });
  const database = new Database(options.databasePath);
  let closed = false;

  try {
    const versionRow = database.prepare("SELECT sqlite_version() AS version").get() as { version: string };
    if (!sqliteVersionSupported(versionRow.version)) {
      throw new Error(`SQLite ${versionRow.version} is unsupported; >=3.51.3 is required`);
    }
    database.pragma("journal_mode = WAL");
    database.pragma("synchronous = FULL");
    database.pragma("foreign_keys = ON");
    database.pragma("recursive_triggers = ON");
    database.pragma("busy_timeout = 1000");
    const initialized = database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='events'").get();
    if (initialized === undefined) {
      database.exec(readFileSync(new URL("./schema.sql", import.meta.url), "utf8"));
    }
  } catch (error) {
    database.close();
    throw error;
  }

  function assertOpen(): void {
    if (closed) throw new Error("ledger is closed");
  }

  function blobPath(hash: string): string { return join(options.blobDirectory, hash); }

  async function readBlob(hash: string): Promise<Uint8Array> {
    assertOpen();
    const row = database.prepare("SELECT byte_length, storage_key FROM blobs WHERE hash = ?").get(hash) as
      | { byte_length: number; storage_key: string } | undefined;
    if (row === undefined) throw new Error(`unknown blob: ${hash}`);
    let bytes: Uint8Array;
    try { bytes = new Uint8Array(readFileSync(join(options.blobDirectory, row.storage_key))); }
    catch { throw new Error(`missing blob: ${hash}`); }
    if (bytes.byteLength !== row.byte_length || sha256(bytes) !== hash) {
      throw new Error(`blob integrity check failed: ${hash}`);
    }
    return bytes;
  }

  function rowToEvent(row: EventRow): EventRecord {
    const hashes = database.prepare("SELECT blob_hash FROM event_blobs WHERE event_id = ? ORDER BY rowid").all(row.event_id)
      .map((item) => (item as { blob_hash: string }).blob_hash);
    return {
      event_id: row.event_id, seq: row.seq, schema_version: row.schema_version,
      project_id: row.project_id, session_id: row.session_id,
      correlation_id: row.correlation_id, parent_event_ids: [], kind: row.kind,
      source_timestamp: row.source_timestamp, ingested_at: row.ingested_at,
      payload: JSON.parse(row.payload_json) as Json, payload_hash: row.payload_hash,
      raw_blob_hashes: hashes, previous_event_hash: row.previous_event_hash,
      event_hash: row.event_hash, capture_status: row.capture_status,
    };
  }

  function getEvent(id: string): EventRecord | undefined {
    assertOpen();
    const row = database.prepare("SELECT * FROM events WHERE event_id = ?").get(id) as EventRow | undefined;
    return row === undefined ? undefined : rowToEvent(row);
  }

  const commitEvent = database.transaction((input: AppendEventInput, payloadJson: string, payloadHash: string): EventRecord => {
    const existing = database.prepare("SELECT * FROM events WHERE event_id = ?").get(input.eventId) as EventRow | undefined;
    if (existing !== undefined) {
      if (existing.payload_hash !== payloadHash) throw new Error(`conflicting duplicate event_id: ${input.eventId}`);
      return rowToEvent(existing);
    }
    for (const blob of input.blobs) {
      const stored = database.prepare("SELECT byte_length, storage_key FROM blobs WHERE hash = ?").get(blob.hash) as
        | { byte_length: number; storage_key: string } | undefined;
      if (stored === undefined || !existsSync(join(options.blobDirectory, stored.storage_key))) {
        throw new Error(`event references missing blob: ${blob.hash}`);
      }
    }
    const previous = database.prepare("SELECT event_hash FROM events ORDER BY seq DESC LIMIT 1").get() as { event_hash: string } | undefined;
    const previousHash = previous?.event_hash ?? null;
    const ingestedAt = new Date().toISOString();
    const captureStatus: EventRecord["capture_status"] = input.blobs.length === 0
      ? "not_applicable" : input.blobs.every((blob) => blob.complete) ? "complete" : "partial";
    const normalizedBlobs = input.blobs.map((blob) => ({
      hash: blob.hash,
      complete: blob.complete,
      stream: blob.stream ?? "payload",
    }));
    const eventHash = sha256(canonicalJson({
      event_id: input.eventId, schema_version: SCHEMA_VERSION, project_id: options.projectId,
      session_id: input.sessionId, correlation_id: input.correlationId, kind: input.kind,
      source_timestamp: input.sourceTimestamp, ingested_at: ingestedAt, payload_hash: payloadHash,
      blobs: normalizedBlobs,
      previous_event_hash: previousHash, capture_status: captureStatus,
    }));
    database.prepare(`INSERT INTO events
      (event_id,schema_version,project_id,session_id,correlation_id,kind,source_timestamp,ingested_at,payload_json,payload_hash,previous_event_hash,event_hash,capture_status)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      input.eventId, SCHEMA_VERSION, options.projectId, input.sessionId, input.correlationId,
      input.kind, input.sourceTimestamp, ingestedAt, payloadJson, payloadHash, previousHash, eventHash, captureStatus,
    );
    for (const blob of normalizedBlobs) {
      database.prepare("INSERT INTO event_blobs(event_id,blob_hash,stream_name) VALUES (?,?,?)")
        .run(input.eventId, blob.hash, blob.stream);
    }
    return rowToEvent(database.prepare("SELECT * FROM events WHERE event_id = ?").get(input.eventId) as EventRow);
  });

  const api: EventLedger = {
    append(input) {
      assertOpen();
      const payloadJson = canonicalJson(input.payload);
      return commitEvent(input, payloadJson, sha256(payloadJson));
    },
    transactionImmediate<T>(fn: (db: DatabaseHandle) => T): T {
      assertOpen();
      return database.transaction(() => fn(database)).immediate();
    },
    async archive(chunks) {
      assertOpen();
      const spool = join(options.blobDirectory, `.spool-${randomUUID()}`);
      const descriptor = openSync(spool, "wx", 0o600);
      const hash = createHash("sha256");
      let bytes = 0;
      let complete = true;
      let localWriteFailed = false;
      try {
        try {
          for await (const chunk of chunks) {
            if (!(chunk instanceof Uint8Array)) throw new InvalidArchiveChunkError("archive chunks must be Uint8Array");
            const remaining = options.maxRawBytesPerExecution - bytes;
            if (chunk.byteLength > remaining) {
              if (remaining > 0) {
                const accepted = chunk.subarray(0, remaining);
                try { writeAll(descriptor, accepted); } catch (error) { localWriteFailed = true; throw error; }
                hash.update(accepted); bytes += accepted.byteLength;
              }
              complete = false;
              break;
            }
            try { writeAll(descriptor, chunk); } catch (error) { localWriteFailed = true; throw error; }
            hash.update(chunk); bytes += chunk.byteLength;
          }
        } catch (error) {
          if (error instanceof InvalidArchiveChunkError || localWriteFailed) throw error;
          complete = false;
        }
        fsyncSync(descriptor);
      } catch (error) {
        closeSync(descriptor); rmSync(spool, { force: true }); throw error;
      }
      let descriptorClosed = false;
      let destination: string | undefined;
      try {
        closeSync(descriptor); descriptorClosed = true;
        const digest = hash.digest("hex");
        destination = blobPath(digest);
        if (existsSync(destination)) rmSync(spool);
        else renameSync(spool, destination);
        database.prepare("INSERT OR IGNORE INTO blobs(hash,byte_length,storage_key,created_at) VALUES (?,?,?,?)")
          .run(digest, bytes, digest, new Date().toISOString());
        return { hash: digest, bytes, complete };
      } catch (error) {
        if (!descriptorClosed) { try { closeSync(descriptor); } catch { /* preserve original failure */ } }
        rmSync(spool, { force: true });
        // A renamed CAS object is valid evidence even if indexing it fails. Leave
        // it as an orphan so a concurrent writer cannot lose a referenced blob.
        throw error;
      }
    },
    readBlob,
    async readFragment(handle: SourceHandle) {
      assertOpen();
      if (!Number.isSafeInteger(handle.byte_start) || !Number.isSafeInteger(handle.byte_end) ||
          handle.byte_start < 0 || handle.byte_end < handle.byte_start) throw new RangeError("invalid byte range");
      const reference = database.prepare("SELECT 1 FROM event_blobs WHERE event_id=? AND blob_hash=? AND stream_name=?")
        .get(handle.event_id, handle.blob_hash, handle.stream);
      if (reference === undefined) throw new Error("source handle is not backed by an event blob");
      const bytes = await readBlob(handle.blob_hash);
      if (handle.byte_end > bytes.byteLength) throw new RangeError("fragment exceeds blob length");
      return bytes.slice(handle.byte_start, handle.byte_end);
    },
    getEvent,
    scan(query) {
      assertOpen();
      if (!Number.isSafeInteger(query.limit) || query.limit < 0) throw new RangeError("limit must be a non-negative integer");
      const clauses: string[] = ["seq > ?"];
      const parameters: unknown[] = [query.afterSeq ?? 0];
      if (query.sessionId !== undefined) { clauses.push("session_id = ?"); parameters.push(query.sessionId); }
      if (query.kind !== undefined) { clauses.push("kind = ?"); parameters.push(query.kind); }
      parameters.push(query.limit);
      return database.prepare(`SELECT * FROM events WHERE ${clauses.join(" AND ")} ORDER BY seq LIMIT ?`)
        .all(...parameters).map((row) => rowToEvent(row as EventRow));
    },
    close() { if (!closed) { database.close(); closed = true; } },
  };
  registerRawByteLimit(api, options.maxRawBytesPerExecution);
  return api;
}

export type {
  AppendEventInput, BlobReceipt, BlobRef, DatabaseHandle, DatabaseStatement, EventLedger, EventRecord, Hash, Id,
  ISODate, Json, LedgerOptions, SourceHandle,
} from "./types.js";
