// Start creates the isolated job worktree; checkpoint persists before stopping its worker. ADR 0001.
import { spawnSync } from 'node:child_process';
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  mkdirSync,
  openSync,
  readlinkSync,
  readSync,
  realpathSync,
  statSync,
} from 'node:fs';
import { dirname, isAbsolute, resolve, sep } from 'node:path';

import type { Job } from '../core/index.ts';
import { deriveJourneyReport, refusalReport } from '../evals/journey.ts';
import { reviewCommand } from '../flow/cli.ts';
import { writeCheckpointRequest } from '../foreman/checkpoint-request.ts';
import { recordRepo } from '../foreman/state.ts';
import {
  leadIntervention,
  operatorStart,
  operatorStop,
  readTraceRepoContext,
  readTraceSnapshot,
} from '../trace/index.ts';

function value(args: string[], flag: string): string {
  const index = args.indexOf(flag);
  const result = index < 0 ? undefined : args[index + 1];
  if (!result || result.startsWith('--')) throw new Error(`missing ${flag}`);
  return result;
}

function readNoteStdin(): string {
  const maximumBytes = 8192;
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  while (totalBytes < maximumBytes) {
    const chunk = Buffer.alloc(Math.min(1024, maximumBytes - totalBytes));
    const bytesRead = readSync(0, chunk, 0, chunk.length, null);
    if (bytesRead === 0) break;
    chunks.push(chunk.subarray(0, bytesRead));
    totalBytes += bytesRead;
  }
  if (totalBytes === maximumBytes) {
    const overflow = Buffer.alloc(1);
    if (readSync(0, overflow, 0, 1, null) > 0)
      throw new Error('note text exceeds 8192 bytes');
  }
  return Buffer.concat(chunks, totalBytes).toString('utf8');
}

function git(root: string, args: string[]): string {
  const result = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' });
  if (result.status !== 0)
    throw new Error(result.stderr || 'git command failed');
  return result.stdout.trim();
}

function resolvesToCommit(root: string, ref: string): boolean {
  return (
    spawnSync(
      'git',
      [
        '-C',
        root,
        'rev-parse',
        '--verify',
        '--quiet',
        '--end-of-options',
        `${ref}^{commit}`,
      ],
      { encoding: 'utf8' },
    ).status === 0
  );
}

