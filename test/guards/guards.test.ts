import { createHash, createHmac } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openLedger, type EventLedger } from "../../src/ledger/index.js";
import { canonical, createFailureGate, fingerprint, type EscapeProof, type FailureGate } from "../../src/guards/index.js";
import type { ExecutionRequest } from "../../src/adapters/types.js";

const roots: string[] = [];
const signingKey = "harness-secret";
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function fixture(): { ledger: EventLedger; gate: FailureGate; databasePath: string; blobs: string } {
  const root = mkdtempSync(join(tmpdir(), "guards-test-"));
  roots.push(root);
  const databasePath = join(root, "ledger.sqlite");
  const blobs = join(root, "blobs");
  const ledger = openLedger({ databasePath, blobDirectory: blobs, projectId: "project", maxRawBytesPerExecution: 64 * 1024 * 1024 });
  return { ledger, gate: createFailureGate({ ledger, signingKey }), databasePath, blobs };
}

function request(overrides: Partial<ExecutionRequest> = {}): ExecutionRequest {
  return {
    requestId: "request-1",
    sessionId: "session",
    goalId: "goal",
    kind: "shell",
    executable: process.execPath,
    argv: ["-e", "process.exit(1)"],
    cwd: "/tmp/worktree",
    environment: { MODE: "test" },
    dependencyPaths: ["relevant.txt"],
    timeoutMs: 5000,
    ...overrides,
  };
}

function evidence(ledger: EventLedger, id: string): string {
  ledger.append({
    eventId: id,
    sessionId: "session",
    correlationId: "goal",
    kind: "tool_output",
    sourceTimestamp: "2026-09-07T20:00:00.000Z",
    payload: { id },
    blobs: [],
  });
  return id;
}

function failure(gate: FailureGate, ledger: EventLedger, req: ExecutionRequest, epoch = "epoch-1", signature = "error-1") {
  const source = evidence(ledger, `evidence-${Math.random()}`);
  return gate.recordFailure({
    request: req,
    preconditionEpoch: epoch,
    sourceWorldEpoch: "world-1",
    errorSignature: signature,
    sourceEventIds: [source],
  });
}

function signedProof(base: Omit<EscapeProof, "signature">): EscapeProof {
  const signature = createHmac("sha256", signingKey).update(canonical({
    schema: "escape-proof/v1",
    id: base.id,
    failureId: base.failureId,
    kind: base.kind,
    evidenceEventIds: base.evidenceEventIds,
    expiresAt: base.expiresAt,
  }), "utf8").digest("hex");
  return { ...base, signature };
}

function future(): string { return new Date(Date.now() + 60_000).toISOString(); }

