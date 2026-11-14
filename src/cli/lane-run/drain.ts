import { readyTasks } from '../../task/claims.ts';
import { repositoryRoot } from '../../task/store.ts';
import { flagValue } from '../flag-value.ts';
import { CliUsageError } from '../usage-error.ts';
import type { LaneVerdict } from './steps.ts';

export const drainUsage =
  'krn lane run --ready --max N [--actor NAME] [--model MODEL] [--root DIR]';

/** Two consecutive runs ending in this same non-zero exit stop the drain. */
export const repeatedClassLimit = 2;

export interface DrainRequest {
  max: number;
  /** The flags a single-task run takes besides the task: `--actor`, `--model`, `--root`. */
  passthrough: string[];
  root: string | undefined;
}

/** The seams of a drain: the doctor check, the ready order, one lane run and the clock. Tests replace them. */
export interface DrainSeams {
  doctor(): { text: string; exitCode: number };
  nextReady(
    root: string,
    skip: ReadonlySet<string>,
  ): Promise<string | undefined>;
  runTask(id: string, args: string[]): Promise<LaneVerdict>;
  now(): number;
}

export function parseDrainRequest(args: string[]): DrainRequest {
  let max: number | undefined;
  let root: string | undefined;
  const passthrough: string[] = [];
  const value = (index: number, name: string) =>
    flagValue(args, index, () => new CliUsageError(`${name} requires a value`));
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] as string;
    if (arg === '--ready') continue;
    if (arg === '--max') {
      const text = value(index++, arg);
      if (!/^[1-9]\d*$/u.test(text))
        throw new CliUsageError(`--max needs a positive integer: ${text}`);
      max = Number(text);
    } else if (arg === '--root') {
      root = value(index++, arg);
      passthrough.push(arg, root);
    } else if (arg === '--actor' || arg === '--model')
      passthrough.push(arg, value(index++, arg));
    else throw new CliUsageError(drainUsage);
  }
  if (max === undefined)
    throw new CliUsageError(`--ready needs --max N: ${drainUsage}`);
  return { max, passthrough, root };
}

export const defaultDrainSeams: DrainSeams = {
  doctor: () => ({ text: '', exitCode: 0 }),
  nextReady: async (root, skip) =>
    (await readyTasks(root)).tasks.find((task) => !skip.has(task.id))?.id,
  runTask: async (id, args) => {
    const { laneRunCommand } = await import('../lane-run.ts');
    return laneRunCommand(['--task', id, ...args]);
  },
  now: Date.now,
};

export async function defaultDoctor(): Promise<DrainSeams['doctor']> {
  const { unattendedReport } = await import('../doctor-unattended.ts');
  return () => unattendedReport(['--unattended']);
}

export interface DrainResult {
  lines: string[];
  exitCode: number;
}

/**
 * Deliver ready tasks one after another: the doctor check first (a failure stops before any
 * claim), then up to `max` single-task runs, one summary line each. It stops early when the
 * queue is empty or two consecutive runs end with the same non-zero exit. The exit is 0 when the
 * last run merged or nothing failed, else the exit of the last failure.
 */
export async function drainReady(
  request: DrainRequest,
  seams: DrainSeams,
  emit: (line: string) => void = () => {},
): Promise<DrainResult> {
  const lines: string[] = [];
  const say = (line: string) => {
    lines.push(line);
    emit(line);
  };
  const doctor = seams.doctor();
  if (doctor.exitCode !== 0) {
    say(
      `drain: doctor --unattended failed (exit ${doctor.exitCode}): ${doctor.text.trim()}`,
    );
    return { lines, exitCode: doctor.exitCode };
  }
  const root = repositoryRoot(request.root ?? process.cwd());
  const tried = new Set<string>();
  let lastFailure = 0;
  let streak = 0;
  let exitCode = 0;
  for (let run = 0; run < request.max; run += 1) {
    const id = await seams.nextReady(root, tried);
    if (id === undefined) {
      say('drain: no ready task left');
      break;
    }
    tried.add(id);
    const started = seams.now();
    const verdict = await seams.runTask(id, request.passthrough);
    const seconds = Math.round((seams.now() - started) / 1000);
    say(`${id} ${id} exit=${verdict.exitCode} ${seconds}s`);
    exitCode = verdict.exitCode;
    if (verdict.exitCode === 0) {
      streak = 0;
      lastFailure = 0;
      continue;
    }
    streak = verdict.exitCode === lastFailure ? streak + 1 : 1;
    lastFailure = verdict.exitCode;
    if (streak >= repeatedClassLimit) {
      say(`drain: stopped after ${streak} consecutive exit ${lastFailure}`);
      break;
    }
  }
  return { lines, exitCode };
}
