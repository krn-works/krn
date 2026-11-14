import type { ExecutionRequest } from "../adapters/types.js";
import type { Hash, Id, ISODate, Json } from "../ledger/types.js";

export type { Hash, Id, ISODate, Json } from "../ledger/types.js";
export type SourceIds = readonly [Id, ...Id[]];

export interface Predicate {
  kind: "file_hash" | "environment_hash" | "git_head" | "test_fingerprint" | "evidence_exists";
  key: string;
  expected: string;
}

export interface StateInput {
  repositoryRoot: string;
  environmentFingerprint: Hash;
  testAttestations: Readonly<Record<string, Hash>>;
}

export interface StateEpoch {
  epoch_id: Hash;
  git_head: string | null;
  dirty_tree_hash: Hash;
  touched_file_hashes: Readonly<Record<string, Hash | "MISSING">>;
  test_result_hashes: Readonly<Record<string, Hash>>;
  environment_fingerprint: Hash;
  created_at: ISODate;
  manifest_hash: Hash;
  state_revision_id: Hash;
  completeness: "verified" | "unknown";
}

export interface MemoryRecord {
  id: Id;
  kind: "fact" | "decision" | "preference" | "convention" | "failure" | "procedure" | "open_question";
  claim: { key: string; value: Json; wording: string };
  scope: { project_id: Id; worktree_id: Id | null; paths: readonly string[] };
  source_event_ids: SourceIds;
  created_at: ISODate;
  state_epoch: Hash | null;
  confidence: number;
  validity: "candidate" | "active" | "stale" | "superseded" | "quarantined" | "tombstoned";
  retrieval_keys: readonly string[];
  utility_score: number | null;
  dependency_predicates: readonly Predicate[];
  supersedes: Id | null;
  revalidated_at_epoch: Hash | null;
  utility_status: "unmeasured" | "probation" | "promoted" | "rejected";
}

export interface StateTwin {
  computeStateEpoch(input: StateInput): Promise<StateEpoch>;
  epochFor(request: ExecutionRequest, world: StateEpoch): Promise<Hash>;
  revalidateMemory(memory: MemoryRecord, epoch: StateEpoch): Promise<"active" | "stale">;
}
