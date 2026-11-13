import { spawnSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { shipCommand } from '../ci/ship.ts';
import {
  contractBase,
  contractTracker,
  findContract,
} from '../repo/contract.ts';
import { claimTask, mainCheckoutRoot, releaseClaim } from '../task/claims.ts';
import { isTaskId } from '../task/record.ts';
import { getTask, repositoryRoot } from '../task/store.ts';
import { flagValue } from './flag-value.ts';
import { laneBriefText } from './lane.ts';
import { renderPrBody } from './pr-body.ts';
import { CliUsageError } from './usage-error.ts';

export interface LaneVerdict {
  line: string;
  exitCode: number;
}

/** The steps a task run takes outside its own logic; tests replace the ones that reach GitHub. */
export interface LaneRunSteps {
  start(args: string[]): Promise<{ path: string; slug: string }>;
  ship(args: string[]): Promise<string>;
  /** Mint the GitHub App token (warming its cache) before the session starts; a string is the failure. */
  mint(env: NodeJS.ProcessEnv): Promise<string | undefined>;
}

/** Operator credentials that never reach a lane session; only the cached App token does, and the sandbox blocks localhost so bw serve is out of reach. */
export const OPERATOR_CREDENTIAL_VARIABLES = [
  'GH_TOKEN',
  'GITHUB_TOKEN',
  'GH_ENTERPRISE_TOKEN',
  'GITHUB_ENTERPRISE_TOKEN',
  'GIT_ASKPASS',
  'SSH_ASKPASS',
  'SSH_AUTH_SOCK',
  'GNOME_KEYRING_CONTROL',
] as const;

const exitCredentialUnavailable = 69;

const defaultSessionTimeoutMs = 45 * 60 * 1000;

/**
 * An App token lives about an hour and the sandboxed session cannot refresh it, so the
 * launcher mints one with at least this much life left and no session outlasts that.
 */
export const tokenMinimumRemainingSeconds = 50 * 60;

/** The longest a claude session may run: KRN_LANE_TIMEOUT_MS, else 45 minutes; never past the token minimum. */
export function sessionTimeoutMs(env: NodeJS.ProcessEnv): number {
  const value = Number(env.KRN_LANE_TIMEOUT_MS);
  const wanted =
    Number.isInteger(value) && value > 0 ? value : defaultSessionTimeoutMs;
  return Math.min(wanted, defaultSessionTimeoutMs);
}

const tokenHelper = fileURLToPath(
  new URL('../../scripts/github-app-token.ts', import.meta.url),
);
const fastCheck = fileURLToPath(
  new URL('../../scripts/fast-check.ts', import.meta.url),
);
const wrapperDirectory = fileURLToPath(
  new URL('../../scripts/app-bin', import.meta.url),
);

/**
 * The session environment: the operator's credentials removed, the `gh` wrapper first on PATH,
 * and git config that empties the inherited github.com credential helpers before installing
 * the App token helper.
 */
export function sessionEnvironment(
  env: NodeJS.ProcessEnv,
  cacheDirectory: string,
  identity: { task?: string; lane: string },
): NodeJS.ProcessEnv {
  const scrubbed: NodeJS.ProcessEnv = { ...env };
  for (const name of OPERATOR_CREDENTIAL_VARIABLES) delete scrubbed[name];
  const existing = Number(scrubbed.GIT_CONFIG_COUNT);
  const start = Number.isInteger(existing) && existing > 0 ? existing : 0;
  const key = 'credential.https://github.com.helper';
  return {
    ...scrubbed,
    KRN_SESSION_CLASS: 'lane',
    // The worker hooks tell a lane from the lead by its task (or, for a goal lane, its slug), never by its name.
    KRN_LANE: identity.lane,
    ...(identity.task === undefined ? {} : { KRN_TASK: identity.task }),
    KRN_APP_CACHE_DIR: scrubbed.KRN_APP_CACHE_DIR || cacheDirectory,
    PATH: scrubbed.PATH
      ? `${wrapperDirectory}:${scrubbed.PATH}`
      : wrapperDirectory,
    GIT_CONFIG_COUNT: String(start + 2),
    [`GIT_CONFIG_KEY_${start}`]: key,
    [`GIT_CONFIG_VALUE_${start}`]: '',
    [`GIT_CONFIG_KEY_${start + 1}`]: key,
    [`GIT_CONFIG_VALUE_${start + 1}`]: `!'${process.execPath}' '${tokenHelper}' git-credential`,
  };
}

interface SessionResult {
  ok: boolean;
  detail: string;
  cost: number | undefined;
}

const exitNoDelivery = 74;

/** The model a lane session runs on unless `--model` says otherwise (operator model policy). */
export const defaultLaneModel = 'sonnet';

/** The subject of the session's commit that carries the task's Ticket trailer, else undefined. */
export function ticketCommitTitle(
  log: string,
  task: string,
): string | undefined {
  for (const entry of log.split('\x1e')) {
    const [subject, trailers] = entry.trim().split('\x1f');
    if (
      subject &&
      (trailers ?? '')
        .split(',')
        .map((item) => item.trim())
        .includes(task)
    )
      return subject.endsWith(`(${task})`) ? subject : `${subject} (${task})`;
  }
  return undefined;
}

/**
 * What the session proved: `npm run fast` leaves .krn/cache/fast-pass holding the key of the tree
 * it passed on; the proof counts only while it equals the key of the final tree.
 */
export function sessionVerification(worktree: string): string | undefined {
  const marker = join(worktree, '.krn', 'cache', 'fast-pass');
  if (!existsSync(marker)) return undefined;
  // The key comes from the script that wrote the marker, run as a process: scripts/ is not an import of src/.
  const key = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      'const { treeKey } = await import(process.env.KRN_FAST_CHECK); process.stdout.write(treeKey(process.cwd()));',
    ],
    {
      cwd: worktree,
      encoding: 'utf8',
      env: { ...process.env, KRN_FAST_CHECK: fastCheck },
    },
  );
  return key.status === 0 && readFileSync(marker, 'utf8') === key.stdout
    ? 'npm run fast PASS on the final tree (.krn/cache/fast-pass matches HEAD)'
    : undefined;
}

