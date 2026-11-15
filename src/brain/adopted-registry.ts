// The host registry of adopted repositories: a JSON array of absolute repository roots that
// `krn adopt` appends to and `krn standards harvest` reads when given no repository.
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, relative, sep } from 'node:path';

export const REGISTRY_ENV = 'KRN_ADOPTED_REGISTRY';

/** The registry file: the variable when set, else `~/.krn/adopted.json` (untracked, it names private repositories). */
export function registryPath(env: NodeJS.ProcessEnv = process.env): string {
  return env[REGISTRY_ENV] || join(homedir(), '.krn', 'adopted.json');
}

/** The paths in a registry file; none when it is absent or not an array of strings. */
export function readRegistry(file: string): string[] {
  if (!existsSync(file)) return [];
  try {
    const value: unknown = JSON.parse(readFileSync(file, 'utf8'));
    return Array.isArray(value)
      ? value.filter((entry): entry is string => typeof entry === 'string')
      : [];
  } catch {
    return [];
  }
}

/**
 * The registered paths that still exist, and how many were dropped. A registry that lost paths is
 * rewritten without them, so a scratch repository removed from disk never serves a refresh or a doctor run.
 */
export function pruneRegistry(file: string): {
  roots: string[];
  pruned: number;
} {
  const listed = readRegistry(file);
  const roots = listed.filter((root) => existsSync(root));
  const pruned = listed.length - roots.length;
  if (pruned > 0) writeRegistry(file, roots);
  return { roots, pruned };
}

function writeRegistry(file: string, roots: string[]): void {
  mkdirSync(dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(roots, null, 2)}\n`);
  renameSync(temporary, file);
}

const inside = (child: string, parent: string) => {
  const path = relative(parent, child);
  return path !== '' && !path.startsWith('..') && !path.includes(`${sep}..`);
};

/**
 * Appends `root` to the registry once. A repository under the system temp directory is
 * skipped unless the registry was named explicitly, so scratch adoptions never reach the host.
 */
export function registerAdopted(
  root: string,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const real = realpathSync(root);
  if (!env[REGISTRY_ENV] && inside(real, realpathSync(tmpdir()))) return false;
  const file = registryPath(env);
  const known = readRegistry(file);
  if (known.includes(real)) return false;
  writeRegistry(file, [...known, real]);
  return true;
}
