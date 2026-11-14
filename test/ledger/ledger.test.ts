import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, rmSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { afterEach, describe, expect, it } from "vitest";
import { openLedger, type AppendEventInput, type EventLedger } from "../../src/ledger/index.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function fixture(maxRawBytesPerExecution = 64 * 1024 * 1024): { ledger: EventLedger; root: string; databasePath: string; blobs: string } {
  const root = mkdtempSync(join(tmpdir(), "ledger-test-")); roots.push(root);
  const databasePath = join(root, "ledger.sqlite"); const blobs = join(root, "blobs");
  return { root, databasePath, blobs, ledger: openLedger({ databasePath, blobDirectory: blobs, projectId: "project", maxRawBytesPerExecution }) };
}
function input(eventId: string, payload: AppendEventInput["payload"] = { value: 1 }, blobs: AppendEventInput["blobs"] = []): AppendEventInput {
  return { eventId, sessionId: "session", correlationId: "correlation", kind: "tool_output", sourceTimestamp: "2026-01-02T03:04:05.000Z", payload, blobs };
}
async function chunks(...values: Uint8Array[]): Promise<AsyncIterable<Uint8Array>> {
  return (async function* () { yield* values; })();
}

describe("Event Ledger", () => {
  it("is append-only at the SQLite storage boundary for events and event blobs", async () => {
    const { ledger, databasePath } = fixture();
    const receipt = await ledger.archive(await chunks(new Uint8Array([1])));
    ledger.append(input("event", {}, [receipt])); ledger.close();
    const Sqlite = createRequire(import.meta.url)("better-sqlite3") as new(path: string) => { prepare(sql: string): { run(...args: unknown[]): unknown }; close(): void };
    const db = new Sqlite(databasePath);
    for (const sql of ["UPDATE events SET kind='recovery'", "DELETE FROM events", "UPDATE event_blobs SET stream_name='file'", "DELETE FROM event_blobs"]) {
      expect(() => db.prepare(sql).run()).toThrow(/append-only|immutable/);
    }
    db.close();
  });

  it("preserves events and capture status after reopen", async () => {
    const { ledger, databasePath, blobs } = fixture();
    const receipt = await ledger.archive(await chunks(new TextEncoder().encode("durable")));
    const before = ledger.append(input("durable", { nested: true }, [receipt])); ledger.close();
    const reopened = openLedger({ databasePath, blobDirectory: blobs, projectId: "project", maxRawBytesPerExecution: 64 * 1024 * 1024 });
    expect(reopened.getEvent("durable")).toEqual(before);
    expect(new TextDecoder().decode(await reopened.readBlob(receipt.hash))).toBe("durable"); reopened.close();
  });

  it("makes duplicate delivery idempotent, including canonically equivalent payload objects", () => {
    const { ledger, blobs } = fixture();
    const first = ledger.append(input("same", { a: 1, b: 2 }));
    const second = ledger.append(input("same", { b: 2, a: 1 }));
    expect(second).toEqual(first); expect(ledger.scan({ limit: 10 })).toHaveLength(1); ledger.close();
  });

  it("rejects a conflicting duplicate event ID without overwriting the first event", () => {
    const { ledger } = fixture(); ledger.append(input("conflict", { version: 1 }));
    expect(() => ledger.append(input("conflict", { version: 2 }))).toThrow(/conflicting duplicate/);
    expect(ledger.getEvent("conflict")?.payload).toEqual({ version: 1 }); ledger.close();
  });

  it("preserves raw byte integrity and SHA-256", async () => {
    const { ledger } = fixture(); const raw = new TextEncoder().encode("raw\r\nbytes\0");
    const receipt = await ledger.archive(await chunks(raw));
    expect(receipt).toEqual({ hash: createHash("sha256").update(raw).digest("hex"), bytes: raw.byteLength, complete: true });
    expect(await ledger.readBlob(receipt.hash)).toEqual(raw); ledger.close();
  });

  it("round-trips binary and invalid UTF-8 without text normalization", async () => {
    const { ledger } = fixture(); const raw = Uint8Array.from([0, 255, 254, 128, 13, 10, 0, 42]);
    const receipt = await ledger.archive(await chunks(raw.subarray(0, 3), raw.subarray(3)));
    ledger.append(input("binary", {}, [receipt]));
    expect(await ledger.readFragment({ event_id: "binary", blob_hash: receipt.hash, stream: "payload", byte_start: 1, byte_end: 7 })).toEqual(raw.slice(1, 7)); ledger.close();
  });

  it("addresses stdout and stderr independently through BlobRef.stream", async () => {
    const { ledger } = fixture();
    const out = new TextEncoder().encode("OUT"); const err = new TextEncoder().encode("ERR");
    const stdout = await ledger.archive(await chunks(out)); const stderr = await ledger.archive(await chunks(err));
    ledger.append(input("streams", {}, [
      { ...stdout, stream: "stdout" },
      { ...stderr, stream: "stderr" },
    ]));
    expect(await ledger.readFragment({ event_id: "streams", blob_hash: stdout.hash, stream: "stdout", byte_start: 0, byte_end: out.byteLength })).toEqual(out);
    expect(await ledger.readFragment({ event_id: "streams", blob_hash: stderr.hash, stream: "stderr", byte_start: 0, byte_end: err.byteLength })).toEqual(err);
    ledger.close();
  });

  it("rejects a SourceHandle stream that was not stored", async () => {
    const { ledger } = fixture(); const data = new TextEncoder().encode("payload");
    const receipt = await ledger.archive(await chunks(data)); ledger.append(input("wrong-stream", {}, [{ ...receipt, stream: "stdout" }]));
    await expect(ledger.readFragment({ event_id: "wrong-stream", blob_hash: receipt.hash, stream: "stderr", byte_start: 0, byte_end: data.byteLength })).rejects.toThrow(/not backed/);
    ledger.close();
  });

  it("defaults BlobRef.stream to payload", async () => {
    const { ledger } = fixture(); const data = new TextEncoder().encode("legacy");
    const receipt = await ledger.archive(await chunks(data)); ledger.append(input("legacy", {}, [receipt]));
    expect(await ledger.readFragment({ event_id: "legacy", blob_hash: receipt.hash, stream: "payload", byte_start: 0, byte_end: data.byteLength })).toEqual(data);
    ledger.close();
  });

  it("leaves a sealed pre-commit blob as a detectable orphan that can be referenced later", async () => {
    const { ledger, databasePath, blobs } = fixture();
    const receipt = await ledger.archive(await chunks(new TextEncoder().encode("sealed"))); ledger.close();
    const reopened = openLedger({ databasePath, blobDirectory: blobs, projectId: "project", maxRawBytesPerExecution: 64 * 1024 * 1024 });
    expect(reopened.scan({ limit: 10 })).toEqual([]); expect(await reopened.readBlob(receipt.hash)).toEqual(new TextEncoder().encode("sealed"));
    expect(reopened.append(input("recovered", {}, [receipt])).raw_blob_hashes).toEqual([receipt.hash]); reopened.close();
  });

  it("records interrupted streams as partial captures", async () => {
    const { ledger } = fixture();
    const interrupted = (async function* () { yield new TextEncoder().encode("ABC"); throw new Error("connection reset"); })();
    const receipt = await ledger.archive(interrupted);
    expect(receipt.complete).toBe(false); expect(new TextDecoder().decode(await ledger.readBlob(receipt.hash))).toBe("ABC");
    expect(ledger.append(input("partial", {}, [receipt])).capture_status).toBe("partial"); ledger.close();
  });

  it("rejects invalid archive chunks instead of publishing a partial receipt", async () => {
    const { ledger, blobs } = fixture();
    const invalid = (async function* () { yield "not-bytes" as unknown as Uint8Array; })();
    await expect(ledger.archive(invalid)).rejects.toThrow(/Uint8Array/);
    expect(ledger.scan({ limit: 10 })).toHaveLength(0);
    expect(readdirSync(blobs, { withFileTypes: true }).filter(entry => entry.name.startsWith(".spool-") || entry.isFile())).toHaveLength(0);
    ledger.close();
  });

  it("keeps completeness on events when complete and interrupted captures deduplicate to one CAS hash", async () => {
    const { ledger, databasePath, blobs } = fixture(); const abc = new TextEncoder().encode("ABC");
    const complete = await ledger.archive(await chunks(abc));
    const partial = await ledger.archive((async function* () { yield abc; throw new Error("interrupted"); })());
    expect(partial.hash).toBe(complete.hash);
    expect(ledger.append(input("complete", {}, [complete])).capture_status).toBe("complete");
    expect(ledger.append(input("partial", {}, [partial])).capture_status).toBe("partial"); ledger.close();
    const reopened = openLedger({ databasePath, blobDirectory: blobs, projectId: "project", maxRawBytesPerExecution: 64 * 1024 * 1024 });
    expect(reopened.getEvent("complete")?.capture_status).toBe("complete"); expect(reopened.getEvent("partial")?.capture_status).toBe("partial"); reopened.close();
  });

  it("aggregates empty, all-complete, and mixed blob lists", async () => {
    const { ledger } = fixture(); const one = await ledger.archive(await chunks(new Uint8Array([1])));
    const two = { ...(await ledger.archive(await chunks(new Uint8Array([2])))), complete: false };
    expect(ledger.append(input("none")).capture_status).toBe("not_applicable");
    expect(ledger.append(input("all", {}, [one])).capture_status).toBe("complete");
    expect(ledger.append(input("mixed", {}, [one, two])).capture_status).toBe("partial"); ledger.close();
  });

  it("fails closed when a referenced blob disappeared after backup restoration", async () => {
    const { ledger, blobs } = fixture(); const receipt = await ledger.archive(await chunks(new Uint8Array([7])));
    unlinkSync(join(blobs, receipt.hash));
    expect(() => ledger.append(input("missing", {}, [receipt]))).toThrow(/missing blob/);
    await expect(ledger.readBlob(receipt.hash)).rejects.toThrow(/missing blob/); ledger.close();
  });

  it("limits output beyond 64 MiB and seals the retained capture as incomplete", async () => {
    const { ledger } = fixture(); const block = new Uint8Array(1024 * 1024).fill(0x61);
    const output = (async function* () { for (let count = 0; count < 65; count += 1) yield block; })();
    const receipt = await ledger.archive(output);
    expect(receipt.bytes).toBe(64 * 1024 * 1024); expect(receipt.complete).toBe(false);
    expect(ledger.append(input("oversize", {}, [receipt])).capture_status).toBe("partial"); ledger.close();
  });

  it("raw SQLite max_page_count probe reports a full condition", () => {
    const { ledger, databasePath } = fixture(); ledger.close();
    const Sqlite = createRequire(import.meta.url)("better-sqlite3") as new(path: string) => { pragma(sql: string, options?: { simple: boolean }): unknown; prepare(sql: string): { run(...args: unknown[]): unknown }; close(): void };
    const db = new Sqlite(databasePath); db.pragma("journal_mode = DELETE");
    const pages = db.pragma("page_count", { simple: true }) as number; db.pragma(`max_page_count = ${pages}`);
    expect(() => db.prepare("INSERT INTO events(event_id,schema_version,project_id,session_id,correlation_id,kind,source_timestamp,ingested_at,payload_json,payload_hash,event_hash,capture_status) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)")
      .run("full", 1, "p", "s", "c", "tool_output", "t", "t", JSON.stringify({ data: "x".repeat(100_000) }), "h", "eh", "not_applicable")).toThrow(/full|disk/i);
    db.close();
  });
});
