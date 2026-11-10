// Shared identity and outcomes stay independent of host, storage, and trace adapters. ADR 0001.
export type Job = {
  readonly id: string;
  readonly issue: string;
  readonly worktree: string;
  readonly repoRoot?: string;
  readonly checkpoint?: {
    readonly message: string;
    readonly next: string;
  };
};

export type Result<T, E> = { ok: true; value: T } | { ok: false; error: E };
