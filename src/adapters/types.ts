import type { BlobReceipt, EventLedger, Hash, Id, SourceHandle } from "../ledger/index.js";

export type AdapterKind = "shell" | "test-runner" | "compiler" | "git-diff";

export interface ExecutionRequest {
  requestId: Id;
  sessionId: Id;
  goalId: Id;
  kind: AdapterKind;
  executable: string;
  argv: readonly string[];
  cwd: string;
  environment: Readonly<Record<string, string>>;
  dependencyPaths: readonly string[];
  timeoutMs: number;
}

export interface ExecutionPermit {
  reservationId: Id;
  requestHash: Hash;
  preconditionEpoch: Hash;
  fencingToken: number;
  signature: string;
}

export interface DigestMeta {
  adapter_version: string;
  raw_event_id: Id;
  receipt_id: Id;
  capture_complete: boolean;
  parser_status: "recognized" | "partial" | "unknown";
  omitted_count: number;
  truncated: boolean;
  unknown_fragment: { excerpt: string; source: SourceHandle } | null;
}

export interface ShellDigest extends DigestMeta {
  kind: "shell";
  command: string;
  normalized_args_hash: Hash;
  exit_code: number | null;
  termination_signal: string | null;
  duration_ms: number;
  stdout_bytes: number;
  stderr_bytes: number;
  salient_errors: readonly { signature: Hash; code: string | null; excerpt: string; source: SourceHandle }[];
  warning_signatures: readonly Hash[];
  changed_artifacts: readonly { path: string; before: Hash | "MISSING"; after: Hash | "MISSING" }[];
}

export interface TestRunnerDigest extends DigestMeta {
  kind: "test-runner";
  framework: string;
  command: string;
  exit_code: number | null;
  total: number | null;
  passed: number | null;
  failed: number | null;
  skipped: number | null;
  failed_tests: readonly { test_id: string; file: string; name: string; signature: Hash; source: SourceHandle }[];
  failure_signatures: readonly Hash[];
  duration_ms: number;
  tested_epoch: Hash;
  test_fingerprint: Hash;
}

export interface CompilerDigest extends DigestMeta {
  kind: "compiler";
  compiler: string;
  command: string;
  exit_code: number | null;
  error_count: number | null;
  warning_count: number | null;
  diagnostics: readonly { severity: "error" | "warning" | "note"; code: string | null; file: string | null; line: number | null; column: number | null; message: string; source: SourceHandle }[];
  affected_files: readonly string[];
  compiled_epoch: Hash;
}

export interface GitDiffDigest extends DigestMeta {
  kind: "git-diff";
  base: string;
  head: string;
  files_changed: number;
  additions: number;
  deletions: number;
  file_summaries: readonly { path: string; old_path: string | null; status: "A" | "M" | "D" | "R" | "C" | "T"; additions: number | null; deletions: number | null; patch_source: SourceHandle }[];
  binary_files: readonly string[];
}

export type TypedDigest = ShellDigest | TestRunnerDigest | CompilerDigest | GitDiffDigest;
export interface AcquisitionResult { digest: TypedDigest; rawEventId: Id; rawBlobs: readonly BlobReceipt[]; }
export interface AcquisitionAdapters { execute(request: ExecutionRequest, permit: ExecutionPermit): Promise<AcquisitionResult>; }
export interface AdapterOptions { ledger: EventLedger; digestByteLimit: number; verifyAndConsumePermit: (request: ExecutionRequest, permit: ExecutionPermit) => void; }

export interface CapturedProcess {
  request: ExecutionRequest;
  exitCode: number | null;
  signal: string | null;
  durationMs: number;
  stdout: Uint8Array;
  stderr: Uint8Array;
  rawEventId: Id;
  stdoutReceipt: BlobReceipt;
  stderrReceipt: BlobReceipt;
}