/** Read the JSON result of `claude -p --output-format json`. */
/** The files the harness sandbox mounts empty over write-denied paths: .env*, .npmrc and lockfiles. */
const placeholderName =
  /^(\.env(\..+)?|\.npmrc|package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?)$/u;

/**
 * The untracked empty regular files in `git status --porcelain -z` output that carry a known
 * sandbox placeholder name. Any other empty untracked file (.gitkeep, a marker) is intended
 * work and stays.
 */
export function sandboxPlaceholders(
  porcelain: string,
  stat: (path: string) => { isFile(): boolean; size: number },
): string[] {
  return porcelain
    .split('\0')
    .filter((entry) => entry.startsWith('?? '))
    .map((entry) => entry.slice(3))
    .filter((path) => placeholderName.test(basename(path)))
    .filter((path) => {
      const info = stat(path);
      return info.isFile() && info.size === 0;
    });
}

export function parseSessionResult(stdout: string): SessionResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return {
      ok: false,
      detail: 'session printed no JSON result (not a timeout)',
      cost: undefined,
    };
  }
  if (typeof parsed !== 'object' || parsed === null)
    return {
      ok: false,
      detail: 'session result is not an object',
      cost: undefined,
    };
  const record = parsed as Record<string, unknown>;
  const cost =
    typeof record.total_cost_usd === 'number'
      ? record.total_cost_usd
      : undefined;
  const subtype =
    typeof record.subtype === 'string' ? record.subtype : 'unknown';
  const failed = record.is_error === true || subtype !== 'success';
  return { ok: !failed, detail: `session ${subtype}`, cost };
}

