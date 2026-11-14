import { spawnSync } from 'node:child_process';
import { tokenHelper } from './lane-run/environment.ts';

/**
 * The owner/name a GitHub remote URL names (https or scp-style ssh), else undefined.
 */
export function repositoryOfRemote(url: string): string | undefined {
  const match =
    /^(?:https?:\/\/(?:[^@/]+@)?github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([A-Za-z0-9][\w.-]*)\/([\w.-]+?)(?:\.git)?\/?$/u.exec(
      url.trim(),
    );
  return match?.[1] && match[2] ? `${match[1]}/${match[2]}` : undefined;
}

/**
 * git `-c` arguments that empty the inherited github.com credential helpers and install the
 * per-repository App token helper for `repository`; the token never appears in the arguments.
 */
export function appCredentialArgs(
  repository: string,
  node = process.execPath,
): string[] {
  const key = 'credential.https://github.com.helper';
  return [
    '-c',
    `${key}=`,
    '-c',
    `${key}=!KRN_APP_REPOSITORY='${repository}' '${node}' '${tokenHelper}' git-credential`,
  ];
}

/** git in `cwd`; a github.com origin gets that repository's App token credential helper. */
export function outsideGit(
  cwd: string,
  args: string[],
  run: typeof spawnSync = spawnSync,
): string {
  const url = run('git', ['-C', cwd, 'remote', 'get-url', 'origin'], {
    encoding: 'utf8',
  });
  const repository =
    url.status === 0 ? repositoryOfRemote(String(url.stdout)) : undefined;
  const result = run(
    'git',
    [
      ...(repository === undefined ? [] : appCredentialArgs(repository)),
      '-C',
      cwd,
      ...args,
    ],
    { encoding: 'utf8' },
  );
  if (result.status !== 0)
    throw new Error(
      `git ${args.join(' ')} failed: ${String(result.stderr).trim()}`,
    );
  return String(result.stdout).trim();
}
