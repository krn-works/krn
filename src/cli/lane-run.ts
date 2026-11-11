import { spawnSync } from 'node:child_process';
import { lstatSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { shipCommand } from '../ci/ship.ts';
import { mainCheckoutRoot } from '../task/claims.ts';
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

/** Operator credentials that never reach a lane session; only the App token does. */
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

const defaultSessionTimeoutMs = 2 * 60 * 60 * 1000;

/** The longest a claude session may run: KRN_LANE_TIMEOUT_MS, else two hours. */
function sessionTimeoutMs(env: NodeJS.ProcessEnv): number {
  const value = Number(env.KRN_LANE_TIMEOUT_MS);
  return Number.isInteger(value) && value > 0 ? value : defaultSessionTimeoutMs;
}

const tokenHelper = fileURLToPath(
  new URL('../../scripts/github-app-token.ts', import.meta.url),
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
): NodeJS.ProcessEnv {
  const scrubbed: NodeJS.ProcessEnv = { ...env };
  for (const name of OPERATOR_CREDENTIAL_VARIABLES) delete scrubbed[name];
  const existing = Number(scrubbed.GIT_CONFIG_COUNT);
  const start = Number.isInteger(existing) && existing > 0 ? existing : 0;
  const key = 'credential.https://github.com.helper';
  return {
    ...scrubbed,
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

/** Read the JSON result of `claude -p --output-format json`. */
/**
 * The untracked empty regular files in `git status --porcelain -z` output: the placeholders the
 * harness sandbox mounts over write-denied paths (.env*, .npmrc, lockfiles). An untracked file is
 * never delivered, so removing an empty one loses nothing.
 */
export function sandboxPlaceholders(
  porcelain: string,
  stat: (path: string) => { isFile(): boolean; size: number },
): string[] {
  return porcelain
    .split('\0')
    .filter((entry) => entry.startsWith('?? '))
    .map((entry) => entry.slice(3))
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
      detail: 'session printed no JSON result',
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

function taskRecordBrief(root: string, id: string): string {
  const task = getTask(root, id);
  return [
    `Task ${task.id}: ${task.title}`,
    '',
    ...task.body,
    '',
    `Deliver this task in the current worktree: commit with a "Ticket: ${task.id}" trailer and close the task with \`bin/krn task close ${task.id} --as done --note ...\` in the same commit. Do not push or open a pull request; the caller ships the commit.`,
  ].join('\n');
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
      env,
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

export async function laneRunCommand(
  args: string[],
  steps: LaneRunSteps = defaultSteps,
): Promise<LaneVerdict> {
  let task: string | undefined;
  let slug: string | undefined;
  let actor: string | undefined;
  let root: string | undefined;
  const value = (index: number, name: string) =>
    flagValue(args, index, () => new CliUsageError(`${name} requires a value`));
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] as string;
    if (arg === '--task') task = value(index++, arg);
    else if (arg === '--slug') slug = value(index++, arg);
    else if (arg === '--actor') actor = value(index++, arg);
    else if (arg === '--root') root = value(index++, arg);
    else
      throw new CliUsageError(
        'krn lane run --task ID [--slug SLUG] [--actor NAME] [--root DIR]',
      );
  }
  if (task === undefined || !isTaskId(task))
    throw new CliUsageError(`--task needs a task id: ${task ?? ''}`);
  const lane = slug ?? task;
  const origin = repositoryRoot(root ?? process.cwd());
  const main = mainCheckoutRoot(origin);
  const brief = taskBrief(origin, task);

  const environment = sessionEnvironment(
    process.env,
    join(main, '.krn', 'tmp', 'app-cache'),
  );
  const unavailable = await steps.mint(environment);
  if (unavailable !== undefined)
    return {
      line: `lane ${task}: GitHub App credential unavailable (${unavailable})`,
      exitCode: exitCredentialUnavailable,
    };

  const started = await steps.start([
    lane,
    '--task',
    task,
    '--actor',
    actor ?? `lane-${lane}`,
    '--root',
    origin,
  ]);
  const claude = process.env.KRN_LANE_CLAUDE ?? 'claude';
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
    ],
    {
      cwd: started.path,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      env: environment,
      timeout: sessionTimeoutMs(process.env),
      killSignal: 'SIGKILL',
    },
  );
  const timedOut =
    (session.error as NodeJS.ErrnoException | undefined)?.code === 'ETIMEDOUT';
  const result = timedOut
    ? { ok: false, detail: 'session timeout', cost: undefined }
    : parseSessionResult(session.stdout ?? '');
  const spent =
    result.cost === undefined ? '' : ` cost $${result.cost.toFixed(2)}`;
  const kept = `worktree ${started.path}`;
  const stop = (reason: string): LaneVerdict => ({
    line: `lane ${task}: ${reason} (${kept})${spent}`,
    exitCode: exitNoDelivery,
  });

  if (!result.ok) return stop(result.detail);
  for (const path of sandboxPlaceholders(
    git(started.path, ['status', '--porcelain', '-z', '--untracked-files=all']),
    (file) => lstatSync(join(started.path, file)),
  ))
    rmSync(join(started.path, path));
  if (git(started.path, ['status', '--porcelain']) !== '')
    return stop('dirty tree');
  const commits = git(started.path, ['log', '--format=%s', 'origin/main..HEAD'])
    .split('\n')
    .filter((line) => line !== '');
  if (commits.length === 0) return stop('no commit');

  const title = commits[0] as string;
  const bodyDir = join(main, '.krn', 'tmp');
  mkdirSync(bodyDir, { recursive: true });
  const bodyFile = join(bodyDir, `lane-run-${lane}.md`);
  writeFileSync(
    bodyFile,
    renderPrBody({
      task: getTask(started.path, task),
      commits,
      verified: '',
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
  return { line: `lane ${task}: shipped ${last}${spent}`, exitCode: 0 };
}