export function resolveBaseRef(root: string, requested?: string): string {
  const remoteHead = spawnSync(
    'git',
    [
      '-C',
      root,
      'symbolic-ref',
      '--quiet',
      '--short',
      'refs/remotes/origin/HEAD',
    ],
    { encoding: 'utf8' },
  );
  const currentBranch = spawnSync(
    'git',
    ['-C', root, 'branch', '--show-current'],
    { encoding: 'utf8' },
  );
  if (requested) {
    if (!resolvesToCommit(root, requested))
      throw new Error(`base ref "${requested}" does not resolve to a commit`);
    return requested;
  }
  if (remoteHead.status === 0) {
    const remoteRef = remoteHead.stdout.trim();
    const localRef = remoteRef.replace(/^origin\//u, '');
    if (resolvesToCommit(root, localRef)) return localRef;
    if (remoteRef !== localRef && resolvesToCommit(root, remoteRef))
      return remoteRef;
    throw new Error(`base ref "${localRef}" does not resolve to a commit`);
  }
  const branch = currentBranch.stdout.trim();
  if (currentBranch.status === 0 && branch) {
    if (!resolvesToCommit(root, branch))
      throw new Error(`base ref "${branch}" does not resolve to a commit`);
    return branch;
  }
  throw new Error('unable to resolve a base ref; specify one with --base');
}

function assertWorktreeParentInside(root: string, parent: string): void {
  const realRoot = realpathSync(root);
  const realParent = realpathSync(parent);
  if (realParent !== realRoot && !realParent.startsWith(`${realRoot}${sep}`))
    throw new Error(
      'job worktree parent must resolve inside the target repository',
    );
}

async function start(args: string[]): Promise<void> {
  const id = value(args, '--job');
  const issue = value(args, '--issue');
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(id) || id === '..')
    throw new Error('invalid job id');
  const root = git(process.cwd(), ['rev-parse', '--show-toplevel']);
  const baseRef = resolveBaseRef(
    root,
    args.includes('--base') ? value(args, '--base') : undefined,
  );
  const refSha = git(root, [
    'rev-parse',
    '--verify',
    '--quiet',
    '--end-of-options',
    `${baseRef}^{commit}`,
  ]);
  const checkoutHead = git(root, ['rev-parse', 'HEAD']);
  const baseResult = spawnSync(
    'git',
    ['-C', root, 'merge-base', checkoutHead, refSha],
    { encoding: 'utf8' },
  );
  if (baseResult.status === 1)
    throw new Error(
      `base ref "${baseRef}" has no common ancestor with checkout HEAD`,
    );
  if (baseResult.status !== 0)
    throw new Error(baseResult.stderr || 'unable to compute base merge-base');
  const baseSha = baseResult.stdout.trim();
  const worktree = resolve(root, '.krn', 'worktrees', id);
  if (existsSync(dirname(worktree)))
    assertWorktreeParentInside(root, dirname(worktree));
  const ignored = spawnSync('git', [
    '-C',
    root,
    'check-ignore',
    '-q',
    `.krn/worktrees/${id}`,
  ]);
  if (ignored.status !== 0)
    throw new Error(
      `target repository must ignore .krn/worktrees/${id} before starting a job`,
    );
  mkdirSync(dirname(worktree), { recursive: true });
  assertWorktreeParentInside(root, dirname(worktree));
  const result = spawnSync(
    'git',
    ['-C', root, 'worktree', 'add', '-b', `krn/${id}`, worktree, checkoutHead],
    { encoding: 'utf8' },
  );
  if (result.status !== 0)
    throw new Error(result.stderr || 'unable to create job worktree');
  try {
    assertWorktreeParentInside(root, dirname(worktree));
  } catch (error) {
    const rollback = spawnSync(
      'git',
      ['-C', root, 'worktree', 'remove', '--force', worktree],
      { encoding: 'utf8' },
    );
    if (rollback.status !== 0)
      throw new Error(
        `${error instanceof Error ? error.message : String(error)}; unable to roll back escaped worktree: ${rollback.stderr || 'git command failed'}`,
      );
    throw error;
  }
  const job: Job = { id, issue, worktree, repoRoot: root };
  recordRepo(job, root, baseRef, baseSha);
  await operatorStart(job, process.env.USER ?? 'local operator');
  process.stdout.write(`${JSON.stringify(job)}\n`);
}

async function stop(
  args: string[],
  kind: 'checkpoint' | 'stop',
): Promise<void> {
  const job: Job = {
    id: value(args, '--job'),
    issue: value(args, '--issue'),
    worktree: resolve(value(args, '--worktree')),
    ...(args.includes('--repo-root')
      ? { repoRoot: resolve(value(args, '--repo-root')) }
      : {}),
  };
  if (kind === 'checkpoint') {
    const message = value(args, '--message');
    if (message.length > 200 || /[\r\n]/.test(message))
      throw new Error(
        '--message must be a single line of at most 200 characters',
      );
    const next = value(args, '--next');
    if (next.length > 200 || /[\r\n]/.test(next))
      throw new Error('--next must be a single line of at most 200 characters');
    const decision = args.includes('--decision')
      ? value(args, '--decision')
      : undefined;
    if (decision && (decision.length > 500 || /[\r\n]/.test(decision)))
      throw new Error(
        '--decision must be a single line of at most 500 characters',
      );
    const session = value(args, '--session');
    writeCheckpointRequest(job, {
      intent: value(args, '--intent'),
      sessionId: session,
      message,
      next,
      decision,
    });
  } else await operatorStop(job, process.env.USER ?? 'local operator');
}