function git(cwd: string, args: string[]): string {
  const result = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
  if (result.status !== 0)
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr.trim()}`);
  return result.stdout.trim();
}

/** The command the session runs before it finishes: the contract's quick check, else its tests. */
function checkCommand(root: string): string {
  const contract = findContract(root)?.contract;
  return contract?.fast ?? contract?.test ?? 'npm run fast';
}

function taskRecordBrief(root: string, id: string): string {
  const task = getTask(root, id);
  return [
    `Task ${task.id}: ${task.title}`,
    '',
    ...task.body,
    '',
    `Deliver this task in the current worktree: commit with a "Ticket: ${task.id}" trailer and close the task with \`bin/krn task close ${task.id} --as done --note ...\` in the same commit. The commit title is \`type(scope): outcome (${task.id})\`. Run \`${checkCommand(root)}\` and fix what it reports before you finish; the caller ships only a tree it passed on. Do not push or open a pull request; the caller ships the commit.`,
  ].join('\n');
}

/** The session prompt for a repository without a tracker: the goal text instead of a task record. */
export function goalBrief(
  root: string,
  goal: string,
  asOf = new Date().toISOString().slice(0, 10),
): string {
  return laneBriefText(
    root,
    [
      goal.trim(),
      '',
      `Deliver this goal in the current worktree: commit with a title \`type(scope): outcome\`. Run \`${checkCommand(root)}\` and fix what it reports before you finish; the caller ships only a tree it passed on. Do not push or open a pull request; the caller ships the commit.`,
    ].join('\n'),
    asOf,
  );
}

/** A lane slug from the goal's first words. */
export function goalSlug(goal: string): string {
  const slug = goal
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-+/u, '')
    .slice(0, 40)
    .replace(/-+$/u, '');
  return `goal-${slug || 'lane'}`;
}

/** The session prompt: the packet `krn lane brief --task ID` prints (ADR 0002, FR-40), then the task record. */
export function taskBrief(
  root: string,
  id: string,
  asOf = new Date().toISOString().slice(0, 10),
): string {
  return laneBriefText(root, taskRecordBrief(root, id), asOf, id);
}

const defaultSteps: LaneRunSteps = {
  start: async (args) => (await import('./lane.ts')).startLane(args),
  ship: (args) => shipCommand(args),
  mint: async (env) => {
    const result = spawnSync(process.execPath, [tokenHelper, 'token'], {
      encoding: 'utf8',
      // The mint runs outside the sandbox, so it may reach the vault; the lane class would make it cache-only.
      env: {
        ...env,
        KRN_SESSION_CLASS: undefined as string | undefined,
        KRN_APP_REUSE_MARGIN_SECONDS: String(tokenMinimumRemainingSeconds),
      },
      timeout: 30000,
    });
    if (result.status === 0) return undefined;
    return (
      result.stderr?.trim().split('\n')[0] ||
      result.error?.message ||
      `token helper exited with status ${result.status}`
    );
  },
};

/** The worktree a failed run left behind, when it is the lane's own; anything else is a usage error. */
function reusableLane(
  path: string,
  slug: string,
): { path: string; slug: string } {
  const branch = spawnSync(
    'git',
    ['-C', path, 'rev-parse', '--abbrev-ref', 'HEAD'],
    { encoding: 'utf8' },
  );
  if (branch.status !== 0 || branch.stdout.trim() !== slug)
    throw new CliUsageError(
      `${path} exists but is not lane ${slug}'s worktree`,
    );
  return { path, slug };
}

/** Reuse the worktree a failed run left and take its claim again. */
async function reclaimLane(
  main: string,
  path: string,
  slug: string,
  task: string,
  actor: string,
): Promise<{ path: string; slug: string }> {
  const lane = reusableLane(path, slug);
  await claimTask(main, task, {
    actor,
    worktree: path,
    reason: `lane ${slug}`,
  });
  return lane;
}

/** Kill every process the session left in its own process group (a Bash child can outlive claude). */
function killGroup(pid: number | undefined): void {
  if (pid === undefined || pid <= 0) return;
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    /* The group is already gone. */
  }
}

const laneRunUsage =
  'krn lane run (--task ID | --goal TEXT) [--slug SLUG] [--actor NAME] [--model MODEL] [--root DIR]';

/** The PR body of a goal lane: no task record, so the goal is the problem and the outcome. */
function goalPrBody(
  goal: string,
  commits: readonly string[],
  verified: string,
): string {
  return `## Problem\n\n${goal.trim()}\n\n## Change\n\n${commits.map((line) => `- ${line}`).join('\n')}\n\n## Verification\n\n${verified}\n`;
}

