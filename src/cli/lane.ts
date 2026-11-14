import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statfsSync,
} from 'node:fs';
import { dirname, join, sep } from 'node:path';
import { precedentSection } from '../brain/precedent.ts';
import { briefStandards } from '../brain/standards.ts';
import { PROJECT_STANDARDS, readProject } from '../brain/standards-cli.ts';
import { lanePacket, packetBrief } from '../brain/worker-packet.ts';
import {
  CEILING_WINDOW_PRS,
  collectWindow,
  nonDeliveryCeiling,
} from '../outcome/window.ts';
import { contractBase, findContract } from '../repo/contract.ts';
import { claimTask, mainCheckoutRoot, releaseClaim } from '../task/claims.ts';
import { isTaskId } from '../task/record.ts';
import { repositoryRoot } from '../task/store.ts';
import { flagValue } from './flag-value.ts';
import { sleepSync } from './lane-lock.ts';
import { CliUsageError } from './usage-error.ts';

export const laneUsage = [
  'krn lane start SLUG [--task ID] [--actor NAME] [--reason TEXT] [--class delivery|non-delivery] [--root DIR]  fetch the repo contract base branch from origin, create branch SLUG from it in .krn/worktrees/SLUG, claim the task; a non-delivery lane is refused while `krn ledger --check-ceiling` is over; prints the path and branch',
  'krn lane run (--task ID | --goal TEXT) [--slug SLUG] [--actor NAME] [--model MODEL] [--root DIR]  start the lane (or reuse its worktree and take its claim again after a failed run), run one headless claude session on the task record, ship the commit through `krn pr ship`; prints one verdict line, exit 0 only when merged; before the session a preflight checks origin with the lane credentials and the sandbox settings file (exit 69 in seconds), then it runs the krn.json `install` command (exit 71 when it fails) and the contract test on the clean base, one lane at a time per repository (a red run reruns only its failing test files once; exit 72 when they fail again, naming them), starting no session in any of these cases; the session runs with `--max-budget-usd` (krn.json `laneBudgetUsd`, default 3), `--fallback-model` and `--setting-sources project`, and a session stopped at its cap exits 75',
  'krn lane drop SLUG [--root DIR]  remove the lane worktree and branch and release the claim held from that worktree',
  'krn lane brief [--file PATH] [--task ID] [--as-of YYYY-MM-DD] [--root DIR]  print the lane brief (file, else stdin) behind the FR-40 brain packet of the repository records, followed by the in-force worker standards of .agents/standards.json (inherited ones marked)',
].join('\n');

/**
 * What a worker is told about the tracker. D23 arm K refused five units because the record or the
 * history said the work was done, while the unit's tests were red: the repository, not the record, is the truth.
 */
const SHARED_RULES = `Worker rules:
- Done means every behavior the task describes has a test in this clone that passes, and your change is committed. A closed task record, an earlier commit or a green existing suite never means done: an earlier commit may cover only part of the task.
- For each behavior, outcome or interface the task states, write a test that checks it at its receiver. If it fails, fix the code; if it passes already, keep the test: the commit then carries the proof. Stop without a commit only when you can name an existing test for every described behavior.
- When the task names an input or output format (for example "unified diffs", "newline-separated lists", "JSON"), write at least one test whose input is the plainest hand-written example of that format exactly as the task words it, never only input your own code or tool produced: your reader must accept every form the wording allows, including the shortest and plainest one.
- A red test outranks tracker state and scope: if a test needs a file outside Scope, edit it and name it in your final reply.
- Your final reply states every claim about an external system (a remote repository, a service, a receiver, a CI run) together with the exact command you ran and its exit code; a claim without them is treated as unverified. Name the credential or token scope the command used, and run the real receiver, not a stand-in.
- When you write the PR body with \`krn pr body\`, pass \`--lane\`: it adds the line the ledger counts as lane authorship.`;

const STOP_SCRIPT = 'src/hook/stop.ts';

/**
 * The worker rules for this repository: the closing check names the Stop script where the
 * repository ships it, else the repo contract's own commands, so a pytest repository on master
 * is never told to run npm.
 */
export function workerRules(
  repo: string,
  testFirst = process.env.KRN_TEST_FIRST === '1',
): string {
  const rules = baseWorkerRules(repo);
  return testFirst ? `${rules}\n- ${TEST_FIRST_RULE}` : rules;
}

/** Arm KT only (KRN_TEST_FIRST=1): the Stop hook enforces it. */
export const TEST_FIRST_RULE =
  'Test first: before you change source, commit or at least write a test that fails against the base source and shows the defect or missing behavior; your session is refused its end unless a changed test fails at the base and passes on your commit.';

function baseWorkerRules(repo: string): string {
  if (existsSync(join(repo, STOP_SCRIPT)))
    return `${SHARED_RULES}\n- Before you end, run 'bin/krn hook stop --check' (it runs the tests the repo contract selects for the files you changed, its guard tests, or the full test command when none relate; '--related' lists them). The session is refused its end while there is no commit or that check is red; the one escape is a final line 'BLOCKER: <what stops you>'.`;
  const contract = findContract(repo)?.contract;
  if (contract === undefined)
    return `${SHARED_RULES}\n- Before you end, run the repository's tests and fix what they report; when you cannot make them pass, end with a final line 'BLOCKER: <what stops you>'.`;
  const fast =
    contract.fast === undefined || contract.fast === contract.test
      ? ''
      : `'${contract.fast}' while you work, then `;
  return `${SHARED_RULES}\n- Before you end, run ${fast}the full test command '${contract.test}' and fix what it reports; changes target branch '${contract.base}'. When you cannot make the tests pass, end with a final line 'BLOCKER: <what stops you>'.`;
}

