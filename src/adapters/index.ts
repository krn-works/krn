import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import type { Readable } from "node:stream";
import type { BlobReceipt, EventLedger, Json } from "../ledger/index.js";
import { rawByteLimitFor } from "../ledger/internal.js";
import { compilerDigest } from "./compiler.js";
import { gitDiffDigest } from "./git-diff.js";
import { measureDependencies, shellDigest } from "./shell.js";
import { testRunnerDigest } from "./test-runner.js";
import type {
  AcquisitionAdapters, AcquisitionResult, AdapterOptions, CapturedProcess,
  ExecutionPermit, ExecutionRequest, TypedDigest,
} from "./types.js";

function boundedUnknown(process: CapturedProcess): { excerpt: string; source: { event_id: string; blob_hash: string; stream: "stdout" | "stderr" | "file"; byte_start: number; byte_end: number } } {
  const stdoutFirst = process.request.kind === "test-runner" || process.request.kind === "compiler" || process.request.kind === "git-diff";
  const useStderr = stdoutFirst ? process.stdoutReceipt.bytes === 0 && process.stderrReceipt.bytes > 0 : process.stderrReceipt.bytes > 0;
  const raw = useStderr ? process.stderr : process.stdout;
  const receipt = useStderr ? process.stderrReceipt : process.stdoutReceipt;
  const stream = useStderr ? "stderr" as const : process.request.kind === "git-diff" ? "file" as const : "stdout" as const;
  const length = Math.min(receipt.bytes, 512);
  return {
    excerpt: Buffer.from(raw).subarray(0, length).toString("utf8"),
    source: { event_id: process.rawEventId, blob_hash: receipt.hash, stream, byte_start: 0, byte_end: length },
  };
}

function truncateUtf8(value: string, maxBytes: number): string {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.byteLength <= maxBytes) return value;
  for (let end = Math.max(0, maxBytes); end > 0; end -= 1) {
    try { return new TextDecoder("utf8", { fatal: true }).decode(bytes.subarray(0, end)); }
    catch { /* back up to a complete UTF-8 sequence */ }
  }
  return "";
}

function boundDigestText(digest: TypedDigest, maxBytes: number): TypedDigest {
  const clip = (value: string): string => truncateUtf8(value, maxBytes);
  const unknown_fragment = digest.unknown_fragment === null ? null : {
    ...digest.unknown_fragment,
    excerpt: clip(digest.unknown_fragment.excerpt),
  };
  switch (digest.kind) {
    case "shell":
      return {
        ...digest,
        command: clip(digest.command),
        unknown_fragment,
        salient_errors: digest.salient_errors.map(item => ({ ...item, excerpt: clip(item.excerpt) })),
        changed_artifacts: digest.changed_artifacts.map(item => ({ ...item, path: clip(item.path) })),
      };
    case "test-runner":
      return {
        ...digest,
        command: clip(digest.command),
        unknown_fragment,
        failed_tests: digest.failed_tests.map(item => ({ ...item, file: clip(item.file), name: clip(item.name) })),
      };
    case "compiler":
      return {
        ...digest,
        compiler: clip(digest.compiler),
        command: clip(digest.command),
        unknown_fragment,
        diagnostics: digest.diagnostics.map(item => ({ ...item, file: item.file === null ? null : clip(item.file), message: clip(item.message) })),
        affected_files: digest.affected_files.map(clip),
      };
    case "git-diff":
      return {
        ...digest,
        base: clip(digest.base),
        head: clip(digest.head),
        unknown_fragment,
        file_summaries: digest.file_summaries.map(item => ({ ...item, path: clip(item.path), old_path: item.old_path === null ? null : clip(item.old_path) })),
        binary_files: digest.binary_files.map(clip),
      };
  }
}

