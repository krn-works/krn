// `krn adopt <path>`: write the adoption set into a named repository.
import { resolve } from 'node:path';
import { adopt } from '../adopt/adopt.ts';
import { runCanary } from '../adopt/canary.ts';
import { flagValue } from './flag-value.ts';
import { CliUsageError } from './usage-error.ts';

export const adoptUsage =
  'krn adopt <path> [--tracker] [--no-canary] [--ref SHA [--install CMD] [--lint CMD] [--typecheck CMD]] [--test CMD]  write krn.json from detection (kept when present), the .claude/settings.json Stop hook calling `krn hook stop`, the generated rules block in AGENTS.md (CLAUDE.md links to it) and .krn/ in .gitignore into the git repository at <path>; --tracker seeds tasks/; --ref SHA also seeds tasks/, writes the call of the shared project CI at SHA to .github/workflows/ci.yml (krn-ci.yml beside a ci.yml of its own) and spec/ci-admission.json selecting the required `ci / Check`; reruns change nothing; then the canary breaks one test in a temporary worktree of the base and requires the Stop gate to refuse it (exit 2) and to pass the restored tree, else adopt fails (--no-canary records the decline); `krn adopt <path> --canary` runs only the canary';

const switches = ['--tracker', '--canary', '--no-canary'] as const;
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
  const on = new Set<string>();
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] as string;
    if ((switches as readonly string[]).includes(arg)) on.add(arg);
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
  if (on.has('--canary') && on.has('--no-canary'))
    throw new CliUsageError('--canary and --no-canary exclude each other');
  const root = resolve(path);
  if (on.has('--canary')) {
    const result = runCanary(root);
    process.stdout.write(`canary ${result.outcome}: ${result.message}\n`);
    if (result.outcome !== 'pass') process.exitCode = 1;
    return;
  }
  const tracker = on.has('--tracker');
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
  if (on.has('--no-canary'))
    process.stdout.write(
      'canary declined (--no-canary): the Stop gate was not proven\n',
    );
  else {
    const result = runCanary(root);
    process.stdout.write(`canary ${result.outcome}: ${result.message}\n`);
    if (result.outcome !== 'pass')
      throw new CliUsageError(
        `adopt failed: the canary did not prove the Stop gate (${result.message}); the adoption files stay written, fix the cause (a repository without tests needs one test file, e.g. *.test.ts, test_*.py or *_test.go, and a test command) or pass --no-canary to decline`,
      );
  }
}
