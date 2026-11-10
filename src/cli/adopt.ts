// `krn adopt <path>`: write the adoption set into a named repository.
import { resolve } from 'node:path';
import { adopt } from '../adopt/adopt.ts';
import { flagValue } from './flag-value.ts';
import { CliUsageError } from './usage-error.ts';

export const adoptUsage =
  'krn adopt <path> --ref SHA [--install CMD] [--lint CMD] [--typecheck CMD] [--test CMD]  write tasks/, the generated rules block in AGENTS.md (CLAUDE.md links to it), .krn/ in .gitignore and the .github/workflows/ci.yml call of the shared project CI at SHA into the git repository at <path>; reruns change nothing';

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
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] as string;
    if ((flags as readonly string[]).includes(arg)) {
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
  if (values.ref === undefined)
    throw new CliUsageError('--ref SHA is required');
  const root = resolve(path);
  let report: ReturnType<typeof adopt>;
  try {
    report = adopt(root, { ...values, ref: values.ref });
  } catch (error) {
    throw new CliUsageError(
      error instanceof Error ? error.message : String(error),
    );
  }
  for (const file of report.written) process.stdout.write(`wrote ${file}\n`);
  for (const file of report.unchanged)
    process.stdout.write(`unchanged ${file}\n`);
}
