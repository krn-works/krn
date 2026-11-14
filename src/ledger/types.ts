export type Id = string;
export type Hash = string;
export type ISODate = string;

export type Json =
  | null | boolean | number | string
  | readonly Json[]
  | { readonly [key: string]: Json };

export interface SourceHandle {
  event_id: Id;
  blob_hash: Hash;
  stream: "stdout" | "stderr" | "file" | "payload";
  byte_start: number;
  byte_end: number;
}

export interface EventRecord {
  event_id: Id;
  seq: number;
  schema_version: number;
  project_id: Id;
  session_id: Id;
  correlation_id: Id;
  parent_event_ids: readonly Id[];
  kind: "user_message" | "assistant_decision" | "tool_proposal" |
    "guard_decision" | "tool_started" | "tool_output" |
    "file_observation" | "test_outcome" | "state_epoch" |
    "memory_write" | "compaction" | "recovery" | "contradiction" |
    "execution_unknown";
  source_timestamp: ISODate;
  ingested_at: ISODate;
  payload: Json;
  payload_hash: Hash;
  raw_blob_hashes: readonly Hash[];
  previous_event_hash: Hash | null;
  event_hash: Hash;
  capture_status: "complete" | "partial" | "not_applicable";
}

export interface DatabaseStatement {
  get(...parameters: unknown[]): unknown;
  all(...parameters: unknown[]): unknown[];
  run(...parameters: unknown[]): { changes: number; lastInsertRowid: number | bigint };
}

export interface DatabaseHandle {
  prepare(sql: string): DatabaseStatement;
  exec(sql: string): unknown;
}

export interface LedgerOptions {
  databasePath: string;
  blobDirectory: string;
  projectId: string;
  maxRawBytesPerExecution: number;
}
export interface BlobReceipt { hash: Hash; bytes: number; complete: boolean; }
export interface BlobRef {
  hash: Hash;
  complete: boolean;
  stream?: "stdout" | "stderr" | "file" | "payload"; // default: "payload"
}
export interface AppendEventInput {
  eventId: Id;
  sessionId: Id;
  correlationId: Id;
  kind: EventRecord["kind"];
  sourceTimestamp: ISODate;
  payload: Json;
  blobs: readonly BlobRef[];
}
export interface EventLedger {
  append(input: AppendEventInput): EventRecord;
  transactionImmediate<T>(fn: (db: DatabaseHandle) => T): T;
  archive(chunks: AsyncIterable<Uint8Array>): Promise<BlobReceipt>;
  readBlob(hash: Hash): Promise<Uint8Array>;
  readFragment(handle: SourceHandle): Promise<Uint8Array>;
  getEvent(id: Id): EventRecord | undefined;
  scan(query: { sessionId?: Id; kind?: EventRecord["kind"]; afterSeq?: number; limit: number }): readonly EventRecord[];
  close(): void;
}
