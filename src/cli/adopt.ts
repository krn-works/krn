// `krn adopt <path>`: write the adoption set into a named repository.
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  adopt,
  GREEN_BASE_TASK_TITLE,
  seedGreenBaseTask,
} from '../adopt/adopt.ts';
import {
  adoptionDrift,
  missingPackRecords,
  refreshAdoption,
} from '../adopt/drift.ts';
import { estimateFirstTurn, renderFirstTurn } from '../adopt/first-turn.ts';
import { adoptionGaps } from '../adopt/gaps.ts';
import {
  initDirectory,
  initGates,
  initInstallCommand,
  initTestCommand,
} from '../adopt/init.ts';
import { duplicateCi, runCanary, verifyRepository } from '../adopt/verify.ts';
import {
  pruneRegistry,
  registerAdopted,
  registryPath,
} from '../brain/adopted-registry.ts';
import { StandardsDataError } from '../brain/standards.ts';
import { StandardsInputError } from '../brain/standards-cli.ts';
import { flagValue } from '../cli-kit/flag-value.ts';
import { CliUsageError } from '../cli-kit/usage-error.ts';

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
  'krn adopt <path> [--tracker] [--no-canary] [--register] [--ref SHA [--install CMD] [--lint CMD] [--typecheck CMD]] [--test CMD] [--init [--stack ts|php|python|wp-plugin|go|rust]]  write krn.json from detection (kept when present), the .claude/settings.json Stop hook calling `krn hook stop`, the generated rules block in AGENTS.md (CLAUDE.md links to it), .agents/standards.json with the universal standards of the shipped pack that apply to the detected stack (tracker ones only with a tracker) followed by the project own records (one reusing a pack id exits 65) and the AGENTS.md standards block rendered from it and .krn/ in .gitignore into the git repository at <path>; --tracker seeds tasks/; --ref SHA also seeds tasks/, writes the call of the shared project CI at SHA to .github/workflows/ci.yml (krn-ci.yml beside a ci.yml of its own) with only the contract gates (lint, typecheck, test) no existing workflow runs, and no call at all when every gate already runs and spec/ci-admission.json selecting the required `ci / Check`; reruns change nothing; the repository joins the host registry unless it lies under a temp or `tmp` directory (--register forces it; pruning drops such paths from the host registry); then the canary breaks one test in a temporary worktree of the base and requires the Stop gate to refuse it (exit 2) and to pass the restored tree, else adopt fails (--no-canary records the decline); the canary is bounded by KRN_CANARY_TIMEOUT_MS (default 180000): a canary that runs past the bound keeps what adopt wrote, prints `canary pending:` naming the slow step (install, test command or Stop gate) and its measured time, and exits 0 (`--verify` exits 124); any other failed canary removes everything adopt wrote and exits 64; a repository without a related-test command runs its test command once on the clean tree and once in the Stop gate; a clean base whose own test command fails is adopted in bootstrap state: exit 0, the failing command named, and one seeded task "make the base test command green" that lane run admits on the red baseline (`--verify` still exits 69 for it)); adopt then prints each failing standard as a `gap` line and, in a repository with a tracker, writes one task per floor or reflex failure; `--init` first prepares an empty or non-git directory (refused when it is a git repository with commits: run plain adopt): git init on main, the stack (ts, php, python, wp-plugin, go or rust) from package.json, composer.json (a plugin header makes it wp-plugin), go.mod, Cargo.toml or pyproject.toml or --stack, a minimal real test with its test command committed as the base, and the tracker; `krn adopt <path> --verify` runs the canary once (`canary <outcome>:` line; exit 124 timeout, 69 red base, 1 failure) with the checks below; `krn adopt <path> --refresh --dry-run` writes nothing and prints `drift <file>` or `missing <file>` per file the refresh would change, then `no drift` (exit 0) or `drift: N` (exit 1); `krn adopt <path> --refresh` rewrites only the KRN-owned adoption files that drifted (or are missing) to what adopt writes now, never krn.json, tasks/ or the CI call, printing `updated <file>` or `kept <file>` per file, and is idempotent; `krn adopt --refresh-all` runs that refresh over every repository of the host registry (`~/.krn/adopted.json`, or KRN_ADOPTED_REGISTRY), printing `refreshed <repo>`, `skipped <repo>` or `failed <repo>`; `krn adopt <path> --verify` also names each pack record the repository lacks (`verify drift: pack record`) and also names each adoption file that drifted or is missing (`verify drift:`; a project record file adopt cannot read is named as `verify drift: adoption files cannot be compared` instead of aborting), prints `duplicate-ci: N`, the number of contract gate commands (lint, typecheck, test) that two or more workflows run (each named as a `verify gap: duplicate-ci` line; N > 0 exits 1), prints `verify context:` with the first-turn token estimate of the instruction files, skills and MCP servers and `verify context setting:` lines naming the settings that cut it, reads the repository through gh and exits 1 naming each gap or drift when the default branch lacks one required check from GitHub Actions or auto-merge is off (no setting is changed); a repository whose origin is not on GitHub prints `verify skipped: no GitHub host` and skips those CI checks';

