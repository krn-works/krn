// What the terminal host adapters share about a failed call: the shape of the
// failure, kept as data so the caller decides what to print and exit with.

import type { CommandResult } from './command.ts';
import type { HostFailure } from './terminal-host.ts';

export function succeeded(result: CommandResult): boolean {
  return result.status === 0 && !result.error;
}

export function failureOf(result: CommandResult, reason: string): HostFailure {
  let stderr = '';
  let exit = 1;
  if (result.error) stderr = `${result.error.message}\n`;
  else {
    stderr = result.stderr;
    if (result.status !== null && result.status !== 0) {
      if (!result.stderr)
        stderr = `command exited with status ${result.status}\n`;
      exit = result.status;
    }
  }
  return { exit, stderr, reason };
}
