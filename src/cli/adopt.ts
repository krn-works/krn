// `krn adopt <path>`: write the adoption set into a named repository.
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  adopt,
  GREEN_BASE_TASK_TITLE,
  seedGreenBaseTask,
} from '../adopt/adopt.ts';
import { runCanary } from '../adopt/canary.ts';
import {
  adoptionDrift,
  missingPackRecords,
  refreshAdoption,
} from '../adopt/drift.ts';
import {
  disableUnused,
  estimateFirstTurn,
  renderFirstTurn,
} from '../adopt/first-turn.ts';
import { adoptionGaps } from '../adopt/gaps.ts';
import {
  initDirectory,
  initInstallCommand,
  initTestCommand,
} from '../adopt/init.ts';
import { renderUnused, unusedTools } from '../adopt/unused.ts';
import { verifyRepository } from '../adopt/verify.ts';
import {
  pruneRegistry,
  registerAdopted,
  registryPath,
} from '../brain/adopted-registry.ts';
import { StandardsDataError } from '../brain/standards.ts';
import { StandardsInputError } from '../brain/standards-cli.ts';
import { flagValue } from '../cli-kit/flag-value.ts';
import { CliUsageError } from '../cli-kit/usage-error.ts';
import { transcriptDirs } from '../harness/transcripts.ts';

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
  for (const file of gaps.remediated) process.stdout.write(`wrote ${file}\n`);
  for (const line of gaps.lines) process.stdout.write(`${line}\n`);
  for (const title of gaps.tasks) process.stdout.write(`task ${title}\n`);
}

export const adoptUsage =
  'krn adopt <path> [--tracker] [--no-canary] [--ref SHA [--install CMD] [--lint CMD] [--typecheck CMD]] [--test CMD] [--init [--stack ts|php|python|wp-plugin|go|rust]]  write krn.json from detection (kept when present), the .claude/settings.json Stop hook calling `krn hook stop`, the generated rules block in AGENTS.md (CLAUDE.md links to it), .agents/standards.json with the universal standards of the shipped pack that apply to the detected stack (tracker ones only with a tracker) followed by the project own records (one reusing a pack id exits 65) and the AGENTS.md standards block rendered from it and .krn/ in .gitignore into the git repository at <path>; --tracker seeds tasks/; --ref SHA also seeds tasks/, writes the call of the shared project CI at SHA to .github/workflows/ci.yml (krn-ci.yml beside a ci.yml of its own) and spec/ci-admission.json selecting the required `ci / Check`; reruns change nothing; then the canary breaks one test in a temporary worktree of the base and requires the Stop gate to refuse it (exit 2) and to pass the restored tree, else adopt fails (--no-canary records the decline); the canary is bounded by KRN_CANARY_TIMEOUT_MS (default 180000): any failed canary removes everything adopt wrote (a timeout exits 124 naming the slow step (install, test command or Stop gate) and its measured time, any other failure exits 64; a clean base whose own test command fails is adopted in bootstrap state: exit 0, the failing command named, and one seeded task "make the base test command green" that lane run admits on the red baseline (`--canary` alone still exits 69 for it)); adopt then prints each failing standard as a `gap` line and, in a repository with a tracker, writes one task per floor or reflex failure; `--init` first prepares an empty or non-git directory (refused when it is a git repository with commits: run plain adopt): git init on main, the stack (ts, php, python, wp-plugin, go or rust) from package.json, composer.json (a plugin header makes it wp-plugin), go.mod, Cargo.toml or pyproject.toml or --stack, a minimal real test with its test command committed as the base, and the tracker; `krn adopt <path> --canary` runs only the canary; `krn adopt <path> --refresh` rewrites only the KRN-owned adoption files that drifted (or are missing) to what adopt writes now, never krn.json, tasks/ or the CI call, printing `updated <file>` or `kept <file>` per file, and is idempotent; `krn adopt --refresh-all` runs that refresh over every repository of the host registry (`~/.krn/adopted.json`, or KRN_ADOPTED_REGISTRY), printing `refreshed <repo>`, `skipped <repo>` or `failed <repo>`; `krn adopt <path> --verify` also names each pack record the repository lacks (`verify drift: pack record`) and also names each adoption file that drifted or is missing (`verify drift:`), prints `verify context:` with the first-turn token estimate of the instruction files, skills and MCP servers and `verify context setting:` lines naming the settings that cut it, reads the repository through gh and exits 1 naming each gap or drift when the default branch lacks one required check from GitHub Actions or auto-merge is off (no setting is changed); a repository whose origin is not on GitHub prints `verify skipped: no GitHub host` and skips those CI checks; `krn adopt <path> --prune-unused [--transcripts DIR]` reads the last 5 sessions (at least 2 needed), prints each project MCP server and skill with 0 calls and its token weight (`unused MCP server`, `unused skill`, `unused total`) and disables them in .claude/settings.json (`disabledMcpjsonServers`, `permissions.deny` `Skill(name)`), printing `disabled <entry>` only for entries it adds; nothing is disabled without the flag and a rerun changes nothing';

