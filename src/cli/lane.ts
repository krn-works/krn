import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statfsSync,
} from 'node:fs';
import { join, sep } from 'node:path';
import { precedentSection } from '../brain/precedent.ts';
import { lanePacket, packetBrief } from '../brain/worker-packet.ts';
import {
  CEILING_WINDOW_PRS,
  collectWindow,
  nonDeliveryCeiling,
} from '../outcome/window.ts';
import { claimTask, mainCheckoutRoot, releaseClaim } from '../task/claims.ts';
import { isTaskId } from '../task/record.ts';
import { repositoryRoot } from '../task/store.ts';
import { flagValue } from './flag-value.ts';
import { CliUsageError } from './usage-error.ts';

export const laneUsage = [
  'krn lane start SLUG [--task ID] [--actor NAME] [--reason TEXT] [--class delivery|non-delivery] [--root DIR]  fetch origin main, create branch SLUG in .krn/worktrees/SLUG, claim the task; a non-delivery lane is refused while `krn ledger --check-ceiling` is over; prints the path and branch',
  'krn lane run --task ID [--slug SLUG] [--actor NAME] [--model MODEL] [--root DIR]  start the lane (or reuse its worktree and take its claim again after a failed run), run one headless claude session on the task record, ship the commit through `krn pr ship`; prints one verdict line, exit 0 only when merged',
  'krn lane drop SLUG [--root DIR]  remove the lane worktree and branch and release the claim held from that worktree',
  'krn lane brief [--file PATH] [--task ID] [--as-of YYYY-MM-DD] [--root DIR]  print the lane brief (file, else stdin) behind the FR-40 brain packet of the repository records',
].join('\n');

/**
 * What a worker is told about the tracker. D23 arm K refused five units because the record or the
 * history said the work was done, while the unit's tests were red: the repository, not the record, is the truth.
 */
export const WORKER_RULES = `Worker rules:
- Done means every behavior the task describes has a test in this clone that passes, and your change is committed. A closed task record, an earlier commit or a green existing suite never means done: an earlier commit may cover only part of the task.
- For each behavior, outcome or interface the task states, write a test that checks it at its receiver. If it fails, fix the code; if it passes already, keep the test: the commit then carries the proof. Stop without a commit only when you can name an existing test for every described behavior.
- A red test outranks tracker state and scope: if a test needs a file outside Scope (other than tasks/ and the roadmap), edit it and name it in your final reply.
- Before you end, run 'node scripts/claude/worker-stop.ts --check' (it runs the tests importing the files you changed; '--related' lists them). The session is refused its end while there is no commit or that check is red; the one escape is a final line 'BLOCKER: <what stops you>'.`;

/** The lane brief with the FR-40 carrier prefix (D0, t-5983e6g): the measured arm-B prompt. */
export function laneBriefText(
  repo: string,
  brief: string,
  asOf: string,
  task = 'lane-brief',
): string {
  const text = packetBrief(lanePacket(repo, brief, asOf, task), brief);
  const precedent = precedentSection(repo, brief);
  const body = precedent === '' ? text : `${text}\n\n${precedent}\n`;
  return `${body.trimEnd()}\n\n${WORKER_RULES}\n`;
}

function briefCommand(rest: string[]): void {
  let file: string | undefined;
  let task: string | undefined;
  let asOf = new Date().toISOString().slice(0, 10);
  let root: string | undefined;
  const value = (index: number, name: string) =>
    flagValue(rest, index, () => new CliUsageError(`${name} requires a value`));
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index] as string;
    if (arg === '--file') file = value(index++, arg);
    else if (arg === '--task') task = value(index++, arg);
    else if (arg === '--as-of') asOf = value(index++, arg);
    else if (arg === '--root') root = value(index++, arg);
    else throw new CliUsageError(laneUsage);
  }
  if (task !== undefined && !isTaskId(task))
    throw new CliUsageError(`not a task id: ${task}`);
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(asOf))
    throw new CliUsageError(`--as-of must be YYYY-MM-DD: ${asOf}`);
  const brief = readFileSync(file ?? 0, 'utf8');
  if (brief.trim() === '') throw new CliUsageError('lane brief is empty');
  const repo = repositoryRoot(root ?? process.cwd());
  process.stdout.write(laneBriefText(repo, brief, asOf, task));
}

// Host budget: refuse below KRN_LANE_MIN_FREE_GB free (default 5) on the
// repository or the lane temp dir, and at KRN_LANE_MAX_LIVE worktrees (default 8).
function limit(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value >= 0 && process.env[name] !== ''
    ? value
    : fallback;
}

function freeGb(dir: string): number | undefined {
  try {
    const stats = statfsSync(dir);
    return (stats.bavail * stats.bsize) / 1024 ** 3;
  } catch {
    return undefined;
  }
}

export function checkLaneBudget(main: string): void {
  const minFree = limit('KRN_LANE_MIN_FREE_GB', 5);
  for (const dir of [
    main,
    process.env.KRN_LANE_TMP ?? join(sep, 'mnt', 'storage', 'tmp'),
  ]) {
    const free = freeGb(dir);
    if (free !== undefined && free < minFree)
      throw new CliUsageError(
        `lane budget: only ${free.toFixed(1)} GB free under ${dir} (minimum ${minFree} GB, KRN_LANE_MIN_FREE_GB); free disk before starting a lane`,
      );
  }
  const maxLive = limit('KRN_LANE_MAX_LIVE', 8);
  const dir = join(main, '.krn', 'worktrees');
  const live = existsSync(dir)
    ? readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory())
        .length
    : 0;
  if (live >= maxLive)
    throw new CliUsageError(
      `lane budget: ${live} live lane worktrees in ${dir} (maximum ${maxLive}, KRN_LANE_MAX_LIVE); ship or remove a lane first`,
    );
}

