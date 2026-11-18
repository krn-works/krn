// .mcp.json sandbox placeholders: other empty read-only files the harness sandbox mounts over write-denied paths. A lane session
// can leave them in the main checkout and its git dir; they are never work.
import { lstatSync, readdirSync, rmSync } from 'node:fs';
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

/** True for an untracked-listing path that is an empty regular file under a name the sandbox masks. */
export function isSandboxPlaceholder(root: string, path: string): boolean {
  if (!rootNames.includes(path) && !/^\.env(\..+)?$/u.test(path)) return false;
  try {
    const info = lstatSync(join(root, path));
    return info.isFile() && info.size === 0;
  } catch {
    return false;
  }
}

/**
 * Remove the empty untracked files the sandbox leaves under masked names in a checkout's root,
 * writable or not and gitignored or not, so checks that read package.json or .env see the tree
 * the change left. Returns the removed names; a tracked or non-empty file is never touched.
 */
export function clearSandboxPlaceholders(root: string): string[] {
  const names = readdirSync(root).filter(
    (name) =>
      (rootNames.includes(name) || /^\.env(\..+)?$/u.test(name)) &&
      isSandboxPlaceholder(root, name) &&
      !git(root, ['ls-files', '--error-unmatch', '--', name]).ok,
  );
  for (const name of names) rmSync(join(root, name));
  return names;
}
