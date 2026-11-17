// Child process helpers shared by the successor modules.

import { spawnSync } from 'node:child_process';

export type CommandResult = {
  status: number | null;
  stdout: string;
  stderr: string;
  error?: Error;
};

export function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

export function run(
  command: string,
  args: string[],
  cwd = process.cwd(),
  timeout = 15000,
  env?: NodeJS.ProcessEnv,
): CommandResult {
  const result = spawnSync(command, args, {
    cwd,
    ...(env ? { env } : {}),
    encoding: 'utf8',
    timeout,
  });
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    ...(result.error ? { error: result.error } : {}),
  };
}

export function sleep(seconds: number): void {
  if (seconds > 0)
    Atomics.wait(
      new Int32Array(new SharedArrayBuffer(4)),
      0,
      0,
      seconds * 1000,
    );
}

// Writes what a failed command said and answers the exit code to end with.
export function exitFailure(result: CommandResult): number {
  if (result.error) {
    process.stderr.write(`${result.error.message}\n`);
    return 1;
  }
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.status !== null && result.status !== 0) {
    if (!result.stderr)
      process.stderr.write(`command exited with status ${result.status}\n`);
    return result.status;
  }
  return 1;
}

const SHELLS = new Set(['bash', 'sh', 'zsh', 'dash']);

// Whether the process has a live child shell doing work (a background job),
// which the host cannot list as a foreground process: the answer comes from
// the process table. A shell whose only children are `sleep` is a waiter (a
// poll loop between probes) and holds no work: a done predecessor kept a
// `until ...; do sleep 3; done` loop for eight hours and retire never closed
// it (t-r53fan0).
export function hasChildShell(pid: number): boolean {
  for (const child of childrenOf(pid))
    if (SHELLS.has(child.command) && !waiting(child.pid)) return true;
  return false;
}

function childrenOf(pid: number): Array<{ pid: string; command: string }> {
  const children = run('ps', ['-o', 'pid=,comm=', '--ppid', String(pid)]);
  const found = [];
  for (const line of children.stdout.split('\n')) {
    const words = line.trim().split(/\s+/u);
    const command = words.pop();
    const child = words[0];
    if (command && child) found.push({ pid: child, command });
  }
  return found;
}

// A sample between two probes can show no child at all, so only a shell
// caught in `sleep` counts as waiting.
function waiting(shellPid: string): boolean {
  if (!/^\d+$/u.test(shellPid)) return false;
  const children = childrenOf(Number(shellPid));
  return (
    children.length > 0 && children.every((child) => child.command === 'sleep')
  );
}

/** Whether a program name is an interactive shell. */
export function isShell(name: string): boolean {
  return SHELLS.has(name);
}
