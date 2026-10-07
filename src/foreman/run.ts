// Dependencies for the bounded J1 loop; implementations stay with their modules. ADR 0001.
import type { Job } from '../core/index.ts';

type Contract = { readonly revision: string };
type Capsule = { readonly epoch: number; readonly head: string };
type RepoFacts = { readonly head: string; readonly fingerprint: string };
type SessionEnd = { readonly reason: string; readonly claimsDone: boolean };
type Session = { readonly id: string; wait(): Promise<SessionEnd> };
type Verdict =
  | { readonly kind: 'pass' }
  | { readonly kind: 'findings'; readonly findings: readonly string[] };
type Outcome =
  | { readonly kind: 'review'; readonly head: string }
  | { readonly kind: 'stop'; readonly reasons: readonly string[] };
type Cas<T> =
  | { readonly applied: true; readonly value: T }
  | { readonly applied: false };
type Validation =
  | { readonly ok: true }
  | { readonly ok: false; readonly reasons: readonly string[] };
type Budget = {
  readonly maxResets: number;
  readonly maxRepairs: number;
  readonly session: { readonly timeoutMs: number };
};

export type Deps = {
  readonly budget: Budget;
  readonly ledger: {
    readContract(issue: string): Promise<Contract>;
    submitForReviewCAS(
      job: Job,
      verdict: Extract<Verdict, { kind: 'pass' }>,
    ): Promise<Outcome>;
  };
  readonly relay: {
    load(job: Job, contract: Contract): Promise<Capsule>;
    repoFacts(job: Job): Promise<RepoFacts>;
    validate(capsule: Capsule, facts: RepoFacts): Validation;
    project(capsule: Capsule, facts: RepoFacts): string;
    isCurrent(job: Job, epoch: number, sessionId: string): Promise<boolean>;
    refreshCAS(
      capsule: Capsule,
      facts: RepoFacts,
      end: SessionEnd,
    ): Promise<Cas<Capsule>>;
    withFindingsCAS(
      capsule: Capsule,
      findings: readonly string[],
    ): Promise<Cas<Capsule>>;
  };
  readonly trace: {
    intent(job: Job, epoch: number): Promise<string>;
    started(intent: string, sessionId: string): Promise<boolean>;
    log(job: Job, event: 'session_ended', end: SessionEnd): Promise<void>;
    failure(intent: string, error: unknown): Promise<void>;
  };
  readonly hosts: {
    readonly codex: {
      start(input: {
        readonly cwd: string;
        readonly model: 'gpt-6-luna';
        readonly prompt: string;
        readonly limits: Budget['session'];
      }): Promise<Session>;
    };
    cancelTree(sessionId: string): Promise<void>;
  };
  readonly verdict: {
    judge(job: Job, contract: Contract, head: string): Promise<Verdict>;
  };
  readonly stop: (
    job: Job,
    state: 'human_decision',
    reasons: readonly string[],
  ) => Outcome;
};
