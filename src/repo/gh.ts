import { spawnSync } from 'node:child_process';

/** Runs one external command and resolves with its stdout. */
export type CommandRun = (
  cmd: string,
  args: string[],
) => string | Promise<string>;

/**
 * The gh binary for ledger and window reads: the only place those modules name it.
 * `run` is the injected process runner, so tests replay captured gh replies.
 */
export const gh = async (run: CommandRun, args: string[]): Promise<string> =>
  run('gh', args);

/** `gh repo view` reply naming the repository of the working directory. */
export const ghRepoView = (run: CommandRun): Promise<string> =>
  gh(run, ['repo', 'view', '--json', 'nameWithOwner']);

export type GhSyncReply = {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly error?: Error;
};

/** One blocking `gh api <path>` read from `root`, for the adoption check. */
export function ghApiSync(root: string, path: string): GhSyncReply {
  const reply = spawnSync('gh', ['api', path], {
    cwd: root,
    encoding: 'utf8',
  });
  return {
    status: reply.status,
    stdout: reply.stdout ?? '',
    stderr: reply.stderr ?? '',
    ...(reply.error ? { error: reply.error } : {}),
  };
}

/** One blocking `gh pr view --json <fields>` of the branch checked out in `root`. */
export function ghPrViewSync(root: string, fields: string): GhSyncReply {
  const reply = spawnSync('gh', ['pr', 'view', '--json', fields], {
    cwd: root,
    encoding: 'utf8',
    timeout: 20_000,
  });
  return {
    status: reply.status,
    stdout: reply.stdout ?? '',
    stderr: reply.stderr ?? '',
    ...(reply.error ? { error: reply.error } : {}),
  };
}

/** One blocking `gh pr list` of the open PRs of `root` with their check rollups, for the open-red lane limit. */
export function ghPrListOpenSync(root: string): GhSyncReply {
  const reply = spawnSync(
    'gh',
    [
      'pr',
      'list',
      '--state',
      'open',
      '--limit',
      '100',
      '--json',
      'number,statusCheckRollup',
    ],
    { cwd: root, encoding: 'utf8', timeout: 20_000 },
  );
  return {
    status: reply.status,
    stdout: reply.stdout ?? '',
    stderr: reply.stderr ?? '',
    ...(reply.error ? { error: reply.error } : {}),
  };
}
