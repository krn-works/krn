import { spawnSync } from 'node:child_process';
import {
  existsSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
} from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { z } from 'zod';
import { recordBriefExposure } from '../brain/worker-packet.ts';
import { liveShipPid } from '../ci/ship-live.ts';
import { flagValue } from '../cli-kit/flag-value.ts';
import { CliUsageError } from '../cli-kit/usage-error.ts';
import {
  createManifest,
  newLaneId,
  readManifest,
  retireGoneLane,
  retireLane,
  transition,
} from '../lane/manifest.ts';
import {
  type Lane,
  readLane,
  readShipRecord,
  shipRecords,
} from '../lane/state.ts';
import {
  CEILING_WINDOW_PRS,
  collectWindow,
  nonDeliveryCeiling,
} from '../outcome/window.ts';
import { contractBase } from '../repo/contract.ts';
import {
  budgetShortfall,
  freeGb,
  envLimit as limit,
} from '../repo/disk-budget.ts';
import {
  type HostCapacity,
  hostGateDir,
  hostUnits,
  laneHostShortfall,
  laneLimits,
  sampleHost,
} from '../repo/host-gate.ts';
import { removeFinishedLane, worktreeUsers } from '../repo/lane-removal.ts';
import { laneMergeVerdict, type MergeVerdict } from '../repo/merge-verdict.ts';
import { gitLockError } from '../repo/shell-text.ts';
import { forgetShip, shipRecordDir } from '../repo/ship-record.ts';
import { slotHolders } from '../repo/slot-lock.ts';
import {
  assertClaimFree,
  claimTask,
  inspectClaim,
  mainCheckoutRoot,
  releaseClaim,
} from '../task/claims.ts';
import { taskFile } from '../task/paths.ts';
import { isTaskId } from '../task/record.ts';
import {
  type CarriedRecord,
  carryTaskRecord,
  dropCarriedCopy,
  holdTaskForLane,
  takePendingRecord,
} from '../task/storage.ts';
import { readTask, repositoryRoot } from '../task/store.ts';
import { gitWith } from './git-with.ts';
import { laneBrief } from './lane-brief.ts';
import { finishLane, laneFinishUsage } from './lane-finish.ts';
import { checkOpenRedLimit, type OpenPr } from './lane-open-red.ts';
import { outsideCredentialArgs } from './outside-git.ts';

export const laneUsage = [
  'krn lane start SLUG [--task ID] [--lane LANE_ID] [--actor NAME] [--reason TEXT] [--class delivery|non-delivery] [--root DIR]  fetch the repo contract base branch from origin, create branch SLUG from it in .krn/worktrees/SLUG, claim the task; a non-delivery lane is refused while `krn ledger --check-ceiling` is over; any lane is refused with exit 75 while host load per core reaches KRN_LANE_LOAD_PER_CORE (default 1.25), available memory is below KRN_LANE_MIN_MB (default 2048) or the host heavy-job gate is full; prints the path and branch',
  'krn lane run --ready --max N [--actor NAME] [--model MODEL] [--root DIR] [--window-hours N]  run `krn doctor --unattended` (the vault window is --window-hours, default 8; a failure stops before any claim), then deliver up to N ready tasks one after another with the single-task run, printing one `id slug exit=N Ns` line per task; stops when two consecutive runs end with the same non-zero exit\n  krn lane run (--task ID | --goal TEXT) [--slug SLUG] [--actor NAME] [--model MODEL] [--root DIR]  start the lane (or reuse its worktree and take its claim again after a failed run), run one headless claude session on the task record, ship the commit through `krn pr ship`; prints one verdict line, exit 0 only when merged; before the session the worktree links the node_modules of the main checkout when git ignores the link (or the nested worktree resolves it), else the krn.json `install` command runs in it, and a failed install exits 71 with the claim released and no session started; the session runs with `--max-budget-usd` (krn.json `laneBudgetUsd`, default 3), `--fallback-model` and `--setting-sources project`, and a session stopped at its cap exits 75, as does a start the host has no free capacity for; a session that ends unfinished after three identical Stop refusals with no edit between them exits 79 with a no-progress verdict naming the repeated refusal',
  'krn lane drop SLUG [--root DIR]  remove the lane worktree and branch and release the claim held from that worktree',
  laneFinishUsage,
  'krn lane status [--root DIR]  one line per lane worktree: `live` (its `krn pr ship` runs, pid alive), `merged` (its ship merged on the base), `orphaned` (committed past the base, no pull request and no live ship: run `krn pr ship` or `krn lane finish`), `pr-open` (a pull request exists, no live ship), `empty` (no commit past the base) or `unknown` (gh cannot say)',
  'krn lane brief [--file PATH] [--task ID [--slug SLUG] [--actor NAME]] [--as-of YYYY-MM-DD] [--root DIR]  with --task, reserve the lane (a `reserved` manifest) and print its `bin/krn lane start SLUG --task ID --lane LANE_ID --actor NAME` line first (slug defaults to the task id, actor to `lane`); print the lane brief (file, else stdin) behind the FR-40 brain packet of the repository records, followed by the in-force worker standards of .agents/standards.json (inherited ones marked)',
].join('\n');