function enforceDigestLimit(digest: TypedDigest, limit: number, process: CapturedProcess): TypedDigest {
  let current: TypedDigest = digest.parser_status === "unknown" && digest.unknown_fragment === null
    ? { ...digest, unknown_fragment: boundedUnknown(process) }
    : digest;
  if (Buffer.byteLength(JSON.stringify(current), "utf8") <= limit) return current;

  const unknown = current.unknown_fragment;
  if (unknown !== null) {
    const raw = unknown.source.stream === "stderr" ? process.stderr : process.stdout;
    const available = Math.max(0, Math.min(raw.byteLength - unknown.source.byte_start, unknown.source.byte_end - unknown.source.byte_start));
    const rawSlice = Buffer.from(raw).subarray(unknown.source.byte_start, unknown.source.byte_start + Math.min(128, available));
    const excerpt = rawSlice.toString("utf8");
    const shortened = {
      ...unknown,
      excerpt,
      source: { ...unknown.source, byte_end: unknown.source.byte_start + rawSlice.byteLength },
    };
    current = { ...current, unknown_fragment: shortened, truncated: true } as TypedDigest;
    if (Buffer.byteLength(JSON.stringify(current), "utf8") <= limit) return current;
  }

  if (current.kind === "shell") {
    const retainedErrors = current.salient_errors.slice(0, 1);
    const retainedWarnings = current.warning_signatures.slice(0, 2);
    const retainedArtifacts = current.changed_artifacts.slice(0, 1);
    const warningIds: string[] = [];
    let start = 0;
    const stderr = Buffer.from(process.stderr);
    for (let index = 0; index <= stderr.byteLength && warningIds.length < current.warning_signatures.length; index += 1) {
      if (index !== stderr.byteLength && stderr[index] !== 0x0a) continue;
      const end = index < stderr.byteLength ? index + 1 : index;
      const line = stderr.subarray(start, end).toString("utf8");
      if (/\bwarning\b/i.test(line)) warningIds.push(`stderr:${start}`);
      start = end;
    }
    const allIds = new Set([
      ...current.salient_errors.map(item => `${item.source.stream}:${item.source.byte_start}`),
      ...warningIds,
    ]);
    const retainedIds = new Set([
      ...retainedErrors.map(item => `${item.source.stream}:${item.source.byte_start}`),
      ...warningIds.slice(0, retainedWarnings.length),
    ]);
    const omitted = [...allIds].filter(id => !retainedIds.has(id)).length;
    current = { ...current, salient_errors: retainedErrors, warning_signatures: retainedWarnings, changed_artifacts: retainedArtifacts, truncated: true, omitted_count: current.omitted_count + omitted + Math.max(0, current.changed_artifacts.length - retainedArtifacts.length) };
  } else if (current.kind === "test-runner") {
    current = { ...current, failed_tests: current.failed_tests.slice(0, 1), failure_signatures: current.failure_signatures.slice(0, 1), truncated: true, omitted_count: current.omitted_count + Math.max(0, current.failed_tests.length - 1) };
  } else if (current.kind === "compiler") {
    const diagnostics = current.diagnostics.slice(0, 1);
    current = { ...current, diagnostics, affected_files: [...new Set(diagnostics.flatMap(item => item.file === null ? [] : [item.file]))], truncated: true, omitted_count: current.omitted_count + Math.max(0, current.diagnostics.length - 1) };
  } else {
    const file_summaries = current.file_summaries.slice(0, 1);
    const retainedPaths = new Set(file_summaries.flatMap(item => item.old_path === null ? [item.path] : [item.path, item.old_path]));
    current = { ...current, file_summaries, binary_files: current.binary_files.filter(path => retainedPaths.has(path)), truncated: true, omitted_count: current.omitted_count + Math.max(0, current.file_summaries.length - 1) };
  }

  for (const maxBytes of [512, 256, 128, 64, 32, 16, 8, 4, 2, 1, 0]) {
    const bounded = boundDigestText(current, maxBytes);
    if (Buffer.byteLength(JSON.stringify(bounded), "utf8") <= limit) return bounded;
  }
  throw new Error("digest exceeds configured byte limit");
}

class SharedRawBudget {
  private remaining: number;

  constructor(limit: number) { this.remaining = limit; }

  take(chunk: Uint8Array): { accepted: Uint8Array; overflow: boolean } {
    const acceptedLength = Math.min(this.remaining, chunk.byteLength);
    const accepted = chunk.subarray(0, acceptedLength);
    this.remaining -= acceptedLength;
    return { accepted, overflow: chunk.byteLength > acceptedLength };
  }
}

