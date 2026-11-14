import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import type { DatabaseHandle } from "../ledger/types.js";
import { scanAll } from "../ledger/scan.js";
import type {
  EscapeProof, FailureGate, FailureGateOptions, FailureRecord, Hash, Json,
  PreflightResult, ExecutionPermit, ExecutionRequest,
} from "./types.js";

const PROJECTION_SCHEMA = `
CREATE TABLE IF NOT EXISTS failures (
  id TEXT PRIMARY KEY,
  action_key TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  precondition_epoch TEXT NOT NULL,
  source_event_id TEXT NOT NULL REFERENCES events(event_id),
  record_json TEXT NOT NULL CHECK(json_valid(record_json))
);
CREATE INDEX IF NOT EXISTS failures_action_key ON failures(action_key);
CREATE TABLE IF NOT EXISTS reservations (
  id TEXT PRIMARY KEY,
  request_hash TEXT NOT NULL,
  worktree_id TEXT NOT NULL,
  fencing_token INTEGER NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('reserved','started','completed','unknown'))
);
CREATE TABLE IF NOT EXISTS consumed_escape_proofs (
  proof_id TEXT PRIMARY KEY,
  consumed_by_reservation TEXT NOT NULL REFERENCES reservations(id),
  event_id TEXT NOT NULL REFERENCES events(event_id)
);`;

const ESCAPE_KINDS = new Set<EscapeProof["kind"]>([
  "state_change",
  "args_change",
  "precondition_change",
  "new_evidence",
  "authorized_recovery_hypothesis",
]);