function briefCommand(rest: string[]): void {
  let file: string | undefined;
  let task: string | undefined;
  let slug: string | undefined;
  let actor = 'lane';
  let asOf = new Date().toISOString().slice(0, 10);
  let root: string | undefined;
  const value = (index: number, name: string) =>
    flagValue(rest, index, () => new CliUsageError(`${name} requires a value`));
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index] as string;
    if (arg === '--file') file = value(index++, arg);
    else if (arg === '--task') task = value(index++, arg);
    else if (arg === '--slug') slug = value(index++, arg);
    else if (arg === '--actor') actor = value(index++, arg);
    else if (arg === '--as-of') asOf = value(index++, arg);
    else if (arg === '--root') root = value(index++, arg);
    else throw new CliUsageError(laneUsage);
  }
  if (task !== undefined && !isTaskId(task))
    throw new CliUsageError(`not a task id: ${task}`);
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(asOf))
    throw new CliUsageError(`--as-of must be YYYY-MM-DD: ${asOf}`);
  const brief = readFileSync(file ?? 0, 'utf8');
  if (brief.trim() === '')
    throw new CliUsageError(
      'lane brief is empty: pass --file PATH or pipe the brief text on stdin',
    );
  const repo = repositoryRoot(root ?? process.cwd());
  const built = laneBrief(repo, brief, asOf, task, task !== undefined);
  if (task === undefined) {
    process.stdout.write(built.text);
    return;
  }
  const main = mainCheckoutRoot(repo);
  const lane = slug ?? task;
  if (!/^[a-z0-9][a-z0-9._-]*$/u.test(lane))
    throw new CliUsageError(
      `lane slug must be lowercase letters, digits, ".", "_" or "-": ${lane}`,
    );
  recordBriefExposure(main, `brief-${Date.now()}`, task, built);
  // The lane id exists before the worker does: the worker's start command names it, which binds the worker to it.
  const reserved = createManifest(
    main,
    {
      laneId: newLaneId(lane),
      slug: lane,
      base: contractBase(repo),
      task,
      targets: laneTargets(repo, task),
      actor,
      createdAt: new Date().toISOString(),
      agents: [],
    },
    { kind: 'reserved' },
  );
  process.stdout.write(
    `Start: bin/krn lane start ${lane} --task ${task} --lane ${reserved.laneId} --actor ${actor}\n\n${built.text}`,
  );
}

// Host budget: refuse below KRN_LANE_MIN_FREE_GB free (default 5) on the
// repository or the lane temp dir, and at KRN_LANE_MAX_LIVE worktrees (default 6: raised from the 2026-11-16 usage cut of 4, t-ahsmyfp, by t-n1k2ccq;
// .krn/runs/lead/usage/report-before-v3.md). A failed `krn lane run` attempt keeps its worktree
// for the rerun but releases its claim: it holds no session and never fills the budget, so a
// drain of more tasks than the budget does not stop on its own leftovers.
/** The short-lived worktree `krn task publish` ships task records from: no agent session, so no lane. */
export const taskRecordsPrefix = 'task-records-';