function liveChunks(stream: Readable, onConsumerStop: () => void, budget?: SharedRawBudget): AsyncIterable<Uint8Array> {
  return (async function* () {
    let ended = false;
    let errored = false;
    try {
      for await (const chunk of stream) {
        const bytes = new Uint8Array(Buffer.from(chunk));
        if (budget === undefined) {
          yield bytes;
          continue;
        }
        const { accepted, overflow } = budget.take(bytes);
        if (accepted.byteLength > 0) yield accepted;
        if (overflow) {
          onConsumerStop();
          throw new Error("raw execution limit exceeded");
        }
      }
      ended = true;
    } catch (error) {
      errored = true;
      throw error;
    } finally {
      // Stop the process while the child is still running when the shared
      // execution budget rejects a chunk. The ledger owns the bounded spool;
      // this wrapper only coordinates stdout and stderr against one budget.
      if (!ended && !errored) onConsumerStop();
    }
  })();
}

async function runAndCapture(request: ExecutionRequest, ledger: EventLedger): Promise<{
  exitCode: number | null;
  signal: string | null;
  durationMs: number;
  stdoutReceipt: BlobReceipt;
  stderrReceipt: BlobReceipt;
  stdout: Uint8Array;
  stderr: Uint8Array;
}> {
  const started = Date.now();
  const child = spawn(request.executable, [...request.argv], {
    cwd: request.cwd,
    env: { ...process.env, ...request.environment },
    shell: false,
    detached: process.platform !== "win32",
    stdio: ["ignore", "pipe", "pipe"],
  });
  let timedOut = false;
  let rawLimitExceeded = false;
  type CloseResult = { code: number | null; signal: NodeJS.Signals | null };
  let escalationTimer: NodeJS.Timeout | undefined;
  let reapTimer: NodeJS.Timeout | undefined;
  let timer: NodeJS.Timeout | undefined;
  let childClosed = false;
  const closePromise = new Promise<CloseResult>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => {
      childClosed = true;
      if (escalationTimer !== undefined) clearTimeout(escalationTimer);
      if (reapTimer !== undefined) clearTimeout(reapTimer);
      if (timer !== undefined) clearTimeout(timer);
      resolve({ code, signal });
    });
  });
  if (child.stdout === null || child.stderr === null) {
    try { await closePromise; }
    catch (error) { throw error; }
    throw new Error("process capture streams are unavailable");
  }
  let terminationRequested = false;
  let forceClose: () => void = () => undefined;
  const forcedClose = new Promise<CloseResult & { forced: true }>(resolve => {
    forceClose = () => resolve({ code: null, signal: null, forced: true });
  });
  const observedClose = Promise.race([
    closePromise.then(result => ({ ...result, forced: false as const })),
    forcedClose,
  ]);
  const sendSignal = (signal: NodeJS.Signals) => {
    if (child.pid === undefined) return;
    try {
      if (process.platform !== "win32") {
        // Narrow the PID/PGID-reuse window and let ESRCH mean the group is
        // already gone. The liveness check and signal are still best-effort.
        process.kill(-child.pid, 0);
        process.kill(-child.pid, signal);
      } else child.kill(signal);
    } catch {
      // The process may have exited between the liveness check and the signal.
    }
  };
  const groupAlive = () => {
    if (child.pid === undefined) return false;
    if (process.platform === "win32") return child.exitCode === null && child.signalCode === null;
    try { process.kill(-child.pid, 0); return true; }
    catch { return false; }
  };
  const terminateChild = () => {
    if (childClosed) return;
    // The direct child may have exited while a descendant still owns the
    // capture pipes. Signal the process group regardless of the leader state;
    // ESRCH is harmless when the whole group is already gone.
    if (!terminationRequested) {
      terminationRequested = true;
      sendSignal("SIGTERM");
    }
    if (escalationTimer === undefined) {
      escalationTimer = setTimeout(() => {
        sendSignal("SIGKILL");
        reapTimer = setTimeout(() => {
          child.stdout?.destroy();
          child.stderr?.destroy();
          forceClose();
        }, 1000);
      }, 1000);
    }
  };
  const stopForRawLimit = () => {
    if (rawLimitExceeded) return;
    rawLimitExceeded = true;
    terminateChild();
  };
  timer = setTimeout(() => {
    if (rawLimitExceeded || childClosed || !groupAlive()) return;
    timedOut = true;
    terminateChild();
  }, request.timeoutMs);

  const budgetLimit = rawByteLimitFor(ledger);
  const budget = budgetLimit === undefined ? undefined : new SharedRawBudget(budgetLimit);
  const stdoutPromise = ledger.archive(liveChunks(child.stdout, stopForRawLimit, budget));
  const stderrPromise = ledger.archive(liveChunks(child.stderr, stopForRawLimit, budget));

  try {
    const [{ code, signal, forced }, stdoutReceipt, stderrReceipt] = await Promise.all([
      observedClose,
      stdoutPromise,
      stderrPromise,
    ]);
    if (forced) throw new Error("process capture did not terminate before reap deadline");
    const [stdout, stderr] = await Promise.all([
      ledger.readBlob(stdoutReceipt.hash),
      ledger.readBlob(stderrReceipt.hash),
    ]);
    return {
      exitCode: code,
      signal: rawLimitExceeded ? "RAW_LIMIT_EXCEEDED" : timedOut ? "TIMEOUT" : signal,
      durationMs: Date.now() - started,
      stdoutReceipt,
      stderrReceipt,
      stdout,
      stderr,
    };
  } catch (error) {
    terminateChild();
    await Promise.allSettled([stdoutPromise, stderrPromise, observedClose]);
    throw error;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (escalationTimer !== undefined) clearTimeout(escalationTimer);
    if (reapTimer !== undefined) clearTimeout(reapTimer);
  }
}

