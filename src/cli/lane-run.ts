import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { shipCommand } from '../ci/ship.ts';
import { mainCheckoutRoot } from '../task/claims.ts';
import { isTaskId } from '../task/record.ts';
import { getTask, repositoryRoot } from '../task/store.ts';
import { flagValue } from './flag-value.ts';
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
}

interface SessionResult {
  ok: boolean;
  detail: string;
  cost: number | undefined;
}

const exitNoDelivery = 74;

/** Read the JSON result of `claude -p --output-format json`. */
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

function taskBrief(root: string, id: string): string {
  const task = getTask(root, id);
  return [
    `Task ${task.id}: ${task.title}`,
    '',
    ...task.body,
    '',
    `Deliver this task in the current worktree: commit with a "Ticket: ${task.id}" trailer and close the task with \`bin/krn task close ${task.id} --as done --note ...\` in the same commit. Do not push or open a pull request; the caller ships the commit.`,
  ].join('\n');
}

const defaultSteps: LaneRunSteps = {
  start: async (args) => (await import('./lane.ts')).startLane(args),
  ship: (args) => shipCommand(args),
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
      '--permission-mode',
      'bypassPermissions',
    ],
    { cwd: started.path, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  );
  const result = parseSessionResult(session.stdout ?? '');
  const spent =
    result.cost === undefined ? '' : ` cost $${result.cost.toFixed(2)}`;
  const kept = `worktree ${started.path}`;
  const stop = (reason: string): LaneVerdict => ({
    line: `lane ${task}: ${reason} (${kept})${spent}`,
    exitCode: exitNoDelivery,
  });

  if (!result.ok) return stop(result.detail);
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