export function checkLaneBudget(
  main: string,
  base?: string,
  slug?: string,
): void {
  const short = budgetShortfall([
    main,
    process.env.KRN_LANE_TMP ?? join(sep, 'mnt', 'storage', 'tmp'),
  ]);
  if (short)
    throw new CliUsageError(
      `lane budget: only ${short.free.toFixed(1)} GB free under ${short.dir} (minimum ${short.minFree} GB, KRN_LANE_MIN_FREE_GB); free disk before starting a lane`,
    );
  // Publishing task records holds no paid session: it is never refused by the live-lane count.
  if (slug?.startsWith(taskRecordsPrefix)) return;
  const maxLive = limit('KRN_LANE_MAX_LIVE', 6);
  const dir = join(main, '.krn', 'worktrees');
  // Only real worktrees count: a lane worktree holds a `.git` file; a test fixture or a
  // leftover directory under .krn/worktrees does not block a lane (t-tj1g7m9).
  // A lane that src/lane/state.ts reads as merged and that holds no uncommitted change is
  // finished: it may stay on disk while a session works inside it but never fills the budget.
  const live: { name: string; lane: Lane | undefined }[] = [];
  if (existsSync(dir))
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (!e.isDirectory() || !existsSync(join(dir, e.name, '.git'))) continue;
      if (e.name.startsWith(taskRecordsPrefix)) continue;
      const clean = (): boolean => {
        const status = gitRun(join(dir, e.name), ['status', '--porcelain']);
        return status.status === 0 && status.stdout.trim() === '';
      };
      const lane = base ? readLane(main, base, e.name) : undefined;
      if (lane?.verdict === 'merged' && clean()) continue;
      if (failedAttempt(main, e.name)) continue;
      live.push({ name: e.name, lane });
    }
  if (live.length >= maxLive)
    throw new CliUsageError(
      `lane budget: ${live.length} live lane worktrees in ${dir} (maximum ${maxLive}, KRN_LANE_MAX_LIVE); ship or remove a lane first; counted: ${live
        .map(({ name, lane }) => `${name} (${countedAs(main, name, lane)})`)
        .join(', ')}`,
    );
}

/**
 * A worktree a failed `krn lane run` attempt left for its rerun: named after an open task whose
 * claim was released and with no ship record. A running lane holds its claim, so it still counts.
 */
function failedAttempt(main: string, name: string): boolean {
  if (!isTaskId(name) || readShipRecord(main, name) !== undefined) return false;
  try {
    return (
      readTask(main, name)?.status === 'open' &&
      inspectClaim(main, name).state === 'none'
    );
  } catch {
    return false;
  }
}

/** Why the budget counted a lane: the lane state reader's verdict, in the budget's words. */
function countedAs(main: string, name: string, lane: Lane | undefined): string {
  const record = lane ? lane.record : readShipRecord(main, name);
  if (!record) return 'no ship record';
  if (lane?.verdict === 'merged') return 'merged, uncommitted changes';
  return 'shipped, not merged at this tip';
}

export { laneMergeVerdict, type MergeVerdict };

const git = gitWith((message) => new CliUsageError(message));

/** Block the thread for `ms` milliseconds; lane steps are synchronous child processes. */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Fetch the base branch, retried while a concurrent `krn lane start` of the same repository holds
 * refs/remotes/origin/<base>.lock: parallel lanes would otherwise fail with "cannot lock ref".
 */
export function fetchBase(
  main: string,
  base: string,
  attempts = 40,
  delayMs = 250,
): void {
  if (!gitOk(main, ['remote', 'get-url', 'origin']))
    throw new CliUsageError(
      `${main} has no git remote origin: lanes branch from origin/${base}, so add one (git remote add origin <url>) and push ${base} first`,
    );
  // An outside GitHub origin is fetched with its own App token: the default credential 404s there.
  const credential = outsideCredentialArgs(main);
  for (let attempt = 1; ; attempt += 1) {
    const result = spawnSync(
      'git',
      [...credential, '-C', main, 'fetch', '-q', 'origin', base],
      {
        encoding: 'utf8',
      },
    );
    if (result.status === 0) return;
    const said = (result.stderr || result.stdout).trim();
    if (attempt >= attempts || !gitLockError.test(said))
      throw new CliUsageError(`git fetch -q origin ${base} failed: ${said}`);
    sleepSync(delayMs);
  }
}

