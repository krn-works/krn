import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { chmodSync, linkSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { createAdapters, type ExecutionRequest, type TypedDigest } from "./adapters/index.js";
import { canonical, createFailureGate } from "./guards/index.js";
import { openLedger, type EventLedger, type Json } from "./ledger/index.js";
import { scanAll } from "./ledger/scan.js";
import { createStateTwin, type MemoryRecord, type StateEpoch } from "./state/index.js";

export { createAdapters } from "./adapters/index.js";
export type * from "./adapters/types.js";
export { canonical, createFailureGate, fingerprint } from "./guards/index.js";
export type { EscapeProof, FailureGate, FailureRecord, PreflightResult } from "./guards/types.js";
export { openLedger } from "./ledger/index.js";
export type { EventLedger, EventRecord, BlobReceipt, BlobRef, SourceHandle, Id, Hash, ISODate, Json } from "./ledger/types.js";
export { computeStateEpoch, createStateTwin } from "./state/index.js";
export type { MemoryRecord, Predicate, StateEpoch, StateInput, StateTwin } from "./state/types.js";

export interface LedgerMiddlewareOptions {
  repositoryRoot: string;
  databasePath: string;
  blobDirectory: string;
  digestByteLimit: number;
  maxRawBytesPerExecution: number;
}

export type InterceptInput = Omit<ExecutionRequest, "sessionId" | "goalId" | "environment"> & {
  sessionId?: string;
  goalId?: string;
  environment?: Readonly<Record<string, string>>;
};

export interface EvidenceReceipt {
  proposal_id: string;
  guard_decision_id: string;
  execution_id: string;
  input_epoch: string;
  output_epoch: string;
  digest_hash: string;
  capture_completeness: boolean;
}

export type InterceptResult =
  | { decision: "BLOCK"; reason: string; previousFailureId: string | null; requiredEscapeProof: readonly string[] }
  | { decision: "UNKNOWN"; executionId: string | null }
  | { decision: "EXECUTED"; digest: TypedDigest; rawEventId: string; receipt: EvidenceReceipt };

function sha(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}
function environmentFingerprint(): string {
  return sha(canonical({ schema: "middleware-environment/v1", node: process.version, platform: process.platform, arch: process.arch }));
}
function signingKeyAt(path: string): string {
  mkdirSync(dirname(path), { recursive: true });
  const value = randomBytes(32).toString("hex");
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, value, { encoding: "utf8", flag: "wx", mode: 0o600 });
    chmodSync(temporary, 0o600);
    linkSync(temporary, path);
    return value;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    if (readFileSync(path, "utf8").trim().length === 0) throw new Error("harness key file is empty; remove it only after verifying no active writer");
    chmodSync(path, 0o600);
    const existing = readFileSync(path, "utf8").trim();
    if (!/^[0-9a-f]{64}$/i.test(existing)) throw new Error("harness key file is invalid");
    return existing;
  } finally {
    rmSync(temporary, { force: true });
  }
}
function normalize(input: InterceptInput): ExecutionRequest {
  return {
    requestId: input.requestId,
    sessionId: input.sessionId ?? "ledger-session",
    goalId: input.goalId ?? "ledger-goal",
    kind: input.kind,
    executable: input.executable,
    argv: [...input.argv],
    cwd: input.cwd,
    environment: { ...(input.environment ?? {}) },
    dependencyPaths: [...input.dependencyPaths],
    timeoutMs: input.timeoutMs,
  };
}
function digestHash(digest: TypedDigest): string { return sha(canonical(digest as unknown as Json)); }
function errorSignature(digest: TypedDigest): string | null {
  if (digest.kind === "git-diff") return null;
  if (digest.kind === "shell") {
    if (digest.exit_code === 0) return null;
    return sha(canonical({ exit_code: digest.exit_code, salient_errors: digest.salient_errors.map(item => item.signature) }));
  }
  if (digest.kind === "test-runner") {
    const failed = (digest.failed ?? 0) > 0 || digest.failed_tests.length > 0;
    if (digest.exit_code === 0 && !failed) return null;
    return sha(canonical({ failure_signatures: digest.failure_signatures }));
  }
  const hasErrors = (digest.error_count ?? 0) > 0;
  if (digest.exit_code === 0 && !hasErrors) return null;
  return sha(canonical({ codes: digest.diagnostics.filter(item => item.severity === "error").map(item => item.code) }));
}

