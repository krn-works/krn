import { flagValue } from '../../cli-kit/flag-value.ts';
import { CliUsageError } from '../../cli-kit/usage-error.ts';
import { contractTracker } from '../../repo/contract.ts';
import { isTaskId } from '../../task/record.ts';
import { repositoryRoot } from '../../task/store.ts';
import { goalSlug } from './brief.ts';
import { defaultLaneModel } from './environment.ts';

export const laneRunUsage =
  'krn lane run (--task ID | --goal TEXT) [--slug SLUG] [--actor NAME] [--model MODEL] [--root DIR]';

/** What the operator asked for, validated: the work (a task or a goal), its lane name and model. */
export interface LaneRequest {
  task: string | undefined;
  goal: string | undefined;
  actor: string | undefined;
  model: string;
  origin: string;
  lane: string;
  label: string;
}

/** Stage one: read the flags and refuse a request that names no work or both kinds. */
export function parseLaneRequest(args: string[]): LaneRequest {
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
  return { task, goal, actor, model, origin, lane, label: task ?? lane };
}