export function gitRun(cwd: string, args: string[]) {
  return spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
}

/**
 * A lane ends at the merge: `krn pr ship --drop` removes its worktree and branch unless a process still
 * works there; a lane agent's ship keeps them. The next lane start removes each lane whose ship record names a merge commit that is on
 * `origin/<base>`, provided the worktree holds no uncommitted change and no other process works inside
 * it, then prunes the worktrees git lost. Returns the removed lane slugs.
 * Evidence-based, not `git branch --merged`: squash merges leave the lane commits unmerged by ancestry.
 * Removing the cwd of a live lane session makes every hook of that session fail to spawn (t-vs35jd7 and
 * t-4k4yjzj lanes, 2026-11-16): a ship younger than PRUNE_FLOOR_MS is kept, and after it the process
 * cwds decide; a host without /proc keeps a ship younger than PRUNE_GRACE_MS. A record whose worktree and branch are already gone is skipped
 * silently: it stays as evidence for the Stop hook.
 */
export const PRUNE_GRACE_MS = 30 * 60_000;
/** With /proc: a lane agent's session runs no process inside its worktree between steps, so a fresh ship keeps it this long. */
export const PRUNE_FLOOR_MS = 5 * 60_000;

export function pruneMergedLanes(
  main: string,
  base: string,
  now = Date.now(),
  users: (path: string) => number[] | undefined = worktreeUsers,
): string[] {
  gitRun(main, ['worktree', 'prune']);
  const removed: string[] = [];
  for (const { branch, sha } of shipRecords(main)) {
    if (branch === base) continue;
    let age: number;
    try {
      age =
        now -
        statSync(
          join(main, shipRecordDir, `${encodeURIComponent(branch)}.json`),
        ).mtimeMs;
    } catch {
      continue;
    }
    // The record belongs to the lane that shipped it: a worktree whose tip is another commit is a
    // later lane that reuses the branch name, and its own ship may still wait on an open PR.
    const lane = readLane(main, base, branch);
    const path = lane.worktree;
    // Worktree and branch already gone: the record stays as evidence for the Stop hook.
    if (path === undefined && lane.tip === undefined) continue;
    if (lane.verdict !== 'merged' || lane.tip === undefined) continue;
    if (path !== undefined) {
      const removal = removeFinishedLane(main, path, branch, {
        git: (args, cwd) => {
          const out = gitRun(cwd, args);
          return { code: out.status ?? 70, stdout: out.stdout ?? '' };
        },
        users: (at) => {
          const found = users(at);
          // No /proc: a ship younger than the grace may still have its session there.
          if (found === undefined) return age < PRUNE_GRACE_MS ? [0] : [];
          // A lane agent may still be ending its session there without a process inside.
          return age < PRUNE_FLOOR_MS ? [0, ...found] : found;
        },
      });
      if (!removal.removed) continue;
      retireLane(main, path, 'pruned: its ship merged');
    } else gitRun(main, ['branch', '-D', branch]);
    removed.push(branch);
    process.stderr.write(
      `lane prune: removed ${branch}: its ship merged as ${sha.slice(0, 12)} on origin/${base} and the worktree held no change\n`,
    );
  }
  return removed;
}