export function createLedgerMiddleware(options: LedgerMiddlewareOptions) {
  if (!Number.isSafeInteger(options.digestByteLimit) || options.digestByteLimit <= 0) {
    throw new RangeError("digestByteLimit must be a positive safe integer");
  }
  const keyPath = `${options.databasePath}.harness-key`;
  const signingKey = signingKeyAt(keyPath);
  const ledger = openLedger({
    databasePath: options.databasePath,
    blobDirectory: options.blobDirectory,
    projectId: "ledger-middleware",
    maxRawBytesPerExecution: options.maxRawBytesPerExecution,
  });
  const gate = createFailureGate({ ledger, signingKey });
  let chain: Promise<void> = Promise.resolve();
  const executionCounts = new Map<string, number>();
  let closed = false;

  const state = createStateTwin({ ledger, sessionId: "ledger-session", correlationId: "ledger-goal" });

  function verifyAndConsumePermit(request: ExecutionRequest, permit: Parameters<ReturnType<typeof createAdapters>["execute"]>[1]): void {
    const expectedRequestHash = sha(canonical({
      tool: request.executable,
      normalizedArgs: { argv: request.argv, cwd: request.cwd, environment: request.environment },
      preconditionEpoch: permit.preconditionEpoch,
    } as unknown as Json));
    if (permit.requestHash !== expectedRequestHash) throw new Error("execution permit does not match request");
    const { signature, ...unsigned } = permit;
    const expected = createHmac("sha256", signingKey)
      .update(canonical({ schema: "execution-permit/v1", ...unsigned }), "utf8").digest();
    const actual = Buffer.from(signature, "hex");
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new Error("invalid execution permit signature");
    ledger.transactionImmediate(db => {
      const changed = db.prepare("UPDATE reservations SET status='started' WHERE id=? AND request_hash=? AND fencing_token=? AND status='reserved'")
        .run(permit.reservationId, permit.requestHash, permit.fencingToken);
      if (changed.changes !== 1) throw new Error("execution permit is unrecognized or already consumed");
      ledger.append({
        eventId: randomUUID(), sessionId: request.sessionId, correlationId: request.goalId,
        kind: "tool_started", sourceTimestamp: new Date().toISOString(),
        payload: { requestId: request.requestId, reservationId: permit.reservationId, requestHash: permit.requestHash }, blobs: [],
      });
    });
  }
  const adapters = createAdapters({ ledger, digestByteLimit: options.digestByteLimit, verifyAndConsumePermit });

  async function measure(): Promise<StateEpoch> {
    return state.computeStateEpoch({ repositoryRoot: options.repositoryRoot, environmentFingerprint: environmentFingerprint(), testAttestations: {} });
  }
  function equivalentKey(input: Omit<InterceptInput, "requestId"> & { requestId?: string }): string {
    return sha(canonical({ kind: input.kind, executable: input.executable, argv: input.argv, cwd: input.cwd, environment: input.environment ?? {}, dependencyPaths: input.dependencyPaths, timeoutMs: input.timeoutMs } as unknown as Json));
  }
  function guardDecisionId(requestId: string, reservationId?: string): string {
    const events = scanAll(ledger, "guard_decision");
    for (let i = events.length - 1; i >= 0; i -= 1) {
      const event = events[i]!;
      const payload = event.payload;
      if (payload === null || Array.isArray(payload) || typeof payload !== "object") continue;
      const record = payload as Readonly<Record<string, Json>>;
      if (record.requestId === requestId && (reservationId === undefined || record.reservationId === reservationId)) return event.event_id;
    }
    throw new Error("guard decision is not resolvable");
  }

  async function interceptUnlocked(input: InterceptInput): Promise<InterceptResult> {
    if (closed) throw new Error("middleware is closed");
    const request = normalize(input);
    const inputEpoch = await measure();
    const preconditionEpoch = await state.epochFor(request, inputEpoch);
    const preflight = gate.preflight({ request, preconditionEpoch });
    if (preflight.decision === "BLOCK") {
      return { decision: "BLOCK", reason: preflight.reason, previousFailureId: preflight.previousFailureId, requiredEscapeProof: preflight.requiredEscapeProof };
    }
    const guardId = guardDecisionId(request.requestId, preflight.permit.reservationId);
    const proposalId = randomUUID();
    ledger.append({
      eventId: proposalId, sessionId: request.sessionId, correlationId: request.goalId,
      kind: "tool_proposal", sourceTimestamp: new Date().toISOString(),
      payload: { request: request as unknown as Json, preconditionEpoch, reservationId: preflight.permit.reservationId }, blobs: [],
    });

    let result;
    try {
      result = await adapters.execute(request, preflight.permit);
    } catch (error) {
      ledger.transactionImmediate(db => {
        db.prepare("UPDATE reservations SET status='unknown' WHERE id=? AND status='started'").run(preflight.permit.reservationId);
        ledger.append({
          eventId: randomUUID(), sessionId: request.sessionId, correlationId: request.goalId,
          kind: "execution_unknown", sourceTimestamp: new Date().toISOString(),
          payload: { requestId: request.requestId, reservationId: preflight.permit.reservationId, actionKey: preflight.permit.requestHash, error: String(error) }, blobs: [],
        });
      });
      return { decision: "UNKNOWN", executionId: null };
    }

    ledger.transactionImmediate(db => {
      const changed = db.prepare("UPDATE reservations SET status='completed' WHERE id=? AND status='started'").run(preflight.permit.reservationId);
      if (changed.changes !== 1) throw new Error("reservation completion failed");
    });
    const outputEpoch = await measure();
    const signature = errorSignature(result.digest);
    if (signature !== null) {
      gate.recordFailure({ request, preconditionEpoch, sourceWorldEpoch: inputEpoch.epoch_id, errorSignature: signature, sourceEventIds: [result.rawEventId] });
    }
    const rawEvent = ledger.getEvent(result.rawEventId);
    if (rawEvent === undefined) throw new Error("raw receipt event is not resolvable");
    for (const hash of rawEvent.raw_blob_hashes) await ledger.readBlob(hash);
    const receipt: EvidenceReceipt = {
      proposal_id: proposalId,
      guard_decision_id: guardId,
      execution_id: result.rawEventId,
      input_epoch: inputEpoch.epoch_id,
      output_epoch: outputEpoch.epoch_id,
      digest_hash: digestHash(result.digest),
      capture_completeness: rawEvent.capture_status === "complete",
    };
    if (ledger.getEvent(receipt.proposal_id) === undefined || ledger.getEvent(receipt.guard_decision_id) === undefined) throw new Error("receipt components are not resolvable");
    const key = equivalentKey(request);
    executionCounts.set(key, (executionCounts.get(key) ?? 0) + 1);
    return { decision: "EXECUTED", digest: result.digest, rawEventId: result.rawEventId, receipt };
  }

  return {
    intercept(input: InterceptInput): Promise<InterceptResult> {
      const snapshot: InterceptInput = {
        ...input,
        argv: [...input.argv],
        environment: { ...(input.environment ?? {}) },
        dependencyPaths: [...input.dependencyPaths],
      };
      const run = chain.then(() => interceptUnlocked(snapshot));
      chain = run.then(() => undefined, () => undefined);
      return run;
    },
    computeStateEpoch: measure,
    fileMemoryFromEpoch(path: string, epoch: StateEpoch): MemoryRecord {
      if (!Object.hasOwn(epoch.touched_file_hashes, path)) throw new Error(`path is not measured in epoch: ${path}`);
      const expected = epoch.touched_file_hashes[path]!;
      const source = scanAll(ledger, "state_epoch").find(event => {
        const payload = event.payload;
        return payload !== null && !Array.isArray(payload) && typeof payload === "object" && (payload as Readonly<Record<string, Json>>).epoch_id === epoch.epoch_id;
      });
      if (source === undefined) throw new Error("state epoch event is not resolvable");
      return {
        id: randomUUID(), kind: "fact", claim: { key: `file:${path}`, value: expected, wording: `${path} hash is ${expected}` },
        scope: { project_id: "ledger-middleware", worktree_id: options.repositoryRoot, paths: [path] }, source_event_ids: [source.event_id],
        created_at: new Date().toISOString(), state_epoch: epoch.epoch_id, confidence: 1, validity: "active", retrieval_keys: [path], utility_score: null,
        dependency_predicates: [{ kind: "file_hash", key: path, expected }], supersedes: null, revalidated_at_epoch: epoch.epoch_id, utility_status: "unmeasured",
      };
    },
    revalidateMemory(memory: MemoryRecord, epoch: StateEpoch) { return state.revalidateMemory(memory, epoch); },
    async readRawStdout(rawEventId: string): Promise<Buffer> {
      const event = ledger.getEvent(rawEventId);
      if (event === undefined || event.raw_blob_hashes.length === 0) throw new Error("raw stdout is not resolvable");
      return Buffer.from(await ledger.readBlob(event.raw_blob_hashes[0]!));
    },
    executionCountForEquivalentRequest(input: Omit<InterceptInput, "requestId"> & { requestId?: string }): number { return executionCounts.get(equivalentKey(input)) ?? 0; },
    async close(): Promise<void> { await chain; if (!closed) { closed = true; ledger.close(); } },
  };
}
