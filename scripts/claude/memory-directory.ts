import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

// Claude Code keys auto memory by the main checkout, so worktrees share it.
export function memoryDirectory(root: string): string {
  let main = root;
  try {
    main = dirname(
      resolve(
        root,
        execFileSync('git', ['rev-parse', '--git-common-dir'], {
          cwd: root,
          encoding: 'utf8',
          timeout: 2000,
          stdio: ['ignore', 'pipe', 'ignore'],
        }).trim(),
      ),
    );
  } catch {
    /* Outside Git the root itself names the project. */
  }
  return join(
    homedir(),
    '.claude/projects',
    main.replace(/[^A-Za-z0-9]/gu, '-'),
    'memory',
  );
}
