#!/usr/bin/env node
// Host-wide heavy-job gate: `run -- <command>` waits for a weighted slot shared by every project, then runs the command.
import { spawn } from 'node:child_process';
import { constants } from 'node:os';
import { flagValue } from '../../src/cli-kit/flag-value.ts';
import {
  gateLimits,
  hostGateDir,
  hostPressure,
  hostUnits,
  SLOT_HELD_ENV,
  sampleHost,
} from '../../src/repo/host-gate.ts';
import {
  SLOT_TIMEOUT_EXIT,
  SlotTimeoutError,
  slotHolders,
  withSlot,
} from '../../src/repo/slot-lock.ts';

const USAGE = `usage: heavy-gate run [--weight N] [--deadline-ms N [--soft]] -- <command> [args...]
       heavy-gate status [--json]
`;

class Usage extends Error {}

/** Default weight of a foreign heavy job: a quarter of the host, so four run at once on an idle host. */
export function defaultJobWeight(units: number): number {
  return Math.max(1, Math.round(units / 4));
}

type RunArgs = {
  weight: number | undefined;
  deadlineMs: number | undefined;
  /** Past the deadline, run without a slot instead of exiting 75 (a scheduled job that must not miss its cycle). */
  soft: boolean;
  command: string[];
};

export function parseRun(args: readonly string[]): RunArgs {
  const parsed: RunArgs = {
    command: [],
    deadlineMs: undefined,
    soft: false,
    weight: undefined,
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--') {
      parsed.command = args.slice(index + 1);
      break;
    }
    const value = () => {
      const text = flagValue(
        args,
        index,
        () => new Usage(`${arg} needs a value`),
      );
      index += 1;
      const number = Number(text);
      if (!Number.isInteger(number) || number <= 0)
        throw new Usage(`${arg} needs a positive integer, got ${text}`);
      return number;
    };
    if (arg === '--soft') parsed.soft = true;
    else if (arg === '--weight') parsed.weight = value();
    else if (arg === '--deadline-ms') parsed.deadlineMs = value();
    else throw new Usage(`unknown argument ${arg}`);
  }
  if (parsed.command.length === 0) throw new Usage('run needs -- <command>');
  if (parsed.soft && parsed.deadlineMs === undefined)
    throw new Usage('--soft needs --deadline-ms');
  return parsed;
}

/** Runs the command with inherited stdio, forwarding termination signals; resolves to its exit code (128+n for a signal). */
function runChild(command: string[], env: NodeJS.ProcessEnv): Promise<number> {
  return new Promise((resolve) => {
    const [file, ...rest] = command;
    const child = spawn(file ?? '', rest, { env, stdio: 'inherit' });
    const forward = (signal: NodeJS.Signals) => child.kill(signal);
    const signals: NodeJS.Signals[] = ['SIGINT', 'SIGTERM', 'SIGHUP'];
    for (const signal of signals) process.on(signal, forward);
    const done = (code: number) => {
      for (const signal of signals) process.off(signal, forward);
      resolve(code);
    };
    child.on('error', (error) => {
      process.stderr.write(`heavy-gate: ${file}: ${error.message}\n`);
      done(127);
    });
    child.on('exit', (code, signal) =>
      done(code ?? 128 + (signal ? constants.signals[signal] : 0)),
    );
  });
}

export async function run(
  args: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): Promise<number> {
  const parsed = parseRun(args);
  const childEnv = { ...env, [SLOT_HELD_ENV]: '1' };
  // A job already inside a slot (fast, a wrapped test run) runs its nested heavy commands in that slot.
  if (env[SLOT_HELD_ENV]) return runChild(parsed.command, childEnv);
  const units = hostUnits(env);
  const started = Date.now();
  try {
    return await withSlot(
      {
        deadlineMs: parsed.deadlineMs,
        dir: hostGateDir(env),
        onWait: (pid, reason) =>
          process.stderr.write(
            `heavy-gate: waiting for a host slot (${reason}${pid ? `, held by pid ${pid}` : ''})\n`,
          ),
        pressure: (admission) =>
          hostPressure(sampleHost(), gateLimits(env), admission),
        slots: units,
        weight: parsed.weight ?? defaultJobWeight(units),
      },
      () => {
        const waited = (Date.now() - started) / 1000;
        if (waited >= 1)
          process.stderr.write(
            `heavy-gate: got a slot after ${waited.toFixed(1)}s\n`,
          );
        return runChild(parsed.command, childEnv);
      },
    );
  } catch (error) {
    if (!(error instanceof SlotTimeoutError)) throw error;
    if (parsed.soft) {
      process.stderr.write(
        `heavy-gate: ${error.message}; --soft: running without a slot\n`,
      );
      return runChild(parsed.command, env);
    }
    process.stderr.write(
      `heavy-gate: ${error.message}; the host stayed busy: nothing ran, rerun the command later or in the background\n`,
    );
    return SLOT_TIMEOUT_EXIT;
  }
}

export function status(
  args: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): string {
  const holders = slotHolders(hostGateDir(env));
  const sample = sampleHost();
  const report = {
    capacity: hostUnits(env),
    dir: hostGateDir(env),
    holders,
    pressure: hostPressure(sample, gateLimits(env)) ?? null,
    sample,
    used: holders.reduce((sum, entry) => sum + entry.weight, 0),
  };
  if (args.includes('--json')) return `${JSON.stringify(report)}\n`;
  const lines = [
    `heavy-gate: ${report.used}/${report.capacity} units held by ${holders.length} job(s); load ${sample.load1.toFixed(1)} on ${sample.cores} cores, ${sample.availableMb} MB available${report.pressure ? `; waiting jobs: ${report.pressure}` : ''}`,
    ...holders.map((entry) => `  pid ${entry.pid} weight ${entry.weight}`),
  ];
  return `${lines.join('\n')}\n`;
}

async function main(argv: readonly string[]): Promise<number> {
  const [command, ...rest] = argv;
  try {
    if (command === 'run') return await run(rest);
    if (command === 'status') {
      process.stdout.write(status(rest));
      return 0;
    }
    throw new Usage(command ? `unknown command ${command}` : 'missing command');
  } catch (error) {
    if (!(error instanceof Usage)) throw error;
    process.stderr.write(`heavy-gate: ${error.message}\n${USAGE}`);
    return 64;
  }
}

if (import.meta.main) process.exitCode = await main(process.argv.slice(2));