export function canonical(value: Json): string {
  if (value === null || typeof value !== "object") {
    if (typeof value === "number" && !Number.isFinite(value)) {
      throw new TypeError("Non-finite numbers are forbidden");
    }
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map(canonical).join(",")}]`;
  }

  const object = value as Readonly<Record<string, Json>>;
  return `{${Object.keys(object)
    .sort()
    .map(key => `${JSON.stringify(key)}:${canonical(object[key]!)}`)
    .join(",")}}`;
}

function hash(value: Json): Hash {
  return createHash("sha256")
    .update(canonical(value), "utf8")
    .digest("hex");
}

export function fingerprint(
  tool: string,
  normalizedArgs: Json,
  stateEpoch: Hash,
  errorSignature: Hash
): Hash {
  return hash({
    schema: "failure-fingerprint/v1",
    tool,
    normalizedArgs,
    stateEpoch,
    errorSignature
  });
}

function normalizedArgs(request: ExecutionRequest): Json {
  return {
    argv: request.argv,
    cwd: request.cwd,
    environment: request.environment,
  };
}

function actionKey(request: ExecutionRequest, preconditionEpoch: Hash): Hash {
  return hash({
    tool: request.executable,
    normalizedArgs: normalizedArgs(request),
    preconditionEpoch,
  });
}

function permitSignature(signingKey: string, permit: Omit<ExecutionPermit, "signature">): string {
  return createHmac("sha256", signingKey)
    .update(canonical({ schema: "execution-permit/v1", ...permit }), "utf8")
    .digest("hex");
}

function proofSignature(signingKey: string, proof: EscapeProof): string {
  return createHmac("sha256", signingKey)
    .update(canonical({
      schema: "escape-proof/v1",
      id: proof.id,
      failureId: proof.failureId,
      kind: proof.kind,
      evidenceEventIds: proof.evidenceEventIds,
      expiresAt: proof.expiresAt,
    }), "utf8")
    .digest("hex");
}

function signaturesEqual(actual: string, expected: string): boolean {
  if (!/^[0-9a-f]{64}$/i.test(actual)) return false;
  const left = Buffer.from(actual, "hex");
  const right = Buffer.from(expected, "hex");
  return left.length === right.length && timingSafeEqual(left, right);
}

function validateRequest(request: ExecutionRequest, preconditionEpoch: Hash): string | null {
  if (!request.requestId || !request.sessionId || !request.goalId || !request.executable || !request.cwd || !preconditionEpoch) {
    return "invalid request identity or precondition epoch";
  }
  if (!Array.isArray(request.argv) || !request.argv.every(value => typeof value === "string")) return "invalid argv";
  if (!Array.isArray(request.dependencyPaths) || !request.dependencyPaths.every(value => typeof value === "string")) return "invalid dependencyPaths";
  if (!Number.isSafeInteger(request.timeoutMs) || request.timeoutMs < 0 || request.timeoutMs > 2_147_483_647) return "invalid timeoutMs";
  for (const value of Object.values(request.environment)) if (typeof value !== "string") return "invalid environment";
  return null;
}

function parseFailure(row: unknown): FailureRecord {
  return JSON.parse((row as { record_json: string }).record_json) as FailureRecord;
}

function latestFailure(db: DatabaseHandle, key: Hash): FailureRecord | undefined {
  const row = db.prepare("SELECT record_json FROM failures WHERE action_key = ? ORDER BY rowid DESC LIMIT 1").get(key);
  return row === undefined ? undefined : parseFailure(row);
}

function proofRetryAlreadyUsed(ledger: FailureGateOptions["ledger"], failure: FailureRecord): boolean {
  if (failure.unchanged_retry_count >= 1) return true;
  for (const event of scanAll(ledger, "guard_decision")) {
    const payload = event.payload;
    if (payload === null || Array.isArray(payload) || typeof payload !== "object") continue;
    const record = payload as Readonly<Record<string, Json>>;
    if (record.decision === "ALLOW" && record.proofFailureId === failure.id) return true;
  }
  return false;
}

function hasUnknownExecution(ledger: FailureGateOptions["ledger"], key: Hash): boolean {
  for (const event of scanAll(ledger, "execution_unknown")) {
    const payload = event.payload;
    if (payload === null || Array.isArray(payload) || typeof payload !== "object") continue;
    if ((payload as Readonly<Record<string, Json>>).actionKey === key) return true;
  }
  return false;
}

export function createFailureGate(options: FailureGateOptions): FailureGate {
  if (!options.signingKey) throw new Error("signingKey is required");
  options.ledger.transactionImmediate(db => { db.exec(PROJECTION_SCHEMA); });

  function appendDecision(input: {
    request: ExecutionRequest;
    decision: "ALLOW" | "BLOCK";
    key: Hash;
    reason: string | null;
    previousFailureId: string | null;
    requiredEscapeProof: readonly string[];
    reservationId: string | null;
    fencingToken: number | null;
    proofFailureId: string | null;
  }): string {
    const eventId = randomUUID();
    options.ledger.append({
      eventId,
      sessionId: input.request.sessionId,
      correlationId: input.request.goalId,
      kind: "guard_decision",
      sourceTimestamp: new Date().toISOString(),
      payload: {
        decision: input.decision,
        requestId: input.request.requestId,
        tool: input.request.executable,
        normalizedArgs: normalizedArgs(input.request),
        actionKey: input.key,
        reason: input.reason,
        previousFailureId: input.previousFailureId,
        requiredEscapeProof: input.requiredEscapeProof,
        reservationId: input.reservationId,
        fencingToken: input.fencingToken,
        proofFailureId: input.proofFailureId,
      },
      blobs: [],
    });
    return eventId;
  }

  function block(input: {
    request: ExecutionRequest;
    key: Hash;
    reason: string;
    previousFailureId: string | null;
    requiredEscapeProof: readonly string[];
  }): PreflightResult {
    appendDecision({
      request: input.request,
      decision: "BLOCK",
      key: input.key,
      reason: input.reason,
      previousFailureId: input.previousFailureId,
      requiredEscapeProof: input.requiredEscapeProof,
      reservationId: null,
      fencingToken: null,
      proofFailureId: null,
    });
    return {
      decision: "BLOCK",
      reason: input.reason,
      previousFailureId: input.previousFailureId,
      requiredEscapeProof: input.requiredEscapeProof,
    };
  }

  function verifyProof(db: DatabaseHandle, proof: EscapeProof, failure: FailureRecord): string | null {
    if (proof.failureId !== failure.id) return "escape proof scope does not match active failure";
    if (!ESCAPE_KINDS.has(proof.kind)) return "escape proof kind is invalid";
    const expires = Date.parse(proof.expiresAt);
    if (!Number.isFinite(expires) || expires <= Date.now()) return "escape proof is expired";
    if (!signaturesEqual(proof.signature, proofSignature(options.signingKey, proof))) return "escape proof signature is invalid";
    if (db.prepare("SELECT 1 FROM consumed_escape_proofs WHERE proof_id = ?").get(proof.id) !== undefined) return "escape proof was already consumed";
    if (!Array.isArray(proof.evidenceEventIds) || proof.evidenceEventIds.length === 0) return "escape proof has no evidence";
    for (const eventId of proof.evidenceEventIds) if (options.ledger.getEvent(eventId) === undefined) return `escape proof evidence event does not exist: ${eventId}`;
    return null;
  }

  return {
    preflight(input): PreflightResult {
      return options.ledger.transactionImmediate(db => {
        const key = actionKey(input.request, input.preconditionEpoch);
        const invalid = validateRequest(input.request, input.preconditionEpoch);
        if (invalid !== null) return block({ request: input.request, key, reason: invalid, previousFailureId: null, requiredEscapeProof: [] });

        if (hasUnknownExecution(options.ledger, key)) {
          return block({
            request: input.request,
            key,
            reason: "previous execution outcome is UNKNOWN; reconciliation is required",
            previousFailureId: null,
            requiredEscapeProof: ["reconciliation"],
          });
        }

        const failure = latestFailure(db, key);
        if (failure !== undefined) {
          if (input.proof === undefined) {
            return block({
              request: input.request,
              key,
              reason: "equivalent failure exists for unchanged preconditions",
              previousFailureId: failure.id,
              requiredEscapeProof: ["state_change", "args_change", "precondition_change", "new_evidence", "authorized_recovery_hypothesis"],
            });
          }
          const proofError = verifyProof(db, input.proof, failure);
          if (proofError !== null) {
            return block({
              request: input.request,
              key,
              reason: proofError,
              previousFailureId: failure.id,
              requiredEscapeProof: ["valid_unconsumed_escape_proof"],
            });
          }
          if (proofRetryAlreadyUsed(options.ledger, failure)) {
            return block({
              request: input.request,
              key,
              reason: "authorized unchanged-preconditions retry already used for failure lineage",
              previousFailureId: failure.id,
              requiredEscapeProof: ["changed_preconditions"],
            });
          }
        } else if (input.proof !== undefined) {
          return block({ request: input.request, key, reason: "escape proof has no matching active failure", previousFailureId: null, requiredEscapeProof: [] });
        }

        const duplicate = db.prepare("SELECT id FROM reservations WHERE request_hash = ? AND status IN ('reserved','started') LIMIT 1").get(key) as { id: string } | undefined;
        if (duplicate !== undefined) {
          return block({
            request: input.request,
            key,
            reason: "equivalent request already has an active reservation",
            previousFailureId: failure?.id ?? null,
            requiredEscapeProof: ["reservation_release_or_reconciliation"],
          });
        }

        const tokenRow = db.prepare("SELECT COALESCE(MAX(fencing_token), 0) AS token FROM reservations").get() as { token: number };
        const reservationId = randomUUID();
        const fencingToken = tokenRow.token + 1;
        db.prepare("INSERT INTO reservations(id,request_hash,worktree_id,fencing_token,status) VALUES (?,?,?,?,?)")
          .run(reservationId, key, input.request.cwd, fencingToken, "reserved");

        const permitBase = {
          reservationId,
          requestHash: key,
          preconditionEpoch: input.preconditionEpoch,
          fencingToken,
        };
        const permit: ExecutionPermit = { ...permitBase, signature: permitSignature(options.signingKey, permitBase) };
        const allowEventId = randomUUID();

        if (input.proof !== undefined) {
          db.exec("PRAGMA defer_foreign_keys = ON");
          db.prepare("INSERT INTO consumed_escape_proofs(proof_id,consumed_by_reservation,event_id) VALUES (?,?,?)")
            .run(input.proof.id, reservationId, allowEventId);
        }

        options.ledger.append({
          eventId: allowEventId,
          sessionId: input.request.sessionId,
          correlationId: input.request.goalId,
          kind: "guard_decision",
          sourceTimestamp: new Date().toISOString(),
          payload: {
            decision: "ALLOW",
            requestId: input.request.requestId,
            tool: input.request.executable,
            normalizedArgs: normalizedArgs(input.request),
            actionKey: key,
            reason: null,
            previousFailureId: failure?.id ?? null,
            requiredEscapeProof: [],
            reservationId,
            fencingToken,
            proofFailureId: input.proof?.failureId ?? null,
          },
          blobs: [],
        });
        return { decision: "ALLOW", permit };
      });
    },

    recordFailure(input): FailureRecord {
      return options.ledger.transactionImmediate(db => {
        const key = actionKey(input.request, input.preconditionEpoch);
        const previous = latestFailure(db, key);
        const proofWasUsed = previous === undefined ? false : proofRetryAlreadyUsed(options.ledger, previous);
        db.prepare("UPDATE reservations SET status='completed' WHERE request_hash=? AND status IN ('reserved','started')")
          .run(key);
        const record: FailureRecord = {
          id: randomUUID(),
          tool: input.request.executable,
          normalized_args_hash: hash(normalizedArgs(input.request)),
          state_epoch: input.preconditionEpoch,
          error_signature: input.errorSignature,
          preconditions: [],
          attempted_fix: null,
          escape_condition: [],
          recurrence_count: (previous?.recurrence_count ?? 0) + 1,
          source_event_ids: input.sourceEventIds,
          action_key: key,
          source_world_epoch: input.sourceWorldEpoch,
          unchanged_retry_count: (previous?.unchanged_retry_count ?? 0) + (proofWasUsed ? 1 : 0),
          status: "active",
        };
        const failureEventId = randomUUID();
        options.ledger.append({
          eventId: failureEventId,
          sessionId: input.request.sessionId,
          correlationId: input.request.goalId,
          kind: "guard_decision",
          sourceTimestamp: new Date().toISOString(),
          payload: { recordType: "failure", failure: record as unknown as Json },
          blobs: [],
        });
        db.prepare("INSERT INTO failures(id,action_key,fingerprint,precondition_epoch,source_event_id,record_json) VALUES (?,?,?,?,?,?)")
          .run(
            record.id,
            record.action_key,
            fingerprint(record.tool, normalizedArgs(input.request), input.preconditionEpoch, input.errorSignature),
            input.preconditionEpoch,
            input.sourceEventIds[0],
            canonical(record as unknown as Json),
          );
        return record;
      });
    },
  };
}

export type {
  EscapeProof, FailureGate, FailureGateOptions, FailureRecord, PreflightResult,
} from "./types.js";
