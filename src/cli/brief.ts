import { spawnSync } from 'node:child_process';
import { join, matchesGlob } from 'node:path';
import { checkBrief, readRegularFile } from '../brief/index.ts';
import { BriefSectionsError, briefSections } from '../brief/sections.ts';
import { loadPolicy } from '../worker/scope.ts';
import { CliUsageError } from './usage-error.ts';

export function briefCommand(args: readonly string[]): void {
  const [command, brief, ...options] = args;
  if (
    !brief ||
    brief.startsWith('--') ||
    !['check', 'lens'].includes(command ?? '')
  )
    throw new CliUsageError(
      'Usage: krn brief check <brief> [--checklist <path>] [--repo <dir>] [--model <id>] | lens <brief>',
    );
  const flags = new Map<string, string>();
  for (let i = 0; i < options.length; i += 2) {
    const flag = options[i];
    const value = options[i + 1];
    if (
      command === 'lens' ||
      !flag ||
      !['--checklist', '--repo', '--model'].includes(flag) ||
      !value ||
      value.startsWith('--') ||
      flags.has(flag)
    )
      throw new CliUsageError('invalid brief options');
    flags.set(flag, value);
  }
  const checklist = flags.get('--checklist');
  if ([brief, ...flags.values()].some((path) => /[\p{Cc}]/u.test(path)))
    throw new CliUsageError(
      'brief and checklist paths must not contain control characters',
    );
  if (command === 'lens') {
    try {
      const { settled } = briefSections(
        readRegularFile(brief, 256 * 1024, 'brief'),
      );
      if (settled === undefined)
        throw new Error('missing Settled decisions section');
      process.stdout.write(
        'Settled decisions (verbatim from the brief; do not re-decide or flag them):\n' +
          settled,
      );
    } catch (error) {
      process.stderr.write(
        `${error instanceof BriefSectionsError ? error.reasons.join('\n') : error instanceof Error && !('code' in error) ? error.message : 'brief cannot be read'}\n`,
      );
      process.exitCode = 65;
    }
    return;
  }
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
  let sections: ReturnType<typeof briefSections> | undefined;
  const repo = flags.get('--repo');
  if (repo !== undefined) {
    try {
      sections = briefSections(readRegularFile(brief, 256 * 1024, 'brief'));
      if (!sections.allowed) reasons.push('missing Allowed paths section');
      const policy = loadPolicy(repo, 'HEAD');
      for (const entry of sections.allowed ?? [])
        for (const glob of policy.forbidden)
          if (matchesGlob(entry.path, glob))
            reasons.push(
              `${entry.path} is forbidden by spec/worker-scope.json (${glob})`,
            );
      if (!sections.observer) reasons.push('missing Proof observer');
      if (!sections.steps?.length) reasons.push('missing Steps');
      else if (
        !sections.observer ||
        !sections.steps[0]?.includes(sections.observer) ||
        !/\bred\b/iu.test(sections.steps[0] ?? '')
      )
        reasons.push('first step must contain the Proof observer and red');
    } catch (error) {
      reasons.push(
        ...(error instanceof BriefSectionsError
          ? error.reasons
          : [
              error instanceof Error && !('code' in error)
                ? error.message
                : 'brief cannot be read',
            ]),
      );
    }
  }
  reasons.splice(64);
  process.stdout.write(`${reasons.length ? 'FAIL' : 'PASS'} ${brief}\n`);
  if (reasons.length) process.stderr.write(`${reasons.join('\n')}\n`);
  else if (sections) {
    const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
    const argv = (sections.allowed ?? []).flatMap((entry) => [
      `--allow ${quote(entry.path)}`,
      ...(entry.isNew ? [`--require ${quote(entry.path)}`] : []),
    ]);
    argv.push(`--observer ${quote(sections.observer ?? '')}`);
    process.stdout.write(`argv: ${argv.join(' ')}\n`);
  }
  const count =
    sections?.allowed?.filter((entry) => !entry.path.startsWith('test/'))
      .length ?? 0;
  if (flags.get('--model') === 'gpt-6-luna' && count > 3)
    process.stderr.write(
      `WARN route: ${count} non-test paths; use gpt-6.1-sol\n`,
    );
  process.exitCode = reasons.length ? 65 : 0;
}
