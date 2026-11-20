// `krn prune [--days N] [--dry-run] [--root DIR]`: frees the disk agent work leaves in an adopted repository.
// Three classes, each measured before removal: merged lane worktrees under .krn/worktrees, scratch/ directories of
// finished runs under .krn/runs, and (only with --days) runs older than N days; retired lane manifests go after 7 days. The .krn layout (src/state/layout.ts)
// owns which run owners are kept forever; --days never overrides it, and a KEEP file keeps any run.
import {
  existsSync,
  lstatSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { flagValue } from '../cli-kit/flag-value.ts';
import { CliUsageError } from '../cli-kit/usage-error.ts';
import { expiredManifests, retireLane } from '../lane/manifest.ts';
import { contractBase } from '../repo/contract.ts';
import {
  removeFinishedLane,
  spawnGit,
  worktreeUsers,
} from '../repo/lane-removal.ts';
import { newest, RUN_CATEGORIES, size } from '../state/layout.ts';
import { mainCheckoutRoot } from '../task/claims.ts';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
/** A worktree added within this window may be a lane whose session has not committed yet. */
export const FRESH_WORKTREE_MS = 2 * HOUR;
/** A scratch/ directory untouched this long belongs to a finished run. */
export const SCRATCH_IDLE_MS = HOUR;

export interface PruneItem {
  path: string;
  bytes: number;
}
export interface KeptWorktree {
  path: string;
  reason: string;
}
export interface PrunePlan {
  worktrees: (PruneItem & { branch: string })[];
  kept: KeptWorktree[];
  scratch: PruneItem[];
  runs: PruneItem[];
}

export interface PruneOptions {
  base: string;
  days?: number;
  now?: number;
  users?: (path: string) => number[] | undefined;
}

// Git runs through the lane removal's runner, the owner of this concern's git calls.
function git(cwd: string, args: string[]) {
  const out = spawnGit(args, cwd);
  return { status: out.code, stdout: out.stdout };
}

interface Worktree {
  path: string;
  branch: string;
  locked: boolean;
}

function laneWorktrees(main: string): Worktree[] {
  const out = git(main, ['worktree', 'list', '--porcelain']);
  if (out.status !== 0) return [];
  const root = join(main, '.krn', 'worktrees') + sep;
  const found: Worktree[] = [];
  for (const block of out.stdout.split('\n\n')) {
    const lines = block.split('\n');
    const path = lines
      .find((l) => l.startsWith('worktree '))
      ?.slice('worktree '.length);
    if (path === undefined || !path.startsWith(root)) continue;
    const ref = lines.find((l) => l.startsWith('branch '));
    found.push({
      path,
      branch: ref?.slice('branch refs/heads/'.length) ?? '',
      locked: lines.some((l) => l === 'locked' || l.startsWith('locked ')),
    });
  }
  return found;
}

/** Branches named by a live task claim: their lane is still being worked even with no commit yet. */
function claimedBranches(main: string): Set<string> {
  const dir = join(main, '.krn', 'task-claims');
  const branches = new Set<string>();
  if (!existsSync(dir)) return branches;
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.json')) continue;
    try {
      const claim: unknown = JSON.parse(readFileSync(join(dir, name), 'utf8'));
      if (
        typeof claim === 'object' &&
        claim !== null &&
        'branch' in claim &&
        typeof claim.branch === 'string'
      )
        branches.add(claim.branch);
    } catch {
      /* A torn claim names no branch. */
    }
  }
  return branches;
}

/**
 * Merged means merging the worktree tip into origin/<base> changes nothing: it covers fast-forward and merge-commit
 * landings (the tip is an ancestor) and squash merges (the squashed content is already in the base tree). A base
 * that later changed the same lines conflicts or differs, so such a worktree is kept, never lost.
 */
function landedOn(path: string, base: string): boolean {
  const tree = git(path, ['rev-parse', `origin/${base}^{tree}`]);
  if (tree.status !== 0) return false;
  const merged = git(path, [
    'merge-tree',
    '--write-tree',
    `origin/${base}`,
    'HEAD',
  ]);
  return (
    merged.status === 0 &&
    merged.stdout.split('\n')[0]?.trim() === tree.stdout.trim()
  );
}

