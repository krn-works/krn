import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { syncLockfile } from '../../adopt/host-remediation.ts';
import { findContract } from '../../repo/contract.ts';
import { baseIsVacuous, bootstrapProof, isBootstrapTask } from './bootstrap.ts';
import { fastCheck } from './environment.ts';
import { git } from './git.ts';
import { settledRun } from './preflight.ts';
import { failedCheckDetail } from './red-check.ts';

/** The subject of the session's commit that carries the task's Ticket trailer, else undefined. */
export function ticketCommitTitle(
  log: string,
  task: string,
  trailer: 'Ticket' | 'Refs' = 'Ticket',
): string | undefined {
  const trailerLine = new RegExp(`^${trailer}:\\s*(.+)$`, 'u');
  for (const entry of log.split('\x1e')) {
    const [subject, body] = entry.trim().split('\x1f');
    // A `Ticket:` line anywhere in the body counts: agents often put Co-Authored-By in its own
    // paragraph, which leaves Ticket outside git's trailer block.
    const tickets = (body ?? '')
      .split('\n')
      .flatMap((line) => trailerLine.exec(line.trim())?.[1]?.split(',') ?? [])
      .map((item) => item.trim());
    if (subject && tickets.includes(task))
      return subject.endsWith(`(${task})`) ? subject : `${subject} (${task})`;
  }
  return undefined;
}

/**
 * What the session proved: `npm run fast` leaves .krn/cache/fast-pass holding the key of the tree
 * it passed on; the proof counts only while it equals the key of the final tree.
 */
export function sessionVerification(worktree: string): string | undefined {
  const marker = join(worktree, '.krn', 'cache', 'fast-pass');
  if (!existsSync(marker)) return undefined;
  // The key comes from the script that wrote the marker, run as a process: scripts/ is not an import of src/.
  const key = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      'const { treeKey } = await import(process.env.KRN_FAST_CHECK); process.stdout.write(treeKey(process.cwd()));',
    ],
    {
      cwd: worktree,
      encoding: 'utf8',
      env: { ...process.env, KRN_FAST_CHECK: fastCheck },
    },
  );
  return key.status === 0 && readFileSync(marker, 'utf8') === key.stdout
    ? 'npm run fast PASS on the final tree (.krn/cache/fast-pass matches HEAD)'
    : undefined;
}

/** Read the JSON result of `claude -p --output-format json`. */
/** The files the harness sandbox mounts empty over write-denied paths: .env*, .npmrc and lockfiles. */
export const placeholderName =
  /^(\.env(\..+)?|\.npmrc|\.yarnrc(\.yml)?|\.gitmodules|bunfig\.toml|package\.json|package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?)$/u;

/**
 * The untracked empty regular files in `git status --porcelain -z` output that carry a known
 * sandbox placeholder name. Any other empty untracked file (.gitkeep, a marker) is intended
 * work and stays.
 */
export function sandboxPlaceholders(
  porcelain: string,
  stat: (path: string) => { isFile(): boolean; size: number },
): string[] {
  return porcelain
    .split('\0')
    .filter((entry) => entry.startsWith('?? '))
    .map((entry) => entry.slice(3))
    .filter((path) => placeholderName.test(basename(path)))
    .filter((path) => {
      const info = stat(path);
      return info.isFile() && info.size === 0;
    });
}

/** The PR body of a goal lane: no task record, so the goal is the problem and the outcome. */
export function goalPrBody(
  goal: string,
  commits: readonly string[],
  verified: string,
): string {
  return `## Problem\n\n${goal.trim()}\n\n## Change\n\n${commits.map((line) => `- ${line}`).join('\n')}\n\n## Verification\n\n${verified}\n`;
}

/**
 * The runner's own proof where the repository has no fast-pass marker: the contract's quick
 * check (else its tests) passes on the final tree.
 */
export function contractVerification(
  worktree: string,
  logPath: string,
  task?: string,
  base?: string,
): { verified: string; flaky: string[] } | { failure: string } | undefined {
  const contract = findContract(worktree)?.contract;
  if (contract === undefined) return undefined;
  // The first-test task of a vacuous base proves itself by mutation, not by a prior green baseline.
  if (
    task !== undefined &&
    base !== undefined &&
    isBootstrapTask(worktree, task) &&
    baseIsVacuous(worktree, base)
  )
    return bootstrapProof(worktree, contract.fast ?? contract.test);
  if (contract.vacuous)
    return {
      failure: `the test command ${contract.test} is vacuous (runs no real test), so its pass is not a proof`,
    };
  const command = contract.fast ?? contract.test;
  const { run, flaky } = settledRun(
    (line) =>
      spawnSync(line, {
        cwd: worktree,
        shell: true,
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024,
        timeout: 30 * 60 * 1000,
      }),
    command,
  );
  if (run.status === 0)
    return { verified: `${command} PASS on the final tree`, flaky };
  const output = `${run.stdout ?? ''}${run.stderr ?? ''}`;
  mkdirSync(dirname(logPath), { recursive: true });
  writeFileSync(logPath, output);
  return { failure: failedCheckDetail(command, output, logPath) };
}

/** The record of a commit whose ship waited on the App token: its file under .krn/tmp. */
export function parkedFile(main: string, lane: string): string {
  return join(main, '.krn', 'tmp', `lane-run-${lane}.parked`);
}

/** Park the checked commit, so a resume ships it without rerunning the worker. */
export function parkCommit(file: string, head: string): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${head}\n`);
}

/** Whether the parked commit is still the worktree's HEAD; a moved HEAD is new work, not the parked one. */
export function parkedAt(file: string, head: string): boolean {
  return existsSync(file) && readFileSync(file, 'utf8').trim() === head;
}

/**
 * When the session's commits changed package.json and the repository tracks a package-lock.json,
 * regenerates the lockfile on the host and commits it. Returns a note for the PR body, or
 * undefined when nothing changed. A failing npm throws.
 */
export function followLockfile(
  worktree: string,
  range: string,
): string | undefined {
  const manifest = 'package.json';
  const lock = 'package-lock.json';
  if (git(worktree, ['diff', '--name-only', range, '--', manifest]) === '')
    return undefined;
  if (git(worktree, ['ls-files', '--', lock]) === '') return undefined;
  syncLockfile(worktree);
  if (git(worktree, ['status', '--porcelain', '--', lock]) === '')
    return undefined;
  git(worktree, [
    'commit',
    '-q',
    '-m',
    'chore(deps): regenerate the lockfile for the manifest change',
    '--',
    lock,
  ]);
  return 'package-lock.json regenerated by the host after the manifest change';
}
