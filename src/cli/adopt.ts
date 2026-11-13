// `krn adopt <path>`: write the adoption set into a named repository.
import { resolve } from 'node:path';
import { adopt } from '../adopt/adopt.ts';
import { flagValue } from './flag-value.ts';
import { CliUsageError } from './usage-error.ts';

export const adoptUsage =
  'krn adopt <path> [--tracker] [--ref SHA [--install CMD] [--lint CMD] [--typecheck CMD]] [--test CMD]  write krn.json from detection (kept when present), the .claude/settings.json Stop hook calling `krn hook stop`, the generated rules block in AGENTS.md (CLAUDE.md links to it) and .krn/ in .gitignore into the git repository at <path>; --tracker seeds tasks/; --ref SHA also seeds tasks/, writes the call of the shared project CI at SHA to .github/workflows/ci.yml (krn-ci.yml beside a ci.yml of its own) and spec/ci-admission.json selecting the required `ci / Check`; reruns change nothing';

const switches = ['--tracker'] as const;
const flags = [
  '--ref',
  '--install',
  '--lint',
  '--typecheck',
  '--test',
] as const;

export function adoptCommand(args: string[]): void {
  let path: string | undefined;
  const values: Record<string, string> = {};
  let tracker = false;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] as string;
    if ((switches as readonly string[]).includes(arg)) tracker = true;
    else if ((flags as readonly string[]).includes(arg)) {
      values[arg.slice(2)] = flagValue(
        args,
        i,
        () => new CliUsageError(`${arg} needs a value`),
      );
      i += 1;
    } else if (arg.startsWith('--'))
      throw new CliUsageError(`unknown flag ${arg}`);
    else if (path === undefined) path = arg;
    else throw new CliUsageError('krn adopt takes one path');
  }
  if (path === undefined) throw new CliUsageError(adoptUsage);
  const root = resolve(path);
  let report: ReturnType<typeof adopt>;
  try {
    report = adopt(root, { ...values, tracker });
  } catch (error) {
    throw new CliUsageError(
      error instanceof Error ? error.message : String(error),
    );
  }
  for (const file of report.written) process.stdout.write(`wrote ${file}\n`);
  for (const file of report.unchanged)
    process.stdout.write(`unchanged ${file}\n`);
  for (const file of report.skipped) process.stdout.write(`skipped ${file}\n`);
}