async function note(args: string[]): Promise<void> {
  const text = (
    args.includes('--text') ? value(args, '--text') : readNoteStdin()
  ).trim();
  const cliKind = value(args, '--kind');
  if (cliKind !== 'intervention' && cliKind !== 'reconstruction')
    throw new Error('--kind must be intervention or reconstruction');
  const job: Job = {
    id: value(args, '--job'),
    issue: value(args, '--issue'),
    worktree: resolve(value(args, '--worktree')),
    ...(args.includes('--repo-root')
      ? { repoRoot: resolve(value(args, '--repo-root')) }
      : {}),
  };
  await leadIntervention(
    job,
    cliKind === 'intervention' ? 'intervention' : 'reconstruction_prompt',
    text,
  );
}

export async function dispatch(args: string[]): Promise<boolean> {
  const [command, ...options] = args;
  if (command === 'start') await start(options);
  else if (command === 'checkpoint' || command === 'stop')
    await stop(options, command);
  else if (command === 'note') await note(options);
  else if (command === 'review') await reviewCommand(options);
  else return false;
  return true;
}

function journeyArgs(
  args: string[],
): { repoRoot: string; jobId: string } | null {
  if (args[0] !== 'journey') return null;
  const values = new Map<string, string>();
  for (let index = 1; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (
      (flag !== '--repo' && flag !== '--job') ||
      !value ||
      value.startsWith('--') ||
      values.has(flag)
    )
      return null;
    values.set(flag, value);
  }
  const repoRoot = values.get('--repo');
  const jobId = values.get('--job');
  if (!repoRoot || !jobId || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(jobId))
    return null;
  return { repoRoot, jobId };
}

function noConfiguredContentFilters(
  run: (args: string[]) => {
    status: number | null;
    stdout: string;
    stderr: string;
  },
): boolean {
  const filters = run([
    'config',
    '--null',
    '--get-regexp',
    '^filter\\..*\\.(clean|process)$',
  ]);
  return (
    filters.status === 1 &&
    filters.stdout.length === 0 &&
    filters.stderr.length === 0
  );
}

function noIndexedGitlinks(
  run: (args: string[]) => {
    status: number | null;
    stdout: string;
    stderr: string;
  },
): boolean {
  // Read only the pinned index; status can execute filters inside gitlinks.
  const entries = run(['ls-files', '--stage', '-z']);
  return (
    entries.status === 0 &&
    entries.stderr.length === 0 &&
    !entries.stdout.split('\0').some((entry) => entry.startsWith('160000 '))
  );
}