const switches = [
  '--tracker',
  '--canary',
  '--no-canary',
  '--verify',
  '--refresh',
  '--refresh-all',
  '--init',
  '--prune-unused',
] as const;
const flags = [
  '--ref',
  '--install',
  '--lint',
  '--typecheck',
  '--test',
  '--stack',
  '--transcripts',
] as const;

/** Refreshes every repository of the host registry; a registered path that is not a git repository is skipped; exit 1 when a refresh fails; a usage error when none is registered. */
function refreshAll(): void {
  const file = registryPath();
  const { roots, pruned } = pruneRegistry(file);
  if (pruned > 0)
    process.stdout.write(`pruned ${pruned} missing paths from ${file}\n`);
  if (roots.length === 0)
    throw new CliUsageError(`no adopted repository registered in ${file}`);
  for (const root of roots) {
    if (!existsSync(join(root, '.git'))) {
      process.stdout.write(`skipped ${root}: not a git repository\n`);
      continue;
    }
    try {
      const refreshed = refreshAdoption(root);
      const changed = [...refreshed.drifted, ...refreshed.missing];
      process.stdout.write(`refreshed ${root}: ${changed.length} updated\n`);
    } catch (error) {
      process.stdout.write(
        `failed ${root}: ${error instanceof Error ? error.message : String(error)}\n`,
      );
      process.exitCode = 1;
    }
  }
}

/** Names the MCP servers and skills no recent session called with the tokens saved, and disables them in the project settings; adds only entries not yet there, so a rerun changes nothing. */
async function pruneUnused(root: string, transcripts?: string): Promise<void> {
  const report = await unusedTools(
    root,
    transcripts === undefined ? await transcriptDirs(root) : [transcripts],
  );
  for (const line of renderUnused(report)) process.stdout.write(`${line}\n`);
  for (const entry of disableUnused(root, report))
    process.stdout.write(`disabled ${entry}\n`);
}

export function adoptCommand(args: string[]): void | Promise<void> {
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
  if (on.has('--prune-unused')) {
    if (path === undefined) throw new CliUsageError(adoptUsage);
    if (on.size > 1 || Object.keys(values).some((k) => k !== 'transcripts'))
      throw new CliUsageError('--prune-unused stands alone');
    return pruneUnused(resolve(path), values.transcripts);
  }
  if (Object.keys(values).includes('transcripts'))
    throw new CliUsageError('--transcripts needs --prune-unused');
  if (on.has('--refresh-all')) {
    if (on.size > 1 || path !== undefined || Object.keys(values).length > 0)
      throw new CliUsageError('--refresh-all stands alone');
    refreshAll();
    return;
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
    const absent = missingPackRecords(root);
    for (const id of absent)
      process.stdout.write(
        `verify drift: pack record ${id} is missing; run krn adopt ${root} --refresh\n`,
      );
    const drifting =
      drift.drifted.length + drift.missing.length + absent.length > 0;
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
    if (result.outcome !== 'pass' && result.outcome !== 'bootstrap')
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
    for (const warning of init.warnings)
      process.stderr.write(`init warning: ${warning}\n`);
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
    if (result.outcome === 'red-base') {
      // A red base is adopted in bootstrap state: the seeded task is the only one lane run admits until the base is green.
      seedGreenBaseTask(root, result.message);
      process.stdout.write(
        `bootstrap state: the base is red; the seeded task "${GREEN_BASE_TASK_TITLE}" is the first admitted task\n`,
      );
    } else if (result.outcome !== 'pass' && result.outcome !== 'bootstrap') {
      // A failed canary leaves no repository half-adopted.
      report.rollback();
      const removed = 'everything adopt wrote was removed';
      if (result.outcome === 'timeout')
        throw new AdoptFailure(
          `adopt failed: ${result.message}; ${removed}`,
          canaryExit(result.outcome),
        );
      throw new CliUsageError(
        `adopt failed: the canary did not prove the Stop gate (${result.message}); ${removed}; fix the cause (a repository without tests needs one test file, e.g. *.test.ts, test_*.py or *_test.go, and a test command) or pass --no-canary to decline`,
      );
    }
  }
  if (registerAdopted(root))
    process.stdout.write(
      'registered in the host registry of adopted repositories\n',
    );
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