/** Git's race under load: another process pruned the new worktree's admin dir before `locked` was written. */
const worktreeLockRace =
  /could not open '[^']*\/worktrees\/([^/']+)\/locked' for writing/u;

type WorktreeAdd = (
  main: string,
  args: string[],
) => { status: number | null; stderr: string };

/**
 * `git worktree add` for a lane, retried when git reports the worktree lock-file race: the half-made
 * admin dir and the branch git already created are removed first, so the retry starts clean.
 */
export function addLaneWorktree(
  main: string,
  slug: string,
  path: string,
  base: string,
  run: WorktreeAdd = gitRun,
  attempts = 5,
  delayMs = 200,
): void {
  const args = [
    'worktree',
    'add',
    '-q',
    '--no-track',
    '-b',
    slug,
    path,
    `origin/${base}`,
  ];
  for (let attempt = 1; ; attempt += 1) {
    const result = run(main, args);
    if (result.status === 0) return;
    const said = result.stderr.trim();
    const race = worktreeLockRace.exec(said);
    if (attempt >= attempts || race === null)
      throw new CliUsageError(`git ${args.join(' ')} failed: ${said}`);
    const common = gitRun(main, [
      'rev-parse',
      '--git-common-dir',
    ]).stdout.trim();
    const admin = join(resolve(main, common), 'worktrees', race[1] ?? slug);
    rmSync(admin, { recursive: true, force: true });
    rmSync(path, { recursive: true, force: true });
    gitOk(main, ['worktree', 'prune']);
    gitOk(main, ['branch', '-D', slug]);
    sleepSync(delayMs);
  }
}

function gitOk(root: string, args: string[]): boolean {
  return spawnSync('git', ['-C', root, ...args]).status === 0;
}

// A task created but not yet committed exists only in the invoking checkout;
// the new worktree is cut from the origin base branch, so the record moves with the lane.
// A record edited locally (a note appended before the lane) moves too: the worktree gets the
// edit and the invoking checkout returns to its committed version.
function untrackedTaskRecord(
  origin: string,
  id: string,
  base: string,
): CarriedRecord | undefined {
  const file = join(origin, taskFile(id));
  if (!existsSync(file)) return undefined;
  if (gitOk(origin, ['ls-files', '--error-unmatch', taskFile(id)])) {
    if (gitOk(origin, ['cat-file', '-e', `origin/${base}:tasks/${id}.json`]))
      return gitOk(origin, ['diff', '--quiet', 'HEAD', '--', taskFile(id)])
        ? undefined
        : { file, tracked: true };
    throw new CliUsageError(
      `${taskFile(id)} is tracked in ${origin} but not on origin/${base}; commit and push it first`,
    );
  }
  return { file, tracked: false };
}

export async function laneCommand(args: string[]): Promise<void> {
  const [verb, ...rest] = args;
  if (verb === 'brief') return briefCommand(rest);
  if (verb === 'drop') {
    process.stdout.write(`${await dropLane(rest)}\n`);
    return;
  }
  if (verb === 'status') {
    const { laneStatusCommand } = await import('./lane-status.ts');
    process.stdout.write(laneStatusCommand(rest));
    return;
  }
  if (verb === 'finish') {
    process.stdout.write(`${await finishLane(rest)}\n`);
    return;
  }
  if (verb !== 'start') throw new CliUsageError(laneUsage);
  const started = await startLane(rest);
  process.stdout.write(`${started.path}\n${started.slug}\n`);
}

/** A task claim file under .krn/task-claims, written by `krn task claim`. */
export const claimFileSchema = z
  .object({ worktree: z.unknown() })
  .describe('task claim file');

/** The ids of the claims held from `worktree`. */
function claimsFrom(main: string, worktree: string): string[] {
  const dir = join(main, '.krn', 'task-claims');
  if (!existsSync(dir)) return [];
  const ids: string[] = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.json')) continue;
    try {
      const claim = claimFileSchema.parse(
        JSON.parse(readFileSync(join(dir, name), 'utf8')),
      );
      if (claim.worktree === worktree) ids.push(name.slice(0, -5));
    } catch {
      /* A corrupt claim belongs to no lane. */
    }
  }
  return ids;
}

/** Task records in the worktree that are uncommitted there and absent from the main checkout. */
function soleTaskRecords(main: string, worktree: string): string[] {
  const status = spawnSync(
    'git',
    ['-C', worktree, 'status', '--porcelain', '-uall', '--', 'tasks'],
    { encoding: 'utf8' },
  );
  if (status.status !== 0) return [];
  const ids: string[] = [];
  for (const line of status.stdout.split('\n')) {
    const match = /tasks\/(t-[a-z0-9]+)\.json$/u.exec(line);
    if (match?.[1] === undefined || line.startsWith(' D')) continue;
    if (!existsSync(join(main, 'tasks', `${match[1]}.json`)))
      ids.push(match[1]);
  }
  return ids;
}

/** Drop a dead lane: release its claims, remove the worktree and delete the branch. */
export async function dropLane(rest: string[]): Promise<string> {
  let slug: string | undefined;
  let root: string | undefined;
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index] as string;
    if (arg === '--root')
      root = flagValue(
        rest,
        index++,
        () => new CliUsageError('--root requires a value'),
      );
    else if (arg.startsWith('--') || slug !== undefined)
      throw new CliUsageError(laneUsage);
    else slug = arg;
  }
  if (slug === undefined || !/^[a-z0-9][a-z0-9._-]*$/u.test(slug))
    throw new CliUsageError(`krn lane drop needs a lane slug\n${laneUsage}`);
  const main = mainCheckoutRoot(repositoryRoot(root ?? process.cwd()));
  if (slug === contractBase(main))
    throw new CliUsageError(
      `${slug} is the base branch, not a lane; krn lane drop never deletes it`,
    );
  const path = join(main, '.krn', 'worktrees', slug);
  const hasBranch = gitOk(main, [
    'show-ref',
    '--verify',
    '--quiet',
    `refs/heads/${slug}`,
  ]);
  if (!existsSync(path) && !hasBranch)
    throw new CliUsageError(
      `lane ${slug} does not exist; run git worktree list for the live lanes`,
    );
  const released: string[] = [];
  const hasWorktree = existsSync(path);
  if (hasWorktree) {
    const only = soleTaskRecords(main, path);
    if (only.length > 0)
      throw new CliUsageError(
        `lane ${slug} holds the only copy of ${only.join(', ')}; commit it on the lane branch or copy it to the main checkout, then drop again`,
      );
    const real = realpathSync(path);
    const ship = liveShipPid(path);
    if (ship !== undefined)
      throw new CliUsageError(
        `lane ${slug} has a live ship (pid ${ship}); wait for it to end or kill it, then drop again`,
      );
    const users = worktreeUsers(path);
    if (users === undefined || users.length > 0)
      throw new CliUsageError(
        `lane ${slug} is in use: ${users === undefined ? 'this host cannot list process cwds' : `process ${users.slice(0, 3).join(', ')} works inside it`}; end that process, then drop again`,
      );
    for (const id of claimsFrom(main, real)) {
      await releaseClaim(main, id);
      released.push(id);
    }
    git(main, ['worktree', 'remove', '--force', path]);
  }
  if (hasBranch) git(main, ['branch', '-D', slug]);
  if (hasWorktree) retireLane(main, path, 'dropped by krn lane drop');
  return `dropped lane ${slug}${released.length === 0 ? '' : ` (released ${released.join(', ')})`}`;
}