function reportGitFacts(
  repoRoot: string,
  context: ReturnType<typeof readTraceRepoContext>,
): {
  readonly headSha: string;
  readonly isDirty: boolean;
} | null {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith('GIT_')) delete env[key];
  }
  env.GIT_OPTIONAL_LOCKS = '0';
  env.GIT_CONFIG_NOSYSTEM = '1';
  env.GIT_CONFIG_GLOBAL = '/dev/null';
  const rootRun = (args: string[]) =>
    spawnSync(
      'git',
      [
        '-C',
        repoRoot,
        '-c',
        'core.fsmonitor=false',
        '-c',
        'core.untrackedCache=false',
        ...args,
      ],
      { encoding: 'utf8', env, maxBuffer: 1024 * 1024 },
    );
  const topLevel = rootRun(['rev-parse', '--show-toplevel']);
  if (topLevel.status !== 0) return null;
  try {
    if (realpathSync(topLevel.stdout.trim()) !== repoRoot) return null;
  } catch {
    return null;
  }
  const commonDirectory = rootRun([
    'rev-parse',
    '--path-format=absolute',
    '--git-common-dir',
  ]);
  if (commonDirectory.status !== 0) return null;
  let pinnedCommonDirectory: string;
  let pinnedGitDirectory: string;
  try {
    pinnedCommonDirectory = realpathSync(commonDirectory.stdout.trim());
    if (!statSync(pinnedCommonDirectory).isDirectory()) return null;
  } catch {
    return null;
  }
  const gitDirectory = rootRun([
    'rev-parse',
    '--path-format=absolute',
    '--absolute-git-dir',
  ]);
  if (gitDirectory.status !== 0) return null;
  try {
    pinnedGitDirectory = realpathSync(gitDirectory.stdout.trim());
    if (!statSync(pinnedGitDirectory).isDirectory()) return null;
  } catch {
    return null;
  }
  const pinnedRootRun = (args: string[]) =>
    spawnSync(
      'git',
      [
        '--git-dir',
        pinnedGitDirectory,
        '--work-tree',
        repoRoot,
        '-c',
        'core.fsmonitor=false',
        '-c',
        'core.untrackedCache=false',
        ...args,
      ],
      { encoding: 'utf8', env, maxBuffer: 1024 * 1024 },
    );
  const pinnedCommon = pinnedRootRun([
    'rev-parse',
    '--path-format=absolute',
    '--git-common-dir',
  ]);
  if (pinnedCommon.status !== 0) return null;
  try {
    if (realpathSync(pinnedCommon.stdout.trim()) !== pinnedCommonDirectory)
      return null;
  } catch {
    return null;
  }

  let worktreeFd: number | undefined;
  if (context) {
    try {
      if (
        context.repoRoot !== repoRoot ||
        realpathSync(context.repoRoot) !== repoRoot ||
        realpathSync(context.gitWorkTree) !== context.gitWorkTree ||
        realpathSync(context.gitDir) !== context.gitDir ||
        !statSync(context.gitWorkTree).isDirectory()
      )
        return null;
      const registrations = pinnedRootRun([
        'worktree',
        'list',
        '--porcelain',
        '-z',
      ]);
      if (registrations.status !== 0) return null;
      const registered = registrations.stdout
        .split('\0')
        .filter((field) => field.startsWith('worktree '))
        .map((field) => field.slice('worktree '.length));
      if (!registered.includes(context.gitWorkTree)) return null;

      worktreeFd = openSync(
        context.gitWorkTree,
        constants.O_RDONLY |
          (constants.O_DIRECTORY ?? 0) |
          (constants.O_NOFOLLOW ?? 0),
      );
      const stats = fstatSync(worktreeFd);
      if (!stats.isDirectory()) return null;
      if (readlinkSync(`/proc/self/fd/${worktreeFd}`) !== context.gitWorkTree)
        return null;
      const worktree = '/proc/self/fd/3';
      const discoverWorktreeRun = (args: string[]) =>
        spawnSync(
          'git',
          [
            '-C',
            worktree,
            '-c',
            'core.fsmonitor=false',
            '-c',
            'core.untrackedCache=false',
            ...args,
          ],
          {
            encoding: 'utf8',
            env,
            maxBuffer: 1024 * 1024,
            stdio: ['ignore', 'pipe', 'pipe', worktreeFd],
          },
        );
      const discoveredTopLevel = discoverWorktreeRun([
        'rev-parse',
        '--show-toplevel',
      ]);
      if (
        discoveredTopLevel.status !== 0 ||
        realpathSync(discoveredTopLevel.stdout.trim()) !== context.gitWorkTree
      )
        return null;
      const discoveredGitDir = discoverWorktreeRun([
        'rev-parse',
        '--path-format=absolute',
        '--absolute-git-dir',
      ]);
      if (discoveredGitDir.status !== 0) return null;
      let pinnedWorktreeGitDirectory: string;
      try {
        pinnedWorktreeGitDirectory = realpathSync(
          discoveredGitDir.stdout.trim(),
        );
        if (
          pinnedWorktreeGitDirectory !== context.gitDir ||
          !statSync(pinnedWorktreeGitDirectory).isDirectory()
        )
          return null;
      } catch {
        return null;
      }
      const discoveredCommonDirectory = discoverWorktreeRun([
        'rev-parse',
        '--path-format=absolute',
        '--git-common-dir',
      ]);
      if (
        discoveredCommonDirectory.status !== 0 ||
        realpathSync(discoveredCommonDirectory.stdout.trim()) !==
          pinnedCommonDirectory
      )
        return null;
      const descriptorRun = (args: string[]) =>
        spawnSync(
          'git',
          [
            '--git-dir',
            pinnedWorktreeGitDirectory,
            '--work-tree',
            worktree,
            '-c',
            'core.fsmonitor=false',
            '-c',
            'core.untrackedCache=false',
            ...args,
          ],
          {
            encoding: 'utf8',
            env,
            maxBuffer: 1024 * 1024,
            stdio: ['ignore', 'pipe', 'pipe', worktreeFd],
          },
        );
      const worktreeTopLevel = descriptorRun(['rev-parse', '--show-toplevel']);
      if (
        worktreeTopLevel.status !== 0 ||
        realpathSync(worktreeTopLevel.stdout.trim()) !== context.gitWorkTree
      )
        return null;
      const actualGitDir = descriptorRun([
        'rev-parse',
        '--path-format=absolute',
        '--absolute-git-dir',
      ]);
      if (
        actualGitDir.status !== 0 ||
        realpathSync(actualGitDir.stdout.trim()) !== context.gitDir
      )
        return null;
      const actualCommonDirectory = descriptorRun([
        'rev-parse',
        '--path-format=absolute',
        '--git-common-dir',
      ]);
      if (
        actualCommonDirectory.status !== 0 ||
        realpathSync(actualCommonDirectory.stdout.trim()) !==
          pinnedCommonDirectory
      )
        return null;
      const rechecked = pinnedRootRun([
        'worktree',
        'list',
        '--porcelain',
        '-z',
      ]);
      if (
        rechecked.status !== 0 ||
        !rechecked.stdout
          .split('\0')
          .filter((field) => field.startsWith('worktree '))
          .some(
            (field) => field.slice('worktree '.length) === context.gitWorkTree,
          )
      )
        return null;
      if (
        !noConfiguredContentFilters(pinnedRootRun) ||
        !noConfiguredContentFilters(descriptorRun)
      )
        return null;
      const head = descriptorRun(['rev-parse', '--verify', 'HEAD']);
      if (head.status !== 0 || !/^[a-f0-9]{40,64}$/iu.test(head.stdout.trim()))
        return null;
      if (!noIndexedGitlinks(descriptorRun)) return null;
      const status = descriptorRun([
        'status',
        '--porcelain=v1',
        '--untracked-files=normal',
      ]);
      if (status.status !== 0) return null;
      return { headSha: head.stdout.trim(), isDirty: status.stdout.length > 0 };
    } catch {
      return null;
    } finally {
      if (worktreeFd !== undefined) closeSync(worktreeFd);
    }
  }

  if (!noConfiguredContentFilters(pinnedRootRun)) return null;
  const head = pinnedRootRun(['rev-parse', '--verify', 'HEAD']);
  if (head.status !== 0 || !/^[a-f0-9]{40,64}$/iu.test(head.stdout.trim()))
    return null;
  if (!noIndexedGitlinks(pinnedRootRun)) return null;
  const status = pinnedRootRun([
    'status',
    '--porcelain=v1',
    '--untracked-files=normal',
  ]);
  if (status.status !== 0) return null;
  return { headSha: head.stdout.trim(), isDirty: status.stdout.length > 0 };
}