/** The lane brief with the FR-40 carrier prefix (D0, t-5983e6g): the measured arm-B prompt. */
export function laneBriefText(
  repo: string,
  brief: string,
  asOf: string,
  task = 'lane-brief',
): string {
  return laneBrief(repo, brief, asOf, task).text;
}

/** The lane brief and the sha256 of the packet it carries (null when it carries none), so a run can record which packet it served. */
export function laneBrief(
  repo: string,
  brief: string,
  asOf: string,
  task = 'lane-brief',
): { text: string; packet: string | null } {
  const packet = lanePacket(repo, brief, asOf, task);
  const text = packetBrief(packet, brief);
  const precedent = precedentSection(repo, brief);
  const standards = briefStandards(readProject(repo), asOf, PROJECT_STANDARDS);
  const body = [text, precedent, standards]
    .filter((part) => part !== '')
    .map((part) => part.trimEnd())
    .join('\n\n');
  return {
    text: `${body.trimEnd()}\n\n${workerRules(repo)}\n`,
    packet:
      packet === null || packet.records.length === 0 ? null : packet.sha256,
  };
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

/** What git prints when another process holds a ref lock it needs (a concurrent fetch of the same repository). */
const refLockBusy =
  /cannot lock ref|unable to update local ref|Unable to create '[^']*\.lock'|\.lock': File exists/u;

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
  for (let attempt = 1; ; attempt += 1) {
    const result = spawnSync(
      'git',
      ['-C', main, 'fetch', '-q', 'origin', base],
      {
        encoding: 'utf8',
      },
    );
    if (result.status === 0) return;
    const said = (result.stderr || result.stdout).trim();
    if (attempt >= attempts || !refLockBusy.test(said))
      throw new CliUsageError(`git fetch -q origin ${base} failed: ${said}`);
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
interface CarriedRecord {
  readonly file: string;
  readonly tracked: boolean;
}

function untrackedTaskRecord(
  origin: string,
  id: string,
  base: string,
): CarriedRecord | undefined {
  const file = join(origin, 'tasks', `${id}.json`);
  if (!existsSync(file)) return undefined;
  if (gitOk(origin, ['ls-files', '--error-unmatch', `tasks/${id}.json`])) {
    if (gitOk(origin, ['cat-file', '-e', `origin/${base}:tasks/${id}.json`]))
      return gitOk(origin, [
        'diff',
        '--quiet',
        'HEAD',
        '--',
        `tasks/${id}.json`,
      ])
        ? undefined
        : { file, tracked: true };
    throw new CliUsageError(
      `tasks/${id}.json is tracked in ${origin} but not on origin/${base}; commit and push it first`,
    );
  }
  return { file, tracked: false };
}

// The copy lands first; the original goes only once the claim has succeeded.
function carryTaskRecord(
  { file, tracked }: CarriedRecord,
  worktree: string,
  id: string,
): boolean {
  const target = join(worktree, 'tasks', `${id}.json`);
  if (existsSync(target) && !tracked) return false;
  mkdirSync(dirname(target), { recursive: true });
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
    const only = soleTaskRecords(main, path);
    if (only.length > 0)
      throw new CliUsageError(
        `lane ${slug} holds the only copy of ${only.join(', ')}; commit it on the lane branch or copy it to the main checkout, then drop again`,
      );
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
  // KRN_SESSION_CLASS=lane marks a worker session, not a lane class: only the two lane classes count.
  const inherited = process.env.KRN_SESSION_CLASS;
  let sessionClass = inherited === 'non-delivery' ? inherited : 'delivery';
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
  const base = contractBase(origin);
  fetchBase(main, base);
  // An adoption committed only locally is invisible to a worktree cut from origin/<base>.
  if (
    existsSync(join(main, 'krn.json')) &&
    !gitOk(main, ['cat-file', '-e', `origin/${base}:krn.json`])
  )
    throw new CliUsageError(
      `krn.json is not on origin/${base}: commit the files krn adopt wrote and merge them to ${base} before starting lanes`,
    );
  const carried =
    task === undefined ? undefined : untrackedTaskRecord(origin, task, base);
  // --no-track: a lane session's sandbox mounts a read-only placeholder over .git/config.lock in
  // the shared git dir, so any config write (upstream tracking) fails while a lane runs.
  try {
    git(main, [
      'worktree',
      'add',
      '-q',
      '--no-track',
      '-b',
      slug,
      path,
      `origin/${base}`,
    ]);
  } catch (error) {
    // git creates the branch before the worktree directory; a failed add would leave it behind
    // and every retry would refuse with "branch already exists".
    gitOk(main, ['worktree', 'prune']);
    gitOk(main, ['branch', '-D', slug]);
    throw error;
  }
  if (task !== undefined) {
    try {
      const copied =
        carried !== undefined && carryTaskRecord(carried, path, task);
      await claimTask(main, task, {
        actor,
        worktree: path,
        reason: reason ?? `lane ${slug}`,
      });
      if (copied && carried !== undefined) {
        if (carried.tracked)
          git(origin, ['checkout', '--', `tasks/${task}.json`]);
        else rmSync(carried.file);
      }
    } catch (error) {
      git(main, ['worktree', 'remove', '--force', path]);
      git(main, ['branch', '-D', slug]);
      throw error;
    }
  }
  return { path: realpathSync(path), slug };
}
