import type { ExecutionPermit, ExecutionRequest } from "../adapters/types.js";
import type { EventLedger, Hash, Id, ISODate, Json } from "../ledger/types.js";
import type { Predicate, SourceIds } from "../state/types.js";

export interface EscapeProof {
  id: Id;
  failureId: Id;
  kind:
    | "state_change"
    | "args_change"
    | "precondition_change"
    | "new_evidence"
    | "authorized_recovery_hypothesis";
  evidenceEventIds: SourceIds;
  expiresAt: ISODate;
  signature: string;
}

export type PreflightResult =
  | { decision: "ALLOW"; permit: ExecutionPermit }
  | {
      decision: "BLOCK";
      reason: string;
      previousFailureId: Id | null;
      requiredEscapeProof: readonly string[];
    };

export interface FailureRecord {
  id: Id;
  tool: string;
  normalized_args_hash: Hash;
  state_epoch: Hash;
  error_signature: Hash;
  preconditions: readonly Predicate[];
  attempted_fix: string | null;
  escape_condition: readonly Predicate[];
  recurrence_count: number;
  source_event_ids: SourceIds;
  action_key: Hash;
  source_world_epoch: Hash;
  unchanged_retry_count: number;
  status: "active" | "escaped" | "superseded";
}

export interface FailureGate {
  preflight(input: {
    request: ExecutionRequest;
    preconditionEpoch: Hash;
    proof?: EscapeProof;
  }): PreflightResult;

  recordFailure(input: {
    request: ExecutionRequest;
    preconditionEpoch: Hash;
    sourceWorldEpoch: Hash;
    errorSignature: Hash;
    sourceEventIds: SourceIds;
  }): FailureRecord;
}

export interface FailureGateOptions {
  ledger: EventLedger;
  signingKey: string;
}

export type { ExecutionPermit, ExecutionRequest, EventLedger, Hash, Id, ISODate, Json, Predicate, SourceIds };