type CeilingReading = { share: number; ceiling: number; over: boolean } | null;

/** The ceiling reading of the last merged-PR window; tests inject a fixture. */
export type LaneDeps = {
  capacity?: () => HostCapacity;
  ceiling?: (main: string) => Promise<CeilingReading>;
  openPrs?: (main: string) => OpenPr[] | undefined;
};

async function windowCeiling(main: string): Promise<CeilingReading> {
  return nonDeliveryCeiling(
    await collectWindow({ last: CEILING_WINDOW_PRS, root: main }),
  );
}

/** The live host reading: load and memory now, plus the units held in the host-wide heavy-job gate. */
export function readHostCapacity(
  env: NodeJS.ProcessEnv = process.env,
): HostCapacity {
  return {
    capacity: hostUnits(env),
    sample: sampleHost(),
    usedUnits: slotHolders(hostGateDir(env)).reduce(
      (sum, holder) => sum + holder.weight,
      0,
    ),
  };
}

/** A lane start the host has no room for now; exit 75 (temporary): retry once load, memory or the gate frees up. */
export class LaneCapacityError extends Error {
  readonly exitCode = 75;
}

/** Refuses a lane while the host lacks free capacity; KRN_LANE_MAX_LIVE stays the upper cap on top of it. */
export function checkLaneCapacity(
  slug: string,
  read: () => HostCapacity = readHostCapacity,
): void {
  if (slug.startsWith(taskRecordsPrefix)) return;
  const short = laneHostShortfall(read(), laneLimits());
  if (short)
    throw new LaneCapacityError(
      `lane capacity: host has no room for another lane: ${short}; wait for running work to finish`,
    );
}