function git(root: string, args: string[]): string {
  const result = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' });
  if (result.status !== 0)
    throw new CliUsageError(
      `git ${args.join(' ')} failed: ${(result.stderr || result.stdout).trim()}`,
    );
  return result.stdout.trim();
}

function gitOk(root: string, args: string[]): boolean {
  return spawnSync('git', ['-C', root, ...args]).status === 0;
}

// A task created but not yet committed exists only in the invoking checkout;
// the new worktree is cut from origin/main, so the record moves with the lane.
function untrackedTaskRecord(origin: string, id: string): string | undefined {
  const file = join(origin, 'tasks', `${id}.json`);
  if (!existsSync(file)) return undefined;
  if (gitOk(origin, ['ls-files', '--error-unmatch', `tasks/${id}.json`])) {
    if (gitOk(origin, ['cat-file', '-e', `origin/main:tasks/${id}.json`]))
      return undefined;
    throw new CliUsageError(
      `tasks/${id}.json is tracked in ${origin} but not on origin/main; commit and push it first`,
    );
  }
  return file;
}

// The copy lands first; the original goes only once the claim has succeeded.
function carryTaskRecord(file: string, worktree: string, id: string): boolean {
  const target = join(worktree, 'tasks', `${id}.json`);
  if (existsSync(target)) return false;
  copyFileSync(file, target);
  return true;
}

export async function laneCommand(args: string[]): Promise<void> {
  const [verb, ...rest] = args;
  if (verb === 'brief') return briefCommand(rest);
  if (verb === 'run') {
    const { laneRunCommand } = await import('./lane-run.ts');
    const verdict = await laneRunCommand(rest);
    process.stdout.write(`${verdict.line}\n`);
    process.exitCode = verdict.exitCode;
    return;
  }
  if (verb === 'drop') {
    process.stdout.write(`${await dropLane(rest)}\n`);
    return;
  }
  if (verb !== 'start') throw new CliUsageError(laneUsage);
  const started = await startLane(rest);
  process.stdout.write(`${started.path}\n${started.slug}\n`);
}

/** The ids of the claims held from `worktree`. */
function claimsFrom(main: string, worktree: string): string[] {
  const dir = join(main, '.krn', 'task-claims');
  if (!existsSync(dir)) return [];
  const ids: string[] = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.json')) continue;
    try {
      const claim = JSON.parse(readFileSync(join(dir, name), 'utf8')) as {
        worktree?: unknown;
      };
      if (claim.worktree === worktree) ids.push(name.slice(0, -5));
    } catch {
      /* A corrupt claim belongs to no lane. */
    }
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
  const path = join(main, '.krn', 'worktrees', slug);
  const hasBranch = gitOk(main, [
    'show-ref',
    '--verify',
    '--quiet',
    `refs/heads/${slug}`,
  ]);
  if (!existsSync(path) && !hasBranch)
    throw new CliUsageError(`lane ${slug} does not exist`);
  const released: string[] = [];
  if (existsSync(path)) {
    for (const id of claimsFrom(main, realpathSync(path))) {
      await releaseClaim(main, id);
      released.push(id);
    }
    git(main, ['worktree', 'remove', '--force', path]);
  }
  if (hasBranch) git(main, ['branch', '-D', slug]);
  return `dropped lane ${slug}${released.length === 0 ? '' : ` (released ${released.join(', ')})`}`;
}

type CeilingReading = { share: number; ceiling: number; over: boolean } | null;

/** The ceiling reading of the last merged-PR window; tests inject a fixture. */
export type LaneDeps = { ceiling?: (main: string) => Promise<CeilingReading> };

async function windowCeiling(main: string): Promise<CeilingReading> {
  return nonDeliveryCeiling(
    await collectWindow({ last: CEILING_WINDOW_PRS, root: main }),
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

export async function startLane(
  rest: string[],
  deps: LaneDeps = {},
): Promise<{ path: string; slug: string }> {
  let slug: string | undefined;
  let task: string | undefined;
  let actor = 'lead';
  let reason: string | undefined;
  let root: string | undefined;
  let sessionClass = process.env.KRN_SESSION_CLASS ?? 'delivery';
  const value = (index: number, name: string) =>
    flagValue(rest, index, () => new CliUsageError(`${name} requires a value`));
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index] as string;
    if (arg === '--class') sessionClass = value(index++, arg);
    else if (arg === '--task') task = value(index++, arg);
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
  if (existsSync(path))
    throw new CliUsageError(`lane ${slug} already exists at ${path}`);
  if (gitOk(main, ['show-ref', '--verify', '--quiet', `refs/heads/${slug}`]))
    throw new CliUsageError(`branch ${slug} already exists`);

  checkLaneBudget(main);
  await checkLaneCeiling(main, sessionClass, deps.ceiling);
  git(main, ['fetch', '-q', 'origin', 'main']);
  const carried =
    task === undefined ? undefined : untrackedTaskRecord(origin, task);
  git(main, ['worktree', 'add', '-q', '-b', slug, path, 'origin/main']);
  if (task !== undefined) {
    try {
      const copied =
        carried !== undefined && carryTaskRecord(carried, path, task);
      await claimTask(main, task, {
        actor,
        worktree: path,
        reason: reason ?? `lane ${slug}`,
      });
      if (copied && carried !== undefined) rmSync(carried);
    } catch (error) {
      git(main, ['worktree', 'remove', '--force', path]);
      git(main, ['branch', '-D', slug]);
      throw error;
    }
  }
  return { path: realpathSync(path), slug };
}
