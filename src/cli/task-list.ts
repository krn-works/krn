import { spawnSync } from 'node:child_process';
import { lstatSync } from 'node:fs';
import { join } from 'node:path';

function taskListError(message: string): Error & { exitCode: number } {
  const error = new Error(message) as Error & { exitCode: number };
  error.exitCode = 64;
  return error;
}

function validateOptions(args: string[]): boolean {
  let json = false;
  let statusSeen = false;
  for (let index = 0; index < args.length; index += 1) {
    const option = args[index];
    if (option === '--json') {
      if (json) throw taskListError('--json may be supplied once');
      json = true;
    } else if (option === '--status') {
      if (statusSeen) throw taskListError('--status may be supplied once');
      const value = args[index + 1];
      if (value === undefined || value.startsWith('--'))
        throw taskListError(`missing value for ${option}`);
      index += 1;
      if (value !== 'open' && value !== 'closed' && value !== 'all')
        throw taskListError('--status must be open, closed, or all');
      statusSeen = true;
    } else throw taskListError(`unknown list option "${option}"`);
  }
  return json;
}

function hasTaskDirectory(): boolean {
  const root = spawnSync(
    'git',
    ['-C', process.cwd(), 'rev-parse', '--show-toplevel'],
    { encoding: 'utf8' },
  );
  if (root.status !== 0) return true;
  try {
    lstatSync(join(root.stdout.trim(), 'tasks'));
    return true;
  } catch (error) {
    return !(
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      error.code === 'ENOENT'
    );
  }
}

export async function taskListCommand(args: string[]): Promise<void> {
  const json = validateOptions(args);
  if (!hasTaskDirectory()) {
    if (json) process.stdout.write('[]\n');
    return;
  }
  const { taskCommand } = await import('../task/cli.ts');
  taskCommand(['list', ...args]);
}
