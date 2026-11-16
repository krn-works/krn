// The record `scripts/fast-check.ts` leaves for a clean tree that passed, and ship reads.
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** Ignored per-worktree file holding the `HEAD^{tree}` hash of the last clean fast PASS. */
export const fastPassPath = (root: string): string =>
  join(root, '.krn/tmp/fast-pass-tree');

/** Stores the PASS for `tree`; `undefined` clears it (a dirty tree or a failed run is no PASS). */
export function writeFastPass(root: string, tree: string | undefined): void {
  const file = fastPassPath(root);
  if (tree === undefined) {
    rmSync(file, { force: true });
    return;
  }
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${tree}\n`);
}

/** The recorded tree hash, or undefined when there is no record. */
export function readFastPass(root: string): string | undefined {
  try {
    return readFileSync(fastPassPath(root), 'utf8').trim() || undefined;
  } catch {
    return undefined;
  }
}
