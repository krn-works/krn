import type { Job } from '../core/index.ts';

export type Contract = { readonly revision: string };
export type Capsule = {
  readonly jobId: string;
  readonly issue: string;
  readonly contractRevision: string;
  readonly epoch: number;
  readonly base: string;
  readonly head: string;
  readonly branch: string;
  readonly worktree: string;
  readonly nextAction: string;
  readonly lease: 'active' | 'checkpointed' | 'ended';
  readonly blockers: readonly string[];
  readonly decisions: readonly {
    readonly date: string;
    readonly source: string;
    readonly text: string;
  }[];
  readonly rejectedApproaches: readonly string[];
  readonly references: readonly string[];
  readonly sessionId?: string | undefined;
};
export type RepoFacts = {
  readonly base: string;
  readonly head: string;
  readonly branch: string;
  readonly worktree: string;
};
export type SessionEnd = {
  readonly reasonKind: string;
  readonly reasonSha256?: string;
  readonly reasonLength?: number;
  readonly claimsDone: boolean;
  readonly exitCode?: number | null;
  readonly signal?: NodeJS.Signals | null;
  readonly threadId?: string;
  readonly usage?: {
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly totalTokens: number;
  };
};
export type Session = { readonly id: string; wait(): Promise<SessionEnd> };
export type Outcome =
  | { readonly kind: 'review'; readonly head: string }
  | {
      readonly kind: 'stop';
      readonly state: 'human_decision';
      readonly reasons: readonly string[];
    };
export type Cas<T> =
  | { readonly applied: true; readonly value: T }
  | { readonly applied: false };
export type Validation =
  | { readonly ok: true }
  | { readonly ok: false; readonly reasons: readonly string[] };
export type Budget = {
  readonly maxResets: number;
  readonly maxRepairs: number;
  readonly session: { readonly timeoutMs: number };
};

export type Deps = {
  readonly budget: Budget;
  readonly ledger: { readContract(issue: string): Promise<Contract> };
  readonly relay: {
    load(job: Job, contract: Contract): Promise<Capsule>;
    checkpoint(
      job: Job,
      sessionId: string,
      next: string,
      decision?: string,
    ): Promise<Capsule>;
    bindSession(
      job: Job,
      capsule: Capsule,
      sessionId: string,
    ): Promise<Cas<Capsule>>;
    isCurrent(job: Job, epoch: number, sessionId: string): Promise<boolean>;
    repoFacts(job: Job): RepoFacts | Promise<RepoFacts>;
    validate(capsule: Capsule, facts: RepoFacts): Validation;
    project(capsule: Capsule, facts: RepoFacts): string;
    refreshCAS(
      capsule: Capsule,
      facts: RepoFacts,
      end: SessionEnd,
    ): Promise<Cas<Capsule>>;
  };
  readonly trace: {
    intent(job: Job, epoch: number): Promise<string>;
    started(
      job: Job,
      intent: string,
      sessionId: string,
      pgid?: number,
    ): Promise<boolean>;
    checkpoint(
      job: Job,
      intent: string,
      sessionId: string,
      next: string,
      decision?: string,
    ): Promise<void>;
    hasCheckpoint(
      job: Job,
      intent: string,
      sessionId: string,
    ): Promise<boolean>;
    sessionEnd(job: Job, sessionId: string): Promise<SessionEnd | null>;
    log(
      job: Job,
      intent: string,
      sessionId: string,
      event: 'session_ended',
      end: SessionEnd,
    ): Promise<void>;
    failure(job: Job, intent: string, error: unknown): Promise<void>;
  };
  readonly hosts: {
    readonly codex: {
      start(input: {
        readonly cwd: string;
        readonly model: 'gpt-6-luna';
        readonly prompt: string;
        readonly limits: Budget['session'];
        readonly checkpoint: {
          readonly cli: string;
          readonly job: string;
          readonly issue: string;
          readonly worktree: string;
          readonly intent: string;
        };
        readonly onStarted: (
          sessionId: string,
          pgid?: number,
        ) => Promise<boolean>;
      }): Promise<Session>;
    };
    cancelTree(sessionId: string): Promise<void>;
  };
  readonly stop: (
    job: Job,
    state: 'human_decision',
    reasons: readonly string[],
  ) => Outcome;
};

export function validBudget(d: Deps): boolean {
  return (
    [d.budget.maxResets, d.budget.maxRepairs].every(Number.isSafeInteger) &&
    d.budget.maxResets >= 0 &&
    d.budget.maxResets <= 3 &&
    d.budget.maxRepairs >= 0 &&
    d.budget.maxRepairs <= 2
  );
}
