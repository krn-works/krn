// `krn adopt <path>`: write the adoption set into a named repository.
import { resolve } from 'node:path';
import { adopt } from '../adopt/adopt.ts';
import { runCanary } from '../adopt/canary.ts';
import { adoptionDrift, refreshAdoption } from '../adopt/drift.ts';
import { estimateFirstTurn, renderFirstTurn } from '../adopt/first-turn.ts';
import { adoptionGaps } from '../adopt/gaps.ts';
import {
  initDirectory,
  initInstallCommand,
  initTestCommand,
} from '../adopt/init.ts';
import { verifyRepository } from '../adopt/verify.ts';
import { StandardsDataError } from '../brain/standards.ts';
import { StandardsInputError } from '../brain/standards-cli.ts';
import { flagValue } from '../cli-kit/flag-value.ts';
import { CliUsageError } from '../cli-kit/usage-error.ts';

/** A named failure of adopt with its own exit: 124 the canary timed out, 69 the repository's clean base is red. */
class AdoptFailure extends Error {
  readonly exitCode: number;
  constructor(message: string, exitCode: number) {
    super(message);
    this.exitCode = exitCode;
  }
}

export const CANARY_TIMEOUT_EXIT = 124;
export const RED_BASE_EXIT = 69;

const canaryExit = (outcome: string) =>
  outcome === 'timeout'
    ? CANARY_TIMEOUT_EXIT
    : outcome === 'red-base'
      ? RED_BASE_EXIT
      : 1;

function printGaps(root: string): void {
  const gaps = adoptionGaps(root, new Date().toISOString().slice(0, 10));
  for (const line of gaps.lines) process.stdout.write(`${line}\n`);
  for (const title of gaps.tasks) process.stdout.write(`task ${title}\n`);
}

export const adoptUsage =
  'krn adopt <path> [--tracker] [--no-canary] [--ref SHA [--install CMD] [--lint CMD] [--typecheck CMD]] [--test CMD] [--init [--stack ts|php|python]]  write krn.json from detection (kept when present), the .claude/settings.json Stop hook calling `krn hook stop`, the generated rules block in AGENTS.md (CLAUDE.md links to it), .agents/standards.json with the universal standards of the shipped pack that apply to the detected stack (tracker ones only with a tracker) followed by the project own records (one reusing a pack id exits 65) and the AGENTS.md standards block rendered from it and .krn/ in .gitignore into the git repository at <path>; --tracker seeds tasks/; --ref SHA also seeds tasks/, writes the call of the shared project CI at SHA to .github/workflows/ci.yml (krn-ci.yml beside a ci.yml of its own) and spec/ci-admission.json selecting the required `ci / Check`; reruns change nothing; then the canary breaks one test in a temporary worktree of the base and requires the Stop gate to refuse it (exit 2) and to pass the restored tree, else adopt fails (--no-canary records the decline); the canary is bounded by KRN_CANARY_TIMEOUT_MS (default 180000): any failed canary removes everything adopt wrote (a timeout exits 124, a clean base whose own test command fails exits 69 naming that command, any other failure exits 64); adopt then prints each failing standard as a `gap` line and, in a repository with a tracker, writes one task per floor or reflex failure; `--init` first prepares an empty or non-git directory (refused when it is a git repository with commits: run plain adopt): git init on main, the stack from package.json, composer.json or pyproject.toml or --stack, a minimal real test with its test command committed as the base, and the tracker; `krn adopt <path> --canary` runs only the canary; `krn adopt <path> --refresh` rewrites only the KRN-owned adoption files that drifted (or are missing) to what adopt writes now, never krn.json, tasks/ or the CI call, printing `updated <file>` or `kept <file>` per file, and is idempotent; `krn adopt <path> --verify` also names each adoption file that drifted or is missing (`verify drift:`), prints `verify context:` with the first-turn token estimate of the instruction files, skills and MCP servers and `verify context setting:` lines naming the settings that cut it, reads the repository through gh and exits 1 naming each gap or drift when the default branch lacks one required check from GitHub Actions or auto-merge is off (no setting is changed); a repository whose origin is not on GitHub prints `verify skipped: no GitHub host` and skips those CI checks';