const switches = [
  '--tracker',
  '--no-canary',
  '--verify',
  '--refresh',
  '--refresh-all',
  '--dry-run',
  '--init',
  '--register',
] as const;
const flags = [
  '--ref',
  '--install',
  '--lint',
  '--typecheck',
  '--test',
  '--stack',
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
  if (on.has('--refresh-all')) {
    if (on.size > 1 || path !== undefined || Object.keys(values).length > 0)
      throw new CliUsageError('--refresh-all stands alone');
    refreshAll();
    return;
  }
  if (path === undefined) throw new CliUsageError(adoptUsage);
  const root = resolve(path);
  if (on.has('--verify')) {
    if (on.size > 1 || Object.keys(values).length > 0)
      throw new CliUsageError('--verify stands alone');
    // A project record file adopt cannot read is drift to name, not a crash that hides every other verdict.
    let unreadable: string | undefined;
    let drift: ReturnType<typeof adoptionDrift> = {
      drifted: [],
      missing: [],
      kept: [],
    };
    let absent: string[] = [];
    try {
      drift = adoptionDrift(root);
      absent = missingPackRecords(root);
    } catch (error) {
      unreadable = (error as Error).message;
    }
    // Local verdicts print before the GitHub read, which can abort (App not installed).
    const duplicates = duplicateCi(root);
    process.stdout.write(`duplicate-ci: ${duplicates.length}\n`);
    for (const duplicate of duplicates)
      process.stdout.write(
        `verify gap: duplicate-ci ${duplicate.gate} \`${duplicate.command}\` runs in ${duplicate.files.join(', ')}; keep one runner\n`,
      );
    // The one run of the contract commands and the Stop hook entry: the canary.
    const canary = runCanary(root);
    process.stdout.write(`canary ${canary.outcome}: ${canary.message}\n`);
    const canaryFailed = !['pass', 'bootstrap', 'skipped'].includes(
      canary.outcome,
    );
    if (canaryFailed) process.exitCode = canaryExit(canary.outcome);
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
    if (unreadable !== undefined)
      process.stdout.write(
        `verify drift: adoption files cannot be compared: ${unreadable}\n`,
      );
    for (const id of absent)
      process.stdout.write(
        `verify drift: pack record ${id} is missing; run krn adopt ${root} --refresh\n`,
      );
    const drifting =
      unreadable !== undefined ||
      drift.drifted.length + drift.missing.length + absent.length > 0;
    if (!drifting)
      process.stdout.write(
        'verify ok: adoption files match what adopt writes\n',
      );
    for (const line of renderFirstTurn(estimateFirstTurn(root)))
      process.stdout.write(`${line}\n`);
    if (!report.ok || drifting || duplicates.length > 0)
      process.exitCode = process.exitCode || 1;
    return;
  }
  if (on.has('--dry-run') && !on.has('--refresh'))
    throw new CliUsageError('--dry-run needs --refresh');
  if (on.has('--refresh')) {
    const dry = on.has('--dry-run');
    if (on.size > (dry ? 2 : 1) || Object.keys(values).length > 0)
      throw new CliUsageError('--refresh stands alone');
    if (dry) {
      const drift = adoptionDrift(root);
      for (const file of drift.drifted) process.stdout.write(`drift ${file}\n`);
      for (const file of drift.missing)
        process.stdout.write(`missing ${file}\n`);
      const count = drift.drifted.length + drift.missing.length;
      process.stdout.write(count === 0 ? 'no drift\n' : `drift: ${count}\n`);
      if (count > 0) process.exitCode = 1;
      return;
    }
    const refreshed = refreshAdoption(root);
    for (const file of [...refreshed.drifted, ...refreshed.missing])
      process.stdout.write(`updated ${file}\n`);
    for (const file of refreshed.kept) process.stdout.write(`kept ${file}\n`);
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
    values.lint ??= initGates(init.stack).lint;
    values.typecheck ??= initGates(init.stack).typecheck;
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
    // A canary that ran out of time proved nothing either way: adopt keeps what it wrote and the canary stays pending.
    process.stdout.write(
      `canary ${result.outcome === 'timeout' ? 'pending' : result.outcome}: ${result.message}\n`,
    );
    if (result.outcome === 'timeout') {
      process.stdout.write(
        'canary pending: everything adopt wrote was kept; rerun `krn adopt <path> --verify` with a larger KRN_CANARY_TIMEOUT_MS to prove the Stop gate\n',
      );
    } else if (result.outcome === 'red-base') {
      // A red base is adopted in bootstrap state: the seeded task is the only one lane run admits until the base is green.
      seedGreenBaseTask(root, result.message);
      process.stdout.write(
        `bootstrap state: the base is red; the seeded task "${GREEN_BASE_TASK_TITLE}" is the first admitted task\n`,
      );
    } else if (result.outcome !== 'pass' && result.outcome !== 'bootstrap') {
      // A failed canary leaves no repository half-adopted.
      report.rollback();
      const removed = 'everything adopt wrote was removed';
      throw new CliUsageError(
        `adopt failed: the canary did not prove the Stop gate (${result.message}); ${removed}; fix the cause (a repository without tests needs one test file, e.g. *.test.ts, test_*.py or *_test.go, and a test command) or pass --no-canary to decline`,
      );
    }
  }
  if (registerAdopted(root, process.env, on.has('--register')))
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
