import type { Job } from '../core/index.ts';
import type { SystemdScopeRegistration } from '../hosts/systemd-scope.ts';
import type {
  Contract,
  ReviewSubmission,
  SubmissionReceipt,
  SubmitForReviewOptions,
  VerdictEvidence,
} from '../ledger/index.ts';

export type { Contract } from '../ledger/index.ts';
export type Capsule = {
  readonly jobId: string;
  readonly issue: string;
  readonly contractRevision: string;
  readonly epoch: number;
  readonly base: string;
  readonly head: string;
  readonly branch: string;
  readonly worktree: string;
  readonly dirtyPaths?: readonly string[];
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
  readonly pendingCheckpoint?:
    | {
        readonly intent: string;
        readonly parent: string;
        readonly sha: string;
        readonly epoch: number;
      }
    | undefined;
};
export type RepoFacts = {
  readonly base: string;
  readonly head: string;
  readonly branch: string;
  readonly worktree: string;
  readonly dirtyPaths?: readonly string[];
};
export type SessionEnd = {
  readonly reasonKind: string;
  readonly dirtyPaths?: readonly string[];
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
export type SessionResult = SessionEnd & { readonly finalMessage?: string };
export type Session = { readonly id: string; wait(): Promise<SessionResult> };

export class AbortBeforeCheckpoint extends Error {
  constructor() {
    super('foreman aborted before checkpoint transaction entry');
  }
}
export type Outcome =
  | {
      readonly kind: 'verdict_pass';
      readonly state: 'in_review' | 'ready_for_review';
      readonly sha: string;
    }
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
  readonly signal?: AbortSignal;
  readonly budget: Budget;
  readonly ledger: {
    readonly submissionEnabled?: boolean;
    readContract(issue: string): Promise<Contract>;
    submitForReview(
      job: Job,
      contract: Contract,
      evidence: VerdictEvidence,
      recordedSha: string,
      options?: SubmitForReviewOptions,
    ): Promise<ReviewSubmission>;
  };
  readonly relay: {
    load(job: Job, contract: Contract): Promise<Capsule>;
    checkpoint(
      job: Job,
      sessionId: string,
      message: string,
      next: string,
      decision?: string,
      prepared?: {
        readonly intent: string;
        readonly parent: string;
        readonly sha: string;
        readonly expectedEpoch: number;
      },
    ): Promise<Capsule>;
    recordCommit(
      job: Job,
      sessionId: string,
      sha: string,
      message: string,
      expectedEpoch?: number,
    ): Promise<Capsule>;
    bindSession(
      job: Job,
      capsule: Capsule,
      sessionId: string,
    ): Promise<Cas<Capsule>>;
    releaseStartupLease(
      job: Job,
      bound: Capsule,
      sessionId: string,
    ): Promise<Cas<Capsule>>;
    isCurrent(job: Job, epoch: number, sessionId: string): Promise<boolean>;
    repoFacts(
      job: Job,
      checkpointBase?: string,
    ): RepoFacts | Promise<RepoFacts>;
    validate(capsule: Capsule, facts: RepoFacts): Validation;
    project(capsule: Capsule, facts: RepoFacts, contract: Contract): string;
    refreshCAS(
      capsule: Capsule,
      facts: RepoFacts,
      end: SessionEnd,
    ): Promise<Cas<Capsule>>;
    withFindingsCAS?(
      capsule: Capsule,
      findings: readonly string[],
    ): Promise<Cas<Capsule>>;
  };
  readonly trace: {
    intent(job: Job, epoch: number): Promise<string>;
    started(
      job: Job,
      intent: string,
      sessionId: string,
      pgid?: number,
      isolation?: 'pid_namespace' | 'systemd_scope',
      registration?: SystemdScopeRegistration,
    ): Promise<boolean>;
    checkpoint(
      job: Job,
      intent: string,
      sessionId: string,
      message: string,
      next: string,
      decision?: string,
    ): Promise<void>;
    checkpointRequest(
      job: Job,
      intent: string,
      sessionId: string,
    ): Promise<{
      readonly message: string;
      readonly next: string;
      readonly decision?: string;
    } | null>;
    commit(
      job: Job,
      intent: string,
      sessionId: string,
      sha: string,
      message: string,
    ): Promise<void>;
    hasCheckpoint(
      job: Job,
      intent: string,
      sessionId: string,
    ): Promise<boolean>;
    sessionEnd(job: Job, sessionId: string): Promise<SessionEnd | null>;
    sessionScopeRegistration?(
      job: Job,
      sessionId: string,
    ): Promise<SystemdScopeRegistration | null>;
    sessionLost?(
      job: Job,
      sessionId: string,
      dirtyPaths: readonly string[],
    ): Promise<void>;
    log(
      job: Job,
      intent: string,
      sessionId: string,
      event: 'session_ended',
      end: SessionEnd,
    ): Promise<void>;
    failure(job: Job, intent: string, error: unknown): Promise<void>;
    verdict?(
      job: Job,
      event: import('../verdict/index.ts').VerdictEvent,
    ): Promise<void>;
    hasVerdict?(job: Job, sha: string): Promise<boolean>;
    submitIntent?(
      job: Job,
      sha: string,
      contractRevision: string,
    ): Promise<boolean>;
    submittedFor?(job: Job, sha: string): Promise<SubmissionReceipt | null>;
    submitted?(job: Job, sha: string, receipt: SubmissionReceipt): void;
    stopped?(job: Job, signal: string): Promise<void>;
    paperclipUpdateStarted?(
      job: Job,
      sha: string,
      kind: 'review' | 'conflict_comment',
    ): void;
    readyForReview?(job: Job, sha: string): Promise<void>;
  };
  readonly hosts: {
    readonly codex: {
      start(input: {
        readonly cwd: string;
        readonly model: 'gpt-6-luna';
        readonly reasoningEffort?: 'low' | 'medium' | 'high';
        readonly prompt: string;
        readonly limits: Budget['session'];
        readonly checkpoint: {
          readonly cli: string;
          readonly job: string;
          readonly issue: string;
          readonly worktree: string;
          readonly repoRoot?: string;
          readonly intent: string;
        };
        readonly onStarted: (
          sessionId: string,
          pgid?: number,
          isolation?: 'pid_namespace' | 'systemd_scope',
          registration?: SystemdScopeRegistration,
        ) => Promise<boolean>;
        readonly onStartCancelled?: (sessionId: string) => Promise<void>;
      }): Promise<Session>;
    };
    cancelTree(sessionId: string): Promise<void>;
    sessionScopeActive?(
      jobId: string,
      sessionId: string,
      registration: SystemdScopeRegistration,
    ): boolean | null | Promise<boolean | null>;
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