const switches = [
  '--tracker',
  '--canary',
  '--no-canary',
  '--verify',
  '--refresh',
  '--init',
] as const;
const flags = [
  '--ref',
  '--install',
  '--lint',
  '--typecheck',
  '--test',
  '--stack',
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
  if (on.has('--init') && on.has('--canary'))
    throw new CliUsageError('--init and --canary exclude each other');
  const root = resolve(path);
  if (on.has('--verify')) {
    if (on.size > 1 || Object.keys(values).length > 0)
      throw new CliUsageError('--verify stands alone');
    const drift = adoptionDrift(root);
    const report = verifyRepository(root);
    if (report.skipped !== undefined)
      process.stdout.write(`verify skipped: ${report.skipped}\n`);
    else if (report.ok)
      process.stdout.write(
        'verify ok: required check and auto-merge are set\n',
      );
    for (const gap of report.gaps) process.stdout.write(`verify gap: ${gap}\n`);
    for (const file of drift.drifted)
      process.stdout.write(
        `verify drift: ${file} differs from what adopt writes\n`,
      );
    for (const file of drift.missing)
      process.stdout.write(`verify drift: ${file} is missing\n`);
    const drifting = drift.drifted.length + drift.missing.length > 0;
    if (!drifting)
      process.stdout.write(
        'verify ok: adoption files match what adopt writes\n',
      );
    for (const line of renderFirstTurn(estimateFirstTurn(root)))
      process.stdout.write(`${line}\n`);
    if (!report.ok || drifting) process.exitCode = 1;
    return;
  }
  if (on.has('--refresh')) {
    if (on.size > 1 || Object.keys(values).length > 0)
      throw new CliUsageError('--refresh stands alone');
    const refreshed = refreshAdoption(root);
    for (const file of [...refreshed.drifted, ...refreshed.missing])
      process.stdout.write(`updated ${file}\n`);
    for (const file of refreshed.kept) process.stdout.write(`kept ${file}\n`);
    return;
  }
  if (on.has('--canary')) {
    const result = runCanary(root);
    process.stdout.write(`canary ${result.outcome}: ${result.message}\n`);
    if (result.outcome !== 'pass')
      process.exitCode = canaryExit(result.outcome);
    return;
  }
  let tracker = on.has('--tracker');
  if (values.stack !== undefined && !on.has('--init'))
    throw new CliUsageError('--stack needs --init');
  if (on.has('--init')) {
    let init: ReturnType<typeof initDirectory>;
    try {
      init = initDirectory(root, values.stack);
    } catch (error) {
      throw new CliUsageError(
        error instanceof Error ? error.message : String(error),
      );
    }
    for (const file of init.written) process.stdout.write(`wrote ${file}\n`);
    process.stdout.write(`init ${init.stack}: git init on main, committed\n`);
    tracker = true;
    values.test ??= initTestCommand(init.stack) ?? '';
    if (values.test === '') delete values.test;
    const install = initInstallCommand(init.stack);
    if (install !== undefined) values.install ??= install;
  }
  delete values.stack;
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
    if (result.outcome !== 'pass') {
      // A failed canary leaves no repository half-adopted.
      report.rollback();
      const removed = 'everything adopt wrote was removed';
      if (result.outcome === 'timeout' || result.outcome === 'red-base')
        throw new AdoptFailure(
          `adopt failed: ${result.message}; ${removed}`,
          canaryExit(result.outcome),
        );
      throw new CliUsageError(
        `adopt failed: the canary did not prove the Stop gate (${result.message}); ${removed}; fix the cause (a repository without tests needs one test file, e.g. *.test.ts, test_*.py or *_test.go, and a test command) or pass --no-canary to decline`,
      );
    }
  }
  printGaps(root);
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
