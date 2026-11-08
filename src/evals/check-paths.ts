import { spawnSync } from 'node:child_process';
import { constants } from 'node:fs';
import { access, lstat, mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, parse, relative, resolve, sep } from 'node:path';
import { EvalDataError } from './manifest.ts';

// Inspect the spelling supplied by the caller before normalizing it: a symlink
// followed by /.. is still a symlink traversal and must not disappear.
export async function checkDirectory(
  path: string,
  create = false,
): Promise<string> {
  try {
    if (!path || path.includes('\0') || path.includes('\\'))
      throw new EvalDataError(
        `invalid directory path: ${JSON.stringify(path)}`,
      );
    const root = isAbsolute(path) ? parse(path).root : process.cwd();
    let current = root;
    for (const part of path
      .slice(isAbsolute(path) ? root.length : 0)
      .split(sep)) {
      if (!part) continue;
      current = join(current, part);
      const stat = await lstat(current).catch(async (error: unknown) => {
        if (
          !(
            create &&
            error instanceof Error &&
            'code' in error &&
            error.code === 'ENOENT'
          )
        )
          throw error;
        await mkdir(current);
        return lstat(current);
      });
      if (stat.isSymbolicLink() || !stat.isDirectory())
        throw new EvalDataError(
          `directory path must not contain symlinks or files: ${current}`,
        );
      await access(current, constants.R_OK | constants.X_OK);
    }
    return resolve(path);
  } catch (error) {
    if (error instanceof EvalDataError) throw error;
    throw new EvalDataError(
      `directory path ${path}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function inside(path: string, parent: string): boolean {
  const rest = relative(parent, path);
  return (
    rest === '' ||
    (!isAbsolute(rest) && rest !== '..' && !rest.startsWith(`..${sep}`))
  );
}

export function separate(left: string, right: string): void {
  if (inside(left, right) || inside(right, left))
    throw new EvalDataError(`check paths overlap: ${left} and ${right}`);
}

export async function checkNode(
  version: string,
  protectedPaths: string[],
): Promise<string> {
  const data =
    process.env.MISE_DATA_DIR ?? join(homedir(), '.local/share/mise');
  const bin = join(data, 'installs/node', version, 'bin');
  try {
    await checkDirectory(data);
    await checkDirectory(bin);
    for (const path of protectedPaths) separate(resolve(bin), path);
    const node = join(bin, 'node');
    const stat = await lstat(node);
    if (!stat.isFile() || stat.isSymbolicLink())
      throw new Error('expected a regular Node executable');
    const result = spawnSync(node, ['--version'], {
      encoding: 'utf8',
      env: { ...process.env, NODE_OPTIONS: '' },
      timeout: 10_000,
    });
    if (
      result.error ||
      result.status !== 0 ||
      result.stdout.trim() !== `v${version}`
    )
      throw new Error(
        `version mismatch or unavailable executable: ${result.error?.message ?? result.stdout.trim()}`,
      );
    return resolve(bin);
  } catch (error) {
    throw new EvalDataError(
      `Node ${version}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
