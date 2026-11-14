// `krn adopt <path>`: write the adoption set into a named repository.
import { resolve } from 'node:path';
import { adopt } from '../adopt/adopt.ts';
import { runCanary } from '../adopt/canary.ts';
import { verifyRepository } from '../adopt/verify.ts';
import { StandardsDataError } from '../brain/standards.ts';
import { StandardsInputError } from '../brain/standards-cli.ts';
import { flagValue } from './flag-value.ts';
import { CliUsageError } from './usage-error.ts';

export const adoptUsage =
  'krn adopt <path> [--tracker] [--no-canary] [--ref SHA [--install CMD] [--lint CMD] [--typecheck CMD]] [--test CMD]  write krn.json from detection (kept when present), the .claude/settings.json Stop hook calling `krn hook stop`, the generated rules block in AGENTS.md (CLAUDE.md links to it), .agents/standards.json with the universal standards of the shipped pack that apply to the detected stack (tracker ones only with a tracker) followed by the project own records (one reusing a pack id exits 65) and the AGENTS.md standards block rendered from it and .krn/ in .gitignore into the git repository at <path>; --tracker seeds tasks/; --ref SHA also seeds tasks/, writes the call of the shared project CI at SHA to .github/workflows/ci.yml (krn-ci.yml beside a ci.yml of its own) and spec/ci-admission.json selecting the required `ci / Check`; reruns change nothing; then the canary breaks one test in a temporary worktree of the base and requires the Stop gate to refuse it (exit 2) and to pass the restored tree, else adopt fails (--no-canary records the decline); `krn adopt <path> --canary` runs only the canary; `krn adopt <path> --verify` only reads the repository through gh and exits 1 naming each gap when the default branch lacks one required check from GitHub Actions or auto-merge is off (no setting is changed)';

const switches = ['--tracker', '--canary', '--no-canary', '--verify'] as const;
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
  if (on.has('--verify')) {
    if (on.size > 1 || Object.keys(values).length > 0)
      throw new CliUsageError('--verify stands alone');
    const report = verifyRepository(root);
    if (report.ok)
      process.stdout.write(
        'verify ok: required check and auto-merge are set\n',
      );
    for (const gap of report.gaps) process.stdout.write(`verify gap: ${gap}\n`);
    if (!report.ok) process.exitCode = 1;
    return;
  }
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
    // A malformed standards file or a pack-id clash is invalid data (65), not a usage error.
    if (
      error instanceof StandardsDataError ||
      error instanceof StandardsInputError
    )
      throw error;
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
  process.stdout.write(nextSteps(path));
}

/** The closing lines: what the operator still does, since adopt only writes files. */
export function nextSteps(path: string): string {
  return [
    'next steps:',
    `  1. commit the adoption files: git -C ${path} add -A && git -C ${path} commit -m "chore: adopt krn"`,
    '  2. merge them through a pull request on the default branch (never push the default branch directly)',
    '  3. put krn on PATH for every agent session: the Stop hook refuses (exit 2) while `command -v krn` fails',
    '  4. install the repository dependencies, then run `krn repo contract` to check the commands krn.json names',
    '',
  ].join('\n');
}