/** Refuses a non-delivery lane while non-delivery spend is above the ceiling; delivery lanes and an unpriced window pass. */
export async function checkLaneCeiling(
  main: string,
  sessionClass: string,
  read: (main: string) => Promise<CeilingReading> = windowCeiling,
): Promise<void> {
  if (sessionClass !== 'non-delivery') return;
  const c = await read(main);
  if (c?.over)
    throw new CliUsageError(
      `lane ceiling: non-delivery spend ${(c.share * 100).toFixed(0)}% is above ${(c.ceiling * 100).toFixed(0)}% of the last ${CEILING_WINDOW_PRS} merged PRs; start a delivery lane instead`,
    );
}

/** `lane-target:` lines of the task body and the KRN_LANE_TARGET list, read once at start (ADR 0029). */
function laneTargets(origin: string, task: string | undefined): string[] {
  const found = (process.env.KRN_LANE_TARGET ?? '').split(',');
  const body = task === undefined ? [] : (readTask(origin, task)?.body ?? []);
  for (const match of body.join('\n').matchAll(/^\s*lane-target:\s*(\S+)/gimu))
    found.push(match[1] as string);
  return found
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => resolve(entry));
}

export async function startLane(
  rest: string[],
  deps: LaneDeps = {},
): Promise<{ path: string; slug: string }> {
  let slug: string | undefined;
  let task: string | undefined;
  let actor = 'lead';
  let reason: string | undefined;
  let root: string | undefined;
  let laneId: string | undefined;
  // KRN_SESSION_CLASS=lane marks a worker session, not a lane class: only the two lane classes count.
  const inherited = process.env.KRN_SESSION_CLASS;
  let sessionClass = inherited === 'non-delivery' ? inherited : 'delivery';
  const value = (index: number, name: string) =>
    flagValue(rest, index, () => new CliUsageError(`${name} requires a value`));
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index] as string;
    if (arg === '--class') sessionClass = value(index++, arg);
    else if (arg === '--task') task = value(index++, arg);
    else if (arg === '--lane') laneId = value(index++, arg);
    else if (arg === '--actor') actor = value(index++, arg);
    else if (arg === '--reason') reason = value(index++, arg);
    else if (arg === '--root') root = value(index++, arg);
    else if (arg.startsWith('--') || slug !== undefined)
      throw new CliUsageError(laneUsage);
    else slug = arg;
  }
  if (slug === undefined || !/^[a-z0-9][a-z0-9._-]*$/u.test(slug))
    throw new CliUsageError(
      `lane slug must be lowercase letters, digits, ".", "_" or "-"\n${laneUsage}`,
    );
  if (task !== undefined && !isTaskId(task))
    throw new CliUsageError(`not a task id: ${task}`);
  if (sessionClass !== 'delivery' && sessionClass !== 'non-delivery')
    throw new CliUsageError('--class must be delivery or non-delivery');

  const origin = repositoryRoot(root ?? process.cwd());
  const main = mainCheckoutRoot(origin);
  const path = join(main, '.krn', 'worktrees', slug);
  // `--lane` starts the lane `krn lane brief` reserved: it must be reserved, for this slug and task.
  if (laneId !== undefined) {
    const reserved = readManifest(main, laneId);
    if (reserved === undefined || reserved.phase.kind !== 'reserved')
      throw new CliUsageError(
        `lane ${laneId} is not reserved: run \`krn lane brief --task ID\` for its start command`,
      );
    if (reserved.slug !== slug || reserved.task !== task)
      throw new CliUsageError(
        `lane ${laneId} was reserved for ${reserved.slug}${reserved.task === undefined ? '' : ` and ${reserved.task}`}`,
      );
  }
  if (existsSync(path))
    throw new CliUsageError(`lane ${slug} already exists at ${path}`);
  if (gitOk(main, ['show-ref', '--verify', '--quiet', `refs/heads/${slug}`]))
    throw new CliUsageError(`branch ${slug} already exists`);

  const base = contractBase(origin);
  fetchBase(main, base);
  // Validate, then mutate (ADR 0029): every refusal below leaves the ship records, claims, pending ref,
  // worktrees and branches as they were. The budget already skips merged clean lanes prune would remove.
  checkLaneBudget(main, base, slug);
  const free = freeGb(main);
  // Disk fills silently until the budget refuses: each start says what is left and how to reclaim it.
  if (free !== undefined)
    process.stderr.write(
      `lane budget: ${free.toFixed(1)} GB free under ${main}; \`krn prune --dry-run\` lists what agent work can free\n`,
    );
  checkOpenRedLimit(main, deps.openPrs);
  await checkLaneCeiling(main, sessionClass, deps.ceiling);
  // An adoption committed only locally is invisible to a worktree cut from origin/<base>.
  if (
    existsSync(join(main, 'krn.json')) &&
    !gitOk(main, ['cat-file', '-e', `origin/${base}:krn.json`])
  )
    throw new CliUsageError(
      `krn.json is not on origin/${base}: commit the files krn adopt wrote and merge them to ${base} before starting lanes`,
    );
  if (task !== undefined) assertClaimFree(main, task, actor);
  // A temporary refusal comes after every configuration error, so a retry is never wasted on one.
  checkLaneCapacity(slug, deps.capacity);
  // The branch name is free (checked above): a ship record under it is an earlier lane's.
  const restoreShip = forgetShip(main, slug);
  let copied = false;
  // Shipped lanes leave their worktree and branch behind: free them now that the start is admitted.
  pruneMergedLanes(main, base);
  // A record of an earlier lane at this path outlived its worktree: it no longer names a live lane.
  retireGoneLane(main, path);
  const targets = laneTargets(origin, task);
  // A record pending on the publish ref moves into the checkout, then into the lane like any untracked one.
  const taken =
    task === undefined ? undefined : takePendingRecord(origin, task);
  try {
    const carried =
      task === undefined ? undefined : untrackedTaskRecord(origin, task, base);
    // --no-track: a lane session's sandbox mounts a read-only placeholder over .git/config.lock in
    // the shared git dir, so any config write (upstream tracking) fails while a lane runs.
    try {
      addLaneWorktree(main, slug, path, base);
    } catch (error) {
      // git creates the branch before the worktree directory; a failed add would leave it behind
      // and every retry would refuse with "branch already exists".
      gitOk(main, ['worktree', 'prune']);
      gitOk(main, ['branch', '-D', slug]);
      throw error;
    }
    let claimed = false;
    try {
      if (task !== undefined) {
        copied = carried !== undefined && carryTaskRecord(carried, path, task);
        // A further lane of the same actor shares the claim it already holds: the claim stays held once.
        const held = inspectClaim(main, task);
        if (held.state !== 'live' || held.claim?.actor !== actor) {
          await claimTask(main, task, {
            actor,
            worktree: path,
            reason: reason ?? `lane ${slug}`,
          });
          claimed = true;
        }
      }
      // A task-records publish holds no agent session, so it is no lane and records none.
      if (laneId !== undefined)
        transition(
          main,
          laneId,
          { kind: 'started' },
          { branch: slug, worktree: realpathSync(path), targets },
        );
      else if (!slug.startsWith(taskRecordsPrefix))
        createManifest(
          main,
          {
            laneId: newLaneId(slug),
            slug,
            branch: slug,
            worktree: realpathSync(path),
            base,
            ...(task === undefined ? {} : { task }),
            targets,
            actor,
            createdAt: new Date().toISOString(),
            agents: [],
          },
          { kind: 'started' },
        );
    } catch (error) {
      // The record left the checkout only once the lane holds it: until here the checkout keeps its copy.
      if (claimed && task !== undefined) await releaseClaim(main, task);
      git(main, ['worktree', 'remove', '--force', path]);
      git(main, ['branch', '-D', slug]);
      throw error;
    }
    // The lane holds the record now: the checkout copy goes only after every step that could still fail.
    if (copied && carried !== undefined && task !== undefined) {
      if (carried.tracked) git(origin, ['checkout', '--', taskFile(task)]);
      else dropCarriedCopy(carried);
      // The pending ref keeps its copy for main readers; it names the lane that now carries it.
      if (taken !== undefined) holdTaskForLane(origin, task, slug);
    }
    return { path: realpathSync(path), slug };
  } catch (error) {
    // A refused start leaves the record where it waited: back on the pending ref, the checkout clean.
    taken?.restore();
    restoreShip();
    throw error;
  }
}