export function createAdapters(options: AdapterOptions): AcquisitionAdapters {
  if (!Number.isSafeInteger(options.digestByteLimit) || options.digestByteLimit <= 0) {
    throw new RangeError("digestByteLimit must be a positive safe integer");
  }
  return {
    async execute(request: ExecutionRequest, permit: ExecutionPermit): Promise<AcquisitionResult> {
      const stableRequest: ExecutionRequest = {
        ...request,
        argv: [...request.argv],
        environment: { ...request.environment },
        dependencyPaths: [...request.dependencyPaths],
      };
      options.verifyAndConsumePermit(stableRequest, permit);
      const before = stableRequest.kind === "shell" ? await measureDependencies(stableRequest) : {};
      const result = await runAndCapture(stableRequest, options.ledger);
      const after = stableRequest.kind === "shell" ? await measureDependencies(stableRequest) : {};

      const rawEventId = randomUUID();
      const stdoutStream = stableRequest.kind === "git-diff" ? "file" as const : "stdout" as const;
      const payload: Json = {
        requestId: stableRequest.requestId,
        reservationId: permit.reservationId,
        adapterKind: stableRequest.kind,
        exit_code: result.exitCode,
        termination_signal: result.signal,
      };
      options.ledger.append({
        eventId: rawEventId,
        sessionId: stableRequest.sessionId,
        correlationId: stableRequest.goalId,
        kind: "tool_output",
        sourceTimestamp: new Date().toISOString(),
        payload,
        blobs: [
          { hash: result.stdoutReceipt.hash, complete: result.stdoutReceipt.complete, stream: stdoutStream },
          { hash: result.stderrReceipt.hash, complete: result.stderrReceipt.complete, stream: "stderr" },
        ],
      });

      const processCapture: CapturedProcess = {
        request: stableRequest,
        exitCode: result.exitCode,
        signal: result.signal,
        durationMs: result.durationMs,
        stdout: result.stdout,
        stderr: result.stderr,
        rawEventId,
        stdoutReceipt: result.stdoutReceipt,
        stderrReceipt: result.stderrReceipt,
      };
      let digest: TypedDigest;
      switch (stableRequest.kind) {
        case "shell": digest = shellDigest(processCapture, before, after); break;
        case "test-runner": digest = testRunnerDigest(processCapture); break;
        case "compiler": digest = compilerDigest(processCapture); break;
        case "git-diff": digest = gitDiffDigest(processCapture); break;
      }
      digest = enforceDigestLimit(digest, options.digestByteLimit, processCapture);
      if (options.ledger.getEvent(digest.receipt_id) === undefined) throw new Error("digest receipt is not resolvable");
      return { digest, rawEventId, rawBlobs: [result.stdoutReceipt, result.stderrReceipt] as readonly BlobReceipt[] };
    },
  };
}

export type {
  AcquisitionAdapters, AcquisitionResult, AdapterKind, CompilerDigest, DigestMeta,
  ExecutionPermit, ExecutionRequest, GitDiffDigest, ShellDigest, TestRunnerDigest,
  TypedDigest,
} from "./types.js";