function worktreeAge(path: string, now: number): number {
  try {
    return now - statSync(join(path, '.git')).mtimeMs;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

function planWorktrees(main: string, opts: PruneOptions, plan: PrunePlan) {
  const now = opts.now ?? Date.now();
  const users = opts.users ?? worktreeUsers;
  const claimed = claimedBranches(main);
  for (const wt of laneWorktrees(main)) {
    const keep = (reason: string) => plan.kept.push({ path: wt.path, reason });
    if (wt.locked) keep('locked');
    else if (wt.branch === opts.base) keep('it holds the base branch');
    else if (claimed.has(wt.branch)) keep('a task claim names its branch');
    else if (worktreeAge(wt.path, now) < FRESH_WORKTREE_MS)
      keep('added in the last two hours');
    else if (!landedOn(wt.path, opts.base))
      keep(`not merged into origin/${opts.base}`);
    else {
      const status = git(wt.path, ['status', '--porcelain']);
      const dirty = status.stdout.split('\n').filter((l) => l !== '');
      const live = users(wt.path);
      if (status.status !== 0) keep('git status failed');
      else if (dirty.some((l) => !l.startsWith('??')))
        keep('it holds uncommitted changes');
      else if (dirty.length > 0)
        keep(`it holds ${dirty.length} untracked file(s)`);
      else if (live === undefined) keep('this host cannot list process cwds');
      else if (live.length > 0)
        keep(`process ${live.slice(0, 3).join(', ')} works inside it`);
      else
        plan.worktrees.push({
          path: wt.path,
          branch: wt.branch,
          bytes: size(wt.path),
        });
    }
  }
}

/** Every scratch/ directory under .krn/runs, at any depth; a scratch directory is not searched further. */
function scratchDirs(dir: string, found: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const path = join(dir, entry.name);
    if (entry.name === 'scratch') found.push(path);
    else scratchDirs(path, found);
  }
  return found;
}

function planScratch(runs: string, opts: PruneOptions, plan: PrunePlan) {
  const now = opts.now ?? Date.now();
  const users = opts.users ?? worktreeUsers;
  for (const path of scratchDirs(runs)) {
    if (existsSync(join(path, '..', 'KEEP'))) continue;
    if (now - newest(path, true) < SCRATCH_IDLE_MS) continue;
    // The run directory is its parent: a process working anywhere in the run means the run has not ended.
    const live = users(join(path, '..'));
    if (live === undefined || live.length > 0) continue;
    plan.scratch.push({ path, bytes: size(path) });
  }
}

function planRuns(runs: string, opts: PruneOptions, plan: PrunePlan) {
  if (opts.days === undefined) return;
  const now = opts.now ?? Date.now();
  const users = opts.users ?? worktreeUsers;
  for (const owner of readdirSync(runs, { withFileTypes: true })) {
    if (!owner.isDirectory()) continue;
    const ownerPath = join(runs, owner.name);
    const category = RUN_CATEGORIES.find((c) => c.match.test(owner.name));
    // The layout keeps handoffs, goals, research and measured runs forever; --days only tightens the rest.
    if (category?.retention === 'keep') continue;
    if (existsSync(join(ownerPath, 'KEEP'))) continue;
    for (const run of readdirSync(ownerPath, { withFileTypes: true })) {
      if (!run.isDirectory()) continue;
      const path = join(ownerPath, run.name);
      if (existsSync(join(path, 'KEEP'))) continue;
      if (now - newest(path, true) <= opts.days * DAY) continue;
      const live = users(path);
      if (live === undefined || live.length > 0) continue;
      plan.runs.push({ path, bytes: size(path) });
    }
  }
}

/** What prune would remove in the main checkout `main`; reads only. */
export function planPrune(main: string, opts: PruneOptions): PrunePlan {
  const plan: PrunePlan = { worktrees: [], kept: [], scratch: [], runs: [] };
  planWorktrees(main, opts, plan);
  const runs = join(main, '.krn', 'runs');
  if (existsSync(runs) && lstatSync(runs).isDirectory()) {
    planScratch(runs, opts, plan);
    // A run picked as old goes whole: its scratch is not counted twice.
    planRuns(runs, opts, plan);
    plan.scratch = plan.scratch.filter(
      (s) => !plan.runs.some((r) => s.path.startsWith(r.path + sep)),
    );
  }
  // Lane manifests: live ones are always kept, retired ones go a week after retirement (ADR 0029).
  for (const path of expiredManifests(main, opts.now))
    plan.runs.push({ path, bytes: size(path) });
  return plan;
}

/** Removes what the plan lists; a worktree goes through the lane removal, which re-checks dirt and live processes. */
export function applyPrune(
  main: string,
  plan: PrunePlan,
  users: (path: string) => number[] | undefined = worktreeUsers,
): PrunePlan {
  const done: PrunePlan = {
    worktrees: [],
    kept: [...plan.kept],
    scratch: [],
    runs: [],
  };
  for (const wt of plan.worktrees) {
    const removal = removeFinishedLane(main, wt.path, wt.branch, { users });
    if (removal.removed) {
      retireLane(main, wt.path, 'pruned: its lane was merged');
      done.worktrees.push(wt);
    } else done.kept.push({ path: wt.path, reason: removal.reason });
  }
  git(main, ['worktree', 'prune']);
  for (const item of [...plan.scratch, ...plan.runs]) {
    rmSync(item.path, { recursive: true, force: true });
  }
  done.scratch = plan.scratch;
  done.runs = plan.runs;
  return done;
}

const total = (items: PruneItem[]) => items.reduce((s, i) => s + i.bytes, 0);

function mb(bytes: number): string {
  return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
}

export function formatPrune(
  main: string,
  plan: PrunePlan,
  dryRun: boolean,
): string[] {
  const rel = (p: string) => relative(main, p) || p;
  const verb = dryRun ? 'would remove' : 'removed';
  const lines = [
    ...plan.worktrees.map(
      (w) => `prune: ${verb} worktree ${rel(w.path)} (${mb(w.bytes)})`,
    ),
    ...plan.kept.map((k) => `prune: kept worktree ${rel(k.path)}: ${k.reason}`),
    ...plan.scratch.map(
      (s) => `prune: ${verb} scratch ${rel(s.path)} (${mb(s.bytes)})`,
    ),
    ...plan.runs.map(
      (r) => `prune: ${verb} run ${rel(r.path)} (${mb(r.bytes)})`,
    ),
  ];
  const w = total(plan.worktrees);
  const s = total(plan.scratch);
  const r = total(plan.runs);
  lines.push(
    `verdict: prune ${dryRun ? 'would free' : 'freed'} ${w + s + r} bytes (worktrees ${plan.worktrees.length}/${w}, scratch ${plan.scratch.length}/${s}, runs ${plan.runs.length}/${r}); kept ${plan.kept.length} worktree(s)`,
  );
  return lines;
}

export async function pruneCommand(args: string[]): Promise<void> {
  let root = process.cwd();
  let days: number | undefined;
  let dryRun = false;
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (flag === '--root')
      root = resolve(
        flagValue(args, i++, () => new CliUsageError('--root needs DIR')),
      );
    else if (flag === '--days') {
      const value = Number(
        flagValue(args, i++, () => new CliUsageError('--days needs N')),
      );
      if (!Number.isFinite(value) || value < 0)
        throw new CliUsageError('--days needs a non-negative number');
      days = value;
    } else if (flag === '--dry-run') dryRun = true;
    else throw new CliUsageError(`krn prune: unknown flag ${flag}`);
  }
  const main = mainCheckoutRoot(root);
  const base = contractBase(main);
  // A stale origin/<base> only keeps more: a failed fetch is reported and prune goes on.
  const fetched = git(main, ['fetch', '-q', 'origin', base]);
  if (fetched.status !== 0)
    process.stderr.write(
      `prune: git fetch origin ${base} failed; judging merges against the local origin/${base}\n`,
    );
  const plan = planPrune(main, {
    base,
    ...(days === undefined ? {} : { days }),
  });
  const result = dryRun ? plan : applyPrune(main, plan);
  for (const line of formatPrune(main, result, dryRun))
    process.stdout.write(`${line}\n`);
}
