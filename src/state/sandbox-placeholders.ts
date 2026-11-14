// Sandbox placeholders (.mcp.json and other empty read-only files) the harness sandbox mounts over write-denied paths. A lane session
// can leave them in the main checkout and its git dir; they are never work.
import { lstatSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { git } from './git.ts';

/** Root-level names the sandbox masks, as paths relative to the main checkout. */
const rootNames = [
  '.mcp.json',
  '.npmrc',
  '.yarnrc',
  '.yarnrc.yml',
  '.gitmodules',
  'bunfig.toml',
  'package.json',
  'package-lock.json',
  'npm-shrinkwrap.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  'bun.lock',
  'bun.lockb',
];

function emptyReadOnlyFile(path: string): boolean {
  try {
    const info = lstatSync(path);
    return info.isFile() && info.size === 0 && (info.mode & 0o200) === 0;
  } catch {
    return false;
  }
}

function envFiles(root: string): string[] {
  const listed = git(root, [
    'ls-files',
    '--others',
    '--exclude-standard',
    '--',
    '.env*',
  ]);
  return listed.ok
    ? listed.out
        .split('\n')
        .filter((name) => /^\.env(\..+)?$/u.test(name))
        .map((name) => join(root, name))
    : [];
}

/**
 * Absolute paths of the empty read-only untracked placeholder files in a checkout and its git
 * dir (.git/config.lock included). A non-empty, writable or tracked file is never listed.
 */
export function mainCheckoutPlaceholders(root: string): string[] {
  const gitDir = git(root, ['rev-parse', '--git-common-dir']);
  if (!gitDir.ok) return [];
  const lock = join(
    isAbsolute(gitDir.out) ? gitDir.out : join(root, gitDir.out),
    'config.lock',
  );
  const inTree = [
    ...rootNames.map((name) => join(root, name)),
    ...envFiles(root),
  ].filter(
    (path) =>
      emptyReadOnlyFile(path) &&
      !git(root, [
        'ls-files',
        '--error-unmatch',
        '--',
        path.slice(root.length + 1),
      ]).ok,
  );
  return emptyReadOnlyFile(lock) ? [...inTree, lock] : inTree;
}