export function reportJourneyCommand(args: string[]): number {
  let report = refusalReport('invalid_arguments');
  const input = journeyArgs(args);
  if (input) {
    let repoRoot: string;
    try {
      if (!isAbsolute(input.repoRoot)) throw new Error('invalid root');
      repoRoot = realpathSync(input.repoRoot);
      if (!statSync(repoRoot).isDirectory()) throw new Error('invalid root');
    } catch {
      process.stdout.write(
        `${JSON.stringify(refusalReport('invalid_arguments'))}\n`,
      );
      return 1;
    }
    let context: ReturnType<typeof readTraceRepoContext> = null;
    let contextReadFailed = false;
    try {
      context = readTraceRepoContext(repoRoot, input.jobId);
    } catch {
      contextReadFailed = true;
    }
    const gitFacts = contextReadFailed
      ? null
      : reportGitFacts(repoRoot, context);
    if (!gitFacts) report = refusalReport('git_unavailable');
    else {
      try {
        const snapshot = readTraceSnapshot(repoRoot, input.jobId);
        report = deriveJourneyReport(snapshot, gitFacts);
      } catch {
        report = refusalReport('trace_unavailable');
      }
    }
  }
  process.stdout.write(`${JSON.stringify(report)}\n`);
  return report.kind === 'journey' ? 0 : 1;
}
