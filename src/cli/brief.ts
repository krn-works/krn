import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { checkBrief } from '../brief/index.ts';
import { CliUsageError } from './usage-error.ts';

export function briefCommand(args: readonly string[]): void {
  const [command, brief, flag, checklist] = args;
  if (
    command !== 'check' ||
    !brief ||
    brief.startsWith('--') ||
    (args.length !== 2 &&
      (args.length !== 4 ||
        flag !== '--checklist' ||
        !checklist ||
        checklist.startsWith('--')))
  )
    throw new CliUsageError(
      'Usage: krn brief check <brief> [--checklist <path>]',
    );
  if (
    [brief, checklist].some(
      (path) => path !== undefined && /[\p{Cc}]/u.test(path),
    )
  )
    throw new CliUsageError(
      'brief and checklist paths must not contain control characters',
    );
  let path = checklist;
  if (path === undefined) {
    const result = spawnSync('git', ['rev-parse', '--show-toplevel'], {
      encoding: 'utf8',
    });
    if (result.error) throw result.error;
    if (result.status !== 0)
      throw new CliUsageError(
        'cannot locate the default checklist outside a git repository; use --checklist',
      );
    path = join(result.stdout.trim(), 'docs/program/hardening-checklist.md');
  }
  const reasons = checkBrief(brief, path);
  process.stdout.write(`${reasons.length ? 'FAIL' : 'PASS'} ${brief}\n`);
  if (reasons.length) process.stderr.write(`${reasons.join('\n')}\n`);
  process.exitCode = reasons.length ? 65 : 0;
}
