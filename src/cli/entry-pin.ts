// Product entry pin: which commit the host's `krn task` entry runs, and
// whether it matches origin/main. The forwarded entry fails closed when stale.
import { spawnSync } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, sep } from 'node:path';

/** Exit status when the forwarded entry runs a stale or unpinned build. */
export const staleEntryExit = 78;

const releaseSuffix = `${sep}.krn${sep}product-release`;

export interface EntryPin {
  /** Product checkout the entry runs from. */
  root: string;
  /** HEAD commit of that checkout, or null when unreadable. */
  entryCommit: string | null;
  /** Local `origin/main` commit of that checkout, or null when absent. */
  releaseCommit: string | null;
  /** True when the checkout is the detached `.krn/product-release` worktree. */
  pinned: boolean;
}

function revParse(root: string, ref: string): string | null {
  const result = spawnSync(
    'git',
    ['-C', root, 'rev-parse', '--verify', '--quiet', `${ref}^{commit}`],
    { encoding: 'utf8' },
  );
  return result.status === 0 ? result.stdout.trim() : null;
}

/** Reads the entry pin of the Product checkout at `root` (no fetch). */
export function readEntryPin(root: string): EntryPin {
  return {
    root,
    entryCommit: revParse(root, 'HEAD'),
    releaseCommit: revParse(root, 'refs/remotes/origin/main'),
    pinned: root.endsWith(releaseSuffix),
  };
}

export function isFresh(pin: EntryPin): boolean {
  return (
    pin.pinned &&
    pin.entryCommit !== null &&
    pin.entryCommit === pin.releaseCommit
  );
}

/** Product checkout named by KRN_PRODUCT_ENTRY or ~/.config/krn/product-entry. */
export function configuredEntryRoot(
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  let entry = env.KRN_PRODUCT_ENTRY;
  if (entry === undefined) {
    const config = env.XDG_CONFIG_HOME || join(homedir(), '.config');
    try {
      entry = readFileSync(join(config, 'krn', 'product-entry'), 'utf8').split(
        /\r?\n/u,
        1,
      )[0];
    } catch {
      return null;
    }
  }
  entry = entry?.trim() ?? '';
  if (!isAbsolute(entry)) return null;
  try {
    return dirname(dirname(realpathSync(entry)));
  } catch {
    return null;
  }
}

function short(commit: string | null): string {
  return commit === null ? 'unknown' : commit.slice(0, 12);
}

/** Fail-closed message naming the entry commit, the release commit and the fix. */
export function staleEntryMessage(pin: EntryPin): string {
  const reason = pin.pinned
    ? `runs ${short(pin.entryCommit)}, origin/main is ${short(pin.releaseCommit)}`
    : `is not the pinned .krn/product-release checkout (runs ${short(pin.entryCommit)}, origin/main is ${short(pin.releaseCommit)})`;
  return [
    `krn: stale Product entry: ${pin.root} ${reason}.`,
    `Fix: ${join(pin.root, 'scripts', 'product-release.sh')} --entry > ~/.config/krn/product-entry`,
    'Then check which krn runs: which -a krn; bin/krn doctor',
    '',
  ].join('\n');
}

/** `krn doctor`: reports the configured entry and its commit; exit 78 when stale. */
export function doctorReport(root: string | null): {
  text: string;
  exitCode: number;
} {
  if (root === null)
    return {
      text: 'entry=unconfigured\nFix: scripts/product-release.sh --entry > ~/.config/krn/product-entry\n',
      exitCode: staleEntryExit,
    };
  const pin = readEntryPin(root);
  const fresh = isFresh(pin);
  const text = [
    `entry=${join(root, 'bin', 'krn')}`,
    `entry-commit=${pin.entryCommit ?? 'unknown'}`,
    `release-commit=${pin.releaseCommit ?? 'unknown'}`,
    `pinned=${pin.pinned ? 'yes' : 'no'}`,
    `status=${fresh ? 'fresh' : 'stale'}`,
    '',
  ].join('\n');
  return fresh
    ? { text, exitCode: 0 }
    : { text: text + staleEntryMessage(pin), exitCode: staleEntryExit };
}
