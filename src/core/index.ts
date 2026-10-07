// Shared identity and outcomes stay independent of host, storage, and trace adapters. ADR 0001.
export type Job = {
  readonly id: string;
  readonly issue: string;
  readonly worktree: string;
};

export type Result<T, E> = { ok: true; value: T } | { ok: false; error: E };

export class NotImplemented extends Error {
  constructor(step: string) {
    super(`Not implemented: ${step}`);
    this.name = 'NotImplemented';
  }
}
