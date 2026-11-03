import { spawnSync } from 'node:child_process';
import { lstatSync, readFileSync, realpathSync, unlinkSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

function git(root: string, args: string[]) {
  return spawnSync('git', ['--literal-pathspecs', '-C', root, ...args], {
    encoding: 'buffer',
    maxBuffer: 32 * 1024 * 1024,
  });
}

export function removeIdenticalLeftovers(root: string, maxPaths = 10000): void {
  const diff = git(root, [
    'diff',
    '--name-only',
    '-z',
    '--no-renames',
    '--diff-filter=AM',
    'HEAD',
    'origin/main',
  ]);
  if (diff.status !== 0) throw new Error('unable to list incoming paths');
  const paths = diff.stdout.toString().split('\0').filter(Boolean);
  if (paths.length > maxPaths) throw new Error('too many incoming paths');
  const canonicalRoot = realpathSync(root);
  for (const path of paths) {
    const absolute = resolve(root, path);
    try {
      const parent = realpathSync(dirname(absolute));
      if (parent !== dirname(resolve(canonicalRoot, path))) continue;
      const stat = lstatSync(absolute);
      if (!stat.isFile() || stat.size > 16 * 1024 * 1024) continue;
      const blob = git(root, ['cat-file', 'blob', `origin/main:${path}`]);
      if (blob.status !== 0) throw new Error('unable to read incoming blob');
      if (
        blob.stdout.length !== stat.size ||
        !readFileSync(absolute).equals(blob.stdout)
      )
        continue;
      const literal = ['--', path];
      // A staged change (including a staged deletion of a HEAD path) is the
      // operator's work: leave it for the fast-forward to decide.
      const clean = git(root, [
        'diff',
        '--cached',
        '--quiet',
        'HEAD',
        ...literal,
      ]);
      if (clean.status === 1) continue;
      if (clean.status !== 0) throw new Error('unable to inspect staged path');
      const tracked = git(root, ['ls-files', '--error-unmatch', ...literal]);
      if (tracked.status === 0) {
        const checkout = git(root, ['checkout', ...literal]);
        if (checkout.status !== 0)
          throw new Error('unable to restore identical tracked path');
      } else if (tracked.status === 1) unlinkSync(absolute);
      else throw new Error('unable to inspect incoming path');
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'ELOOP') continue;
      throw error;
    }
  }
}
