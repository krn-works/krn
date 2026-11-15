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

// Whether the process has a live child shell (a background monitor), which the
// host cannot list as a foreground process: the answer comes from the process table.
export function hasChildShell(pid: number): boolean {
  const children = run('ps', ['-o', 'pid=,comm=', '--ppid', String(pid)]);
  for (const line of children.stdout.split('\n')) {
    const command = line.trim().split(/\s+/u).pop();
    if (command && SHELLS.has(command)) return true;
  }
  return false;
}

/** Whether a program name is an interactive shell. */
export function isShell(name: string): boolean {
  return SHELLS.has(name);
}