describe("Failure Antibody Gate", () => {
  it("fingerprint is deterministic across object-key order", () => {
    expect(fingerprint("tool", { a: 1, b: { c: 2, d: 3 } }, "state", "error"))
      .toBe(fingerprint("tool", { b: { d: 3, c: 2 }, a: 1 }, "state", "error"));
  });

  it("preserves argv order in experiment identity", () => {
    const { ledger, gate } = fixture();
    const first = gate.preflight({ request: request({ argv: ["a", "b"] }), preconditionEpoch: "epoch" });
    const second = gate.preflight({ request: request({ requestId: "request-2", argv: ["b", "a"] }), preconditionEpoch: "epoch" });
    expect(first.decision).toBe("ALLOW");
    expect(second.decision).toBe("ALLOW");
    ledger.close();
  });

  it("rejects timeout values that Node would clamp", () => {
    const { ledger, gate } = fixture();
    const result = gate.preflight({ request: request({ timeoutMs: 2_147_483_648 }), preconditionEpoch: "epoch" });
    expect(result.decision).toBe("BLOCK");
    if (result.decision !== "BLOCK") throw new Error("expected BLOCK");
    expect(result.reason).toMatch(/timeoutMs/);
    ledger.close();
  });

  it("atomically records the first ALLOW reservation and guard_decision", () => {
    const { ledger, gate } = fixture();
    const result = gate.preflight({ request: request(), preconditionEpoch: "epoch-1" });
    expect(result.decision).toBe("ALLOW");
    if (result.decision !== "ALLOW") throw new Error("expected ALLOW");
    const reservation = ledger.transactionImmediate(db => db.prepare("SELECT id,fencing_token,status FROM reservations WHERE id=?").get(result.permit.reservationId)) as
      | { id: string; fencing_token: number; status: string } | undefined;
    expect(reservation).toMatchObject({ id: result.permit.reservationId, fencing_token: result.permit.fencingToken, status: "reserved" });
    const decisions = ledger.scan({ kind: "guard_decision", limit: 10 });
    expect(decisions).toHaveLength(1);
    expect(decisions[0]?.payload).toMatchObject({ decision: "ALLOW", reservationId: result.permit.reservationId });
    ledger.close();
  });

  it("blocks second and third equivalent attempts after a recorded failure", () => {
    const { ledger, gate } = fixture();
    const req = request();
    expect(gate.preflight({ request: req, preconditionEpoch: "epoch-1" }).decision).toBe("ALLOW");
    const recorded = failure(gate, ledger, req);
    const second = gate.preflight({ request: request({ requestId: "request-2" }), preconditionEpoch: "epoch-1" });
    const third = gate.preflight({ request: request({ requestId: "request-3" }), preconditionEpoch: "epoch-1" });
    expect(second).toMatchObject({ decision: "BLOCK", previousFailureId: recorded.id });
    expect(third).toMatchObject({ decision: "BLOCK", previousFailureId: recorded.id });
    ledger.close();
  });

  it("allows a new experiment after relevant preconditions change", () => {
    const { ledger, gate } = fixture(); const req = request();
    gate.preflight({ request: req, preconditionEpoch: "epoch-1" }); failure(gate, ledger, req, "epoch-1");
    expect(gate.preflight({ request: request({ requestId: "request-2" }), preconditionEpoch: "epoch-2" }).decision).toBe("ALLOW");
    ledger.close();
  });

  it("does not unblock when irrelevant world state changes but precondition epoch is unchanged", () => {
    const { ledger, gate } = fixture(); const req = request();
    gate.preflight({ request: req, preconditionEpoch: "epoch-relevant" }); failure(gate, ledger, req, "epoch-relevant");
    const result = gate.preflight({ request: request({ requestId: "request-after-unrelated-file" }), preconditionEpoch: "epoch-relevant" });
    expect(result.decision).toBe("BLOCK"); ledger.close();
  });

  it("allows one retry with a valid HMAC escape proof and rejects replay", () => {
    const { ledger, gate } = fixture(); const req = request();
    const first = gate.preflight({ request: req, preconditionEpoch: "epoch-1" });
    expect(first.decision).toBe("ALLOW");
    const recorded = failure(gate, ledger, req);
    const proofEvidence = evidence(ledger, "new-independent-evidence");
    const proof = signedProof({ id: "proof-1", failureId: recorded.id, kind: "new_evidence", evidenceEventIds: [proofEvidence], expiresAt: future() });
    const retry = gate.preflight({ request: request({ requestId: "request-retry" }), preconditionEpoch: "epoch-1", proof });
    expect(retry.decision).toBe("ALLOW");
    const replay = gate.preflight({ request: request({ requestId: "request-replay" }), preconditionEpoch: "epoch-1", proof });
    expect(replay).toMatchObject({ decision: "BLOCK", previousFailureId: recorded.id });
    expect(replay.decision === "BLOCK" ? replay.reason : "").toMatch(/consumed|retry already used/);
    ledger.close();
  });

  it("rejects invalid signature, expired proof, wrong failure scope, and missing evidence", () => {
    const { ledger, gate } = fixture(); const req = request();
    gate.preflight({ request: req, preconditionEpoch: "epoch-1" });
    const recorded = failure(gate, ledger, req);
    const source = evidence(ledger, "proof-source");
    const good = signedProof({ id: "proof-good", failureId: recorded.id, kind: "new_evidence", evidenceEventIds: [source], expiresAt: future() });
    const invalid = { ...good, id: "proof-invalid", signature: "00".repeat(32) };
    const expired = signedProof({ id: "proof-expired", failureId: recorded.id, kind: "new_evidence", evidenceEventIds: [source], expiresAt: "2020-01-01T00:00:00.000Z" });
    const wrongScope = signedProof({ id: "proof-scope", failureId: "other-failure", kind: "new_evidence", evidenceEventIds: [source], expiresAt: future() });
    const missing = signedProof({ id: "proof-missing", failureId: recorded.id, kind: "new_evidence", evidenceEventIds: ["missing-event"], expiresAt: future() });
    for (const proof of [invalid, expired, wrongScope, missing]) {
      expect(gate.preflight({ request: request({ requestId: `request-${proof.id}` }), preconditionEpoch: "epoch-1", proof }).decision).toBe("BLOCK");
    }
    ledger.close();
  });

  it("allows at most one authorized retry without changed preconditions in a lineage", () => {
    const { ledger, gate } = fixture(); const req = request();
    gate.preflight({ request: req, preconditionEpoch: "epoch-1" });
    const firstFailure = failure(gate, ledger, req);
    const source1 = evidence(ledger, "proof-source-1");
    const proof1 = signedProof({ id: "proof-1", failureId: firstFailure.id, kind: "authorized_recovery_hypothesis", evidenceEventIds: [source1], expiresAt: future() });
    expect(gate.preflight({ request: request({ requestId: "retry-1" }), preconditionEpoch: "epoch-1", proof: proof1 }).decision).toBe("ALLOW");
    const secondFailure = failure(gate, ledger, request({ requestId: "retry-1" }), "epoch-1", "error-2");
    const source2 = evidence(ledger, "proof-source-2");
    const proof2 = signedProof({ id: "proof-2", failureId: secondFailure.id, kind: "authorized_recovery_hypothesis", evidenceEventIds: [source2], expiresAt: future() });
    const secondRetry = gate.preflight({ request: request({ requestId: "retry-2" }), preconditionEpoch: "epoch-1", proof: proof2 });
    expect(secondRetry.decision).toBe("BLOCK");
    expect(secondRetry.decision === "BLOCK" ? secondRetry.reason : "").toMatch(/retry already used/);
    ledger.close();
  });

  it("serializes equivalent duplicate preflights so only one receives ALLOW", () => {
    const { ledger, gate } = fixture();
    const a = gate.preflight({ request: request({ requestId: "parallel-a" }), preconditionEpoch: "epoch" });
    const b = gate.preflight({ request: request({ requestId: "parallel-b" }), preconditionEpoch: "epoch" });
    expect([a.decision, b.decision].sort()).toEqual(["ALLOW", "BLOCK"]);
    ledger.close();
  });

  it("blocks retry after an UNKNOWN execution until reconciliation", () => {
    const { ledger, gate } = fixture(); const req = request();
    const first = gate.preflight({ request: req, preconditionEpoch: "epoch" });
    expect(first.decision).toBe("ALLOW");
    if (first.decision !== "ALLOW") throw new Error("expected ALLOW");
    ledger.append({
      eventId: "unknown-event", sessionId: "session", correlationId: "goal", kind: "execution_unknown",
      sourceTimestamp: "2026-09-07T20:00:00.000Z", payload: { actionKey: first.permit.requestHash }, blobs: [],
    });
    const retry = gate.preflight({ request: request({ requestId: "after-unknown" }), preconditionEpoch: "epoch" });
    expect(retry.decision).toBe("BLOCK");
    expect(retry.decision === "BLOCK" ? retry.reason : "").toMatch(/UNKNOWN|reconciliation/);
    ledger.close();
  });

  it("finds an UNKNOWN execution beyond the first real ledger page", () => {
    const { ledger, gate } = fixture(); const req = request({ requestId: "paged-unknown" });
    const first = gate.preflight({ request: req, preconditionEpoch: "epoch" });
    expect(first.decision).toBe("ALLOW"); if (first.decision !== "ALLOW") throw new Error("expected ALLOW");
    for (let index = 0; index < 1000; index += 1) {
      ledger.append({
        eventId: `unknown-${index}`, sessionId: "session", correlationId: "goal", kind: "execution_unknown",
        sourceTimestamp: "2026-09-07T20:00:00.000Z", payload: { actionKey: `other-${index}` }, blobs: [],
      });
    }
    ledger.append({
      eventId: "unknown-target", sessionId: "session", correlationId: "goal", kind: "execution_unknown",
      sourceTimestamp: "2026-09-07T20:00:00.000Z", payload: { actionKey: first.permit.requestHash }, blobs: [],
    });
    const retry = gate.preflight({ request: request({ requestId: "paged-retry" }), preconditionEpoch: "epoch" });
    expect(retry.decision).toBe("BLOCK");
    expect(retry.decision === "BLOCK" ? retry.reason : "").toMatch(/UNKNOWN|reconciliation/);
    ledger.close();
  });

  it.each(["flaky-test-signature", "network-error-signature"])("treats stored %s as a known failure rather than predicting a future error", signature => {
    const { ledger, gate } = fixture(); const req = request();
    gate.preflight({ request: req, preconditionEpoch: "epoch" });
    failure(gate, ledger, req, "epoch", createHash("sha256").update(signature).digest("hex"));
    expect(gate.preflight({ request: request({ requestId: `retry-${signature}` }), preconditionEpoch: "epoch" }).decision).toBe("BLOCK");
    ledger.close();
  });

  it("preserves active failure projection across gate restart", () => {
    const { ledger, gate, databasePath, blobs } = fixture(); const req = request();
    gate.preflight({ request: req, preconditionEpoch: "epoch" }); failure(gate, ledger, req, "epoch");
    ledger.close();
    const reopened = openLedger({ databasePath, blobDirectory: blobs, projectId: "project", maxRawBytesPerExecution: 64 * 1024 * 1024 });
    const restarted = createFailureGate({ ledger: reopened, signingKey });
    expect(restarted.preflight({ request: request({ requestId: "after-restart" }), preconditionEpoch: "epoch" }).decision).toBe("BLOCK");
    reopened.close();
  });

  it("forbids non-finite numbers in canonical JSON", () => {
    expect(() => canonical(Number.POSITIVE_INFINITY)).toThrow(/Non-finite/);
  });
});
