// The record `scripts/fast-check.ts` leaves for a clean tree that passed, and ship reads.
import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

/** Ignored per-worktree file holding the tree hash of the last fast PASS: the tree fast checked, which `HEAD^{tree}` equals once that content is committed. */
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

/**
 * The tree the worktree holds now: HEAD's index plus every tracked edit and untracked, unignored
 * file, written through a scratch index so the real one is untouched. Committing exactly this
 * content gives a commit whose `HEAD^{tree}` is this hash. Undefined outside a git worktree.
 */
export function checkedTree(root: string): string | undefined {
  const git = (args: string[], env?: NodeJS.ProcessEnv) =>
    spawnSync('git', args, {
      cwd: root,
      encoding: 'utf8',
      env: env ? { ...process.env, ...env } : process.env,
    });
  const index = git(['rev-parse', '--git-path', 'index']);
  if (index.status !== 0) return undefined;
  const scratch = mkdtempSync(join(tmpdir(), 'krn-fast-index-'));
  try {
    const own = resolve(root, index.stdout.trim());
    const copy = join(scratch, 'index');
    if (existsSync(own)) {
      copyFileSync(own, copy);
      // Git rehashes an entry whose mtime is not older than the index file (racy git); a copy
      // stamped now would pass a same-size edit made in the commit's tick as clean. Keep the
      // real index's time, floored to the second so no racy entry slips past.
      const seconds = Math.floor(statSync(own).mtimeMs / 1000);
      utimesSync(copy, seconds, seconds);
    }
    const env = { GIT_INDEX_FILE: copy };
    if (git(['add', '-A'], env).status !== 0) return undefined;
    const tree = git(['write-tree'], env);
    return tree.status === 0 ? tree.stdout.trim() || undefined : undefined;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}