/**
 * The runner's own proof where the repository has no fast-pass marker: the contract's quick
 * check (else its tests) passes on the final tree.
 */
export function contractVerification(worktree: string): string | undefined {
  const contract = findContract(worktree)?.contract;
  if (contract === undefined) return undefined;
  const command = contract.fast ?? contract.test;
  const run = spawnSync(command, {
    cwd: worktree,
    shell: true,
    stdio: 'ignore',
    timeout: 30 * 60 * 1000,
  });
  return run.status === 0 ? `${command} PASS on the final tree` : undefined;
}

export async function laneRunCommand(
  args: string[],
  steps: LaneRunSteps = defaultSteps,
): Promise<LaneVerdict> {
  let task: string | undefined;
  let goal: string | undefined;
  let slug: string | undefined;
  let actor: string | undefined;
  let root: string | undefined;
  let model = defaultLaneModel;
  const value = (index: number, name: string) =>
    flagValue(args, index, () => new CliUsageError(`${name} requires a value`));
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] as string;
    if (arg === '--task') task = value(index++, arg);
    else if (arg === '--goal') goal = value(index++, arg);
    else if (arg === '--slug') slug = value(index++, arg);
    else if (arg === '--actor') actor = value(index++, arg);
    else if (arg === '--root') root = value(index++, arg);
    else if (arg === '--model') model = value(index++, arg);
    else throw new CliUsageError(laneRunUsage);
  }
  const origin = repositoryRoot(root ?? process.cwd());
  const tracker = contractTracker(origin);
  if (goal !== undefined) {
    if (task !== undefined)
      throw new CliUsageError('--goal and --task exclude each other');
    if (tracker !== 'none')
      throw new CliUsageError(
        'this repository tracks work in tasks/: pass --task ID, not --goal',
      );
    if (goal.trim() === '') throw new CliUsageError('--goal needs text');
  } else if (task === undefined || !isTaskId(task))
    throw new CliUsageError(
      tracker === 'none'
        ? `--goal TEXT names the work in a repository without a tracker: ${laneRunUsage}`
        : `--task needs a task id: ${task ?? ''}`,
    );
  const lane = slug ?? task ?? goalSlug(goal ?? '');
  const label = task ?? lane;
  const main = mainCheckoutRoot(origin);
  const base = contractBase(origin);
  // krn pr ship opens the PR against main; another base waits on t-asa2qhx, so no session is spent first.
  if (base !== 'main')
    return {
      line: `lane ${label}: base ${base} cannot ship yet: krn pr ship targets main (t-asa2qhx)`,
      exitCode: exitNoDelivery,
    };
  const brief =
    task === undefined
      ? goalBrief(origin, goal ?? '')
      : taskBrief(origin, task);

  const environment = sessionEnvironment(
    process.env,
    join(main, '.krn', 'tmp', 'app-cache'),
    task === undefined ? { lane } : { lane, task },
  );
  const unavailable = await steps.mint(environment);
  if (unavailable !== undefined)
    return {
      line: `lane ${label}: GitHub App credential unavailable (${unavailable})`,
      exitCode: exitCredentialUnavailable,
    };

  const existing = join(main, '.krn', 'worktrees', lane);
  const holder = actor ?? `lane-${lane}`;
  // A rerun after a failed run reuses its worktree and branch; the failed run released the claim.
  const started = existsSync(existing)
    ? task === undefined
      ? reusableLane(existing, lane)
      : await reclaimLane(main, existing, lane, task, holder)
    : await steps.start([
        lane,
        ...(task === undefined ? [] : ['--task', task]),
        '--actor',
        holder,
        '--root',
        origin,
      ]);
  const claude = process.env.KRN_LANE_CLAUDE ?? 'claude';
  // Node's spawnSync honours `detached` (a new session and process group) though its types omit it.
  const sessionOptions = {
    cwd: started.path,
    encoding: 'utf8' as const,
    maxBuffer: 64 * 1024 * 1024,
    env: environment,
    timeout: sessionTimeoutMs(process.env),
    killSignal: 'SIGKILL' as const,
    // Its own process group, so the timeout kills the session's children with it.
    detached: true,
  };
  const session = spawnSync(
    claude,
    [
      '-p',
      brief,
      '--output-format',
      'json',
      '--settings',
      join(started.path, '.claude', 'settings.sandbox.json'),
      '--permission-mode',
      'acceptEdits',
      '--model',
      model,
    ],
    sessionOptions,
  );
  killGroup(session.pid);
  const timedOut =
    (session.error as NodeJS.ErrnoException | undefined)?.code === 'ETIMEDOUT';
  const result = timedOut
    ? {
        ok: false,
        detail: `session timeout after ${Math.round(sessionTimeoutMs(process.env) / 1000)}s (capped below the App token lifetime)`,
        cost: undefined,
      }
    : session.error !== undefined
      ? {
          ok: false,
          detail: `session did not run: ${session.error.message}`,
          cost: undefined,
        }
      : parseSessionResult(session.stdout ?? '');
  const spent =
    result.cost === undefined ? '' : ` cost $${result.cost.toFixed(2)}`;
  const kept = `worktree ${started.path}, rerun reuses it`;
  // A failed run keeps its worktree as evidence and frees the task for a retry.
  const stop = async (
    reason: string,
    exitCode = exitNoDelivery,
  ): Promise<LaneVerdict> => {
    if (task !== undefined)
      try {
        await releaseClaim(main, task);
      } catch {
        /* No claim left to release. */
      }
    return {
      line: `lane ${label}: ${reason} (${kept}${task === undefined ? '' : ', claim released'}) model ${model}${spent}`,
      exitCode,
    };
  };

  if (!result.ok)
    return await stop(
      result.detail,
      session.error !== undefined && !timedOut
        ? exitCredentialUnavailable
        : exitNoDelivery,
    );
  // Taken before the placeholders go: the fast-pass key was written with them in the tree.
  const verified =
    sessionVerification(started.path) ?? contractVerification(started.path);
  for (const path of sandboxPlaceholders(
    git(started.path, ['status', '--porcelain', '-z', '--untracked-files=all']),
    (file) => lstatSync(join(started.path, file)),
  ))
    rmSync(join(started.path, path));
  if (git(started.path, ['status', '--porcelain']) !== '')
    return await stop('dirty tree');
  const range = `origin/${base}..HEAD`;
  const commits = git(started.path, ['log', '--format=%s', range])
    .split('\n')
    .filter((line) => line !== '');
  if (commits.length === 0) return await stop('no commit');
  const title =
    task === undefined
      ? commits[commits.length - 1]
      : ticketCommitTitle(
          git(started.path, [
            'log',
            '--format=%s%x1f%(trailers:key=Ticket,valueonly,separator=%x2C)%x1e',
            range,
          ]),
          task,
        );
  if (title === undefined)
    return await stop(`no commit with a Ticket: ${task} trailer`);
  if (task !== undefined && getTask(started.path, task).status !== 'closed')
    return await stop('task not closed');
  if (verified === undefined)
    return await stop('no passing check on the final tree');

  const bodyDir = join(main, '.krn', 'tmp');
  mkdirSync(bodyDir, { recursive: true });
  const bodyFile = join(bodyDir, `lane-run-${lane}.md`);
  writeFileSync(
    bodyFile,
    task === undefined
      ? goalPrBody(goal ?? '', commits, verified)
      : renderPrBody({
          task: getTask(started.path, task),
          commits,
          verified,
          agent: `headless claude session ${result.detail}`,
          refs: false,
        }),
  );
  const shipped = await steps.ship([
    '--worktree',
    started.path,
    '--title',
    title,
    '--body-file',
    bodyFile,
  ]);
  const last = shipped.trim().split('\n').pop() ?? '';
  const merged = /^verdict: merged\b/u.test(last);
  return {
    line: `lane ${label}: ${merged ? 'shipped' : 'not merged'} ${last} model ${model}${spent}`,
    exitCode: merged ? 0 : exitNoDelivery,
  };
}
