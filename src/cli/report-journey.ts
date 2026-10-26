import { spawnSync } from 'node:child_process';
import {
  closeSync,
  constants,
  fstatSync,
  openSync,
  readlinkSync,
  realpathSync,
  statSync,
} from 'node:fs';
import { isAbsolute } from 'node:path';
import { deriveJourneyReport, refusalReport } from '../evals/journey.ts';
import { readTraceRepoContext, readTraceSnapshot } from '../trace/index.ts';

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

function noConfiguredContentSources(
  run: (args: string[]) => {
    status: number | null;
    stdout: string;
    stderr: string;
  },
): boolean {
  const sources = run([
    'config',
    '--null',
    '--get-regexp',
    '(^filter\\..*\\.(clean|process)$|^extensions\\.partialclone$|^remote\\..*\\.promisor$)',
  ]);
  return (
    sources.status === 1 &&
    sources.stdout.length === 0 &&
    sources.stderr.length === 0
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
  env.GIT_NO_LAZY_FETCH = '1';
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
        !noConfiguredContentSources(pinnedRootRun) ||
        !noConfiguredContentSources(descriptorRun)
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

  if (!noConfiguredContentSources(pinnedRootRun)) return null;
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
