import { flagValue } from '../../cli-kit/flag-value.ts';
import { CliUsageError } from '../../cli-kit/usage-error.ts';
import { readyTasks } from '../../task/claims.ts';
import { repositoryRoot } from '../../task/store.ts';
import {
  exitAppNotInstalled,
  exitMintFailed,
  exitVaultShort,
} from '../doctor-unattended.ts';
import type { LaneVerdict } from './steps.ts';

export const drainUsage =
  'krn lane run --ready --max N [--actor NAME] [--model MODEL] [--root DIR] [--window-hours N]';

/** Exits of the host, not of the task: the doctor's mint (69), vault (75) and App install (67) codes and the ship push failure (70). A task that ends in one says nothing about the next task; two in a row mean every queued task would fail the same way. */
export const infrastructureExits: readonly number[] = [
  exitAppNotInstalled,
  exitMintFailed,
  70,
  exitVaultShort,
];

/** Consecutive infrastructure-class failures with the same exit that stop the drain. */
export const infrastructureStreakLimit = 2;

export interface DrainRequest {
  max: number;
  /** The flags a single-task run takes besides the task: `--actor`, `--model`, `--root`. */
  passthrough: string[];
  root: string | undefined;
  /** The vault window `doctor --unattended` requires, in hours; undefined keeps the doctor default. */
  windowHours?: string | undefined;
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
  let windowHours: string | undefined;
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
    } else if (arg === '--window-hours') {
      windowHours = value(index++, arg);
      if (!/^\d+(\.\d+)?$/u.test(windowHours) || Number(windowHours) <= 0)
        throw new CliUsageError(
          `--window-hours needs a positive number: ${windowHours}`,
        );
    } else if (arg === '--root') {
      root = value(index++, arg);
      passthrough.push(arg, root);
    } else if (arg === '--actor' || arg === '--model')
      passthrough.push(arg, value(index++, arg));
    else throw new CliUsageError(drainUsage);
  }
  if (max === undefined)
    throw new CliUsageError(`--ready needs --max N: ${drainUsage}`);
  return { max, passthrough, root, windowHours };
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

/** The `doctor --unattended` arguments of a drain: the window and the target repository root. */
export function doctorArgs(windowHours?: string, root?: string): string[] {
  return [
    '--unattended',
    ...(windowHours === undefined ? [] : ['--window-hours', windowHours]),
    ...(root === undefined ? [] : ['--root', root]),
  ];
}

export async function defaultDoctor(
  windowHours?: string,
  root?: string,
): Promise<DrainSeams['doctor']> {
  const { unattendedReport } = await import('../doctor-unattended.ts');
  return () => unattendedReport(doctorArgs(windowHours, root));
}

export interface DrainResult {
  lines: string[];
  exitCode: number;
}

/**
 * Deliver ready tasks one after another: the doctor check first (a failure stops before any
 * claim), then up to `max` single-task runs, one summary line each. It stops early when the
 * queue is empty or two consecutive runs end with the same infrastructure-class exit (see
 * `infrastructureExits`); task-class failures never stop it. The exit is 0 only when no run failed, else the exit of the last failure; a line names every failed task.
 */
export async function drainReady(
  request: DrainRequest,
  seams: DrainSeams,
  emit: (line: string) => void = () => undefined,
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
  let lastInfrastructure = 0;
  let streak = 0;
  let exitCode = 0;
  const failed: string[] = [];
  let summarised = false;
  const summarise = () => {
    if (failed.length === 0 || summarised) return;
    summarised = true;
    say(`drain: failed ${failed.join(', ')}`);
  };
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
    // The verdict line carries the merge or the blocker's reason; an unattended drain has no other record of it.
    say(verdict.line);
    if (verdict.proof !== undefined) say(verdict.proof);
    if (verdict.exitCode !== 0) {
      exitCode = verdict.exitCode;
      failed.push(`${id} (exit ${verdict.exitCode})`);
    }
    if (!infrastructureExits.includes(verdict.exitCode)) {
      streak = 0;
      lastInfrastructure = 0;
      continue;
    }
    streak = verdict.exitCode === lastInfrastructure ? streak + 1 : 1;
    lastInfrastructure = verdict.exitCode;
    if (streak >= infrastructureStreakLimit) {
      summarise();
      say(`drain: stopped, infrastructure ${verdict.exitCode} twice`);
      break;
    }
  }
  summarise();
  return { lines, exitCode };
}
