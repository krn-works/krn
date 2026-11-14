import { spawnSync } from 'node:child_process';

/** A trimmed-stdout git runner for a directory; a non-zero exit throws what `fail` builds from the message. */
export function gitWith(
  fail: (message: string) => Error,
): (cwd: string, args: string[]) => string {
  return (cwd, args) => {
    const result = spawnSync('git', ['-C', cwd, ...args], {
      encoding: 'utf8',
    });
    if (result.status !== 0)
      throw fail(
        `git ${args.join(' ')} failed: ${(result.stderr || result.stdout).trim()}`,
      );
    return result.stdout.trim();
  };
}

export const git = gitWith((message) => new Error(message));
