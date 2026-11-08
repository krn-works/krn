import { execFile } from 'node:child_process';
import { lstat, mkdir, readFile, realpath, stat } from 'node:fs/promises';
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from 'node:path';
import { promisify } from 'node:util';
import { CliUsageError } from '../cli/usage-error.ts';
import { EvalDataError, type WozManifest } from './manifest.ts';

const execute = promisify(execFile);

function gitEnvironment() {
  // Ambient Git state must neither redirect the snapshot nor write to a source.
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')),
  );
  return {
    ...env,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_SYSTEM: '/dev/null',
    GIT_TERMINAL_PROMPT: '0',
    GIT_OPTIONAL_LOCKS: '0',
    GIT_NO_LAZY_FETCH: '1',
  };
}

async function git(repo: string, args: string[]): Promise<string> {
  const result = await execute(
    'git',
    [
      '-C',
      repo,
      '-c',
      'core.logAllRefUpdates=false',
      '-c',
      'core.hooksPath=/dev/null',
      '-c',
      'maintenance.auto=false',
      '-c',
      'gc.auto=0',
      ...args,
    ],
    { env: gitEnvironment(), maxBuffer: 64 * 1024 * 1024 },
  );
  return result.stdout.trim();
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

// Resolve existing parents too, even when the requested leaf does not exist.
async function destination(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch (error) {
    if (!isMissing(error)) throw error;
    const parent = dirname(path);
    if (parent === path) throw error;
    // A dangling symlink is an entry, not a directory we may create.
    if (await exists(path))
      throw new EvalDataError(`root path is not a directory: ${path}`);
    return join(await destination(parent), basename(path));
  }
}

function inside(path: string, parent: string): boolean {
  const child = relative(parent, path);
  return (
    child === '' ||
    (!isAbsolute(child) && child !== '..' && !child.startsWith(`..${sep}`))
  );
}

function overlaps(left: string, right: string): boolean {
  return inside(left, right) || inside(right, left);
}

async function inspectAncestors(root: string): Promise<void> {
  let path = root;
  for (;;) {
    if (await exists(join(path, '.krn')))
      throw new EvalDataError(`root ancestor ${path} contains .krn`);
    const gitMarker = join(path, '.git');
    try {
      const marker = await stat(gitMarker);
      // Empty .git mount-point debris is not a repository; Gitfiles and
      // .git directories with HEAD identify actual repositories.
      if (
        marker.isFile() ||
        (marker.isDirectory() && (await exists(join(gitMarker, 'HEAD'))))
      )
        throw new EvalDataError(`root ancestor ${path} contains .git`);
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
    if (dirname(path) === path) return;
    path = dirname(path);
  }
}

async function directory(path: string): Promise<void> {
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink())
    throw new EvalDataError(
      `root path must be a directory without symlinks: ${path}`,
    );
}

function invariant(ok: boolean, name: string): void {
  if (!ok) throw new EvalDataError(`snapshot invariant failed: ${name}`);
}

function lines(value: string): string[] {
  return value === '' ? [] : value.split('\n');
}

async function verifySnapshot(repo: string, base: string, exemplar: string) {
  const objects = lines(
    await git(repo, ['cat-file', '--batch-all-objects', '--batch-check']),
  )
    .map((line) => line.split(' ')[0])
    .sort();
  const reachable = lines(await git(repo, ['rev-list', '--objects', base]))
    .map((line) => line.split(' ')[0])
    .sort();
  invariant(
    objects.length === reachable.length,
    'object count equals reachable base objects',
  );
  invariant(
    objects.every((object, index) => object === reachable[index]),
    'only reachable base objects',
  );
  let exemplarPresent = true;
  try {
    await git(repo, ['cat-file', '-e', exemplar]);
  } catch {
    exemplarPresent = false;
  }
  invariant(!exemplarPresent, 'exemplar object is absent');
  invariant(
    (await git(repo, ['rev-list', '--all'])) === base,
    'depth-one base history',
  );
  invariant((await git(repo, ['remote'])) === '', 'no remotes');
  invariant((await git(repo, ['tag'])) === '', 'no tags');
  invariant(
    (await git(repo, ['reflog', 'show', '--all'])) === '',
    'no reflog entries',
  );
  invariant(!(await exists(join(repo, '.git', 'hooks'))), 'no hooks');
  invariant(
    (await git(repo, ['symbolic-ref', 'HEAD'])) === 'refs/heads/main',
    'HEAD points to main',
  );
  invariant(
    (await git(repo, ['for-each-ref', '--format=%(refname) %(objectname)'])) ===
      `refs/heads/main ${base}\nrefs/remotes/origin/main ${base}`,
    'main and origin/main are the only refs and equal base',
  );
  invariant(
    (await git(repo, ['status', '--porcelain=v1', '--untracked-files=all'])) ===
      '',
    'clean base checkout',
  );
  invariant(
    (await readFile(join(repo, '.git', 'shallow'), 'utf8')).trim() === base,
    'shallow boundary equals base',
  );
  return objects.length;
}

export async function prepareExperiment(
  manifest: WozManifest,
  options: {
    experiment: string;
    root: string;
    sources: { label: string; path: string }[];
    draft: boolean;
  },
) {
  try {
    if (!manifest.frozen && !options.draft)
      throw new EvalDataError(
        'experiment must be frozen; use --draft to prepare a draft experiment',
      );
    const labels = new Set(manifest.tasks.map((task) => task.repository));
    const sources = new Map<string, string>();
    for (const { label, path } of options.sources) {
      if (!labels.has(label))
        throw new CliUsageError(`unknown --source label "${label}"`);
      if (sources.has(label))
        throw new CliUsageError(`duplicate --source label "${label}"`);
      sources.set(label, path);
    }
    for (const label of labels) {
      if (!sources.has(label))
        throw new CliUsageError(`missing --source for repository "${label}"`);
    }
    if (!isAbsolute(options.root))
      throw new EvalDataError('root must be absolute');
    const root = await destination(resolve(options.root));
    await inspectAncestors(resolve(options.root));
    await inspectAncestors(root);
    const forbidden = [await realpath(options.experiment)];
    for (const [label, path] of sources) {
      const source = await realpath(path);
      sources.set(label, source);
      forbidden.push(source);
    }
    const experimentRoot = join(root, manifest.id);
    const experimentDestination = await destination(experimentRoot);
    for (const target of [root, experimentDestination]) {
      for (const path of forbidden) {
        if (overlaps(target, path))
          throw new EvalDataError(
            `root or experiment directory overlaps source or experiment: ${path}`,
          );
      }
    }
    if (await exists(experimentRoot)) await directory(experimentRoot);
    for (const task of manifest.tasks) {
      const slot = join(experimentRoot, task.id);
      if (await exists(slot))
        throw new EvalDataError(`task directory already exists: ${slot}`);
      const source = sources.get(task.repository);
      if (source === undefined)
        throw new CliUsageError(`missing --source for ${task.repository}`);
      try {
        if ((await git(source, ['cat-file', '-t', task.baseSha])) !== 'commit')
          throw new Error('not a commit');
      } catch {
        throw new EvalDataError(
          `${task.id}: base ${task.baseSha} is missing or is not a commit in source`,
        );
      }
    }
    await mkdir(root, { recursive: true });
    await mkdir(experimentRoot, { recursive: true });
    await directory(experimentRoot);
    const tasks = [];
    for (const task of manifest.tasks) {
      const slot = join(experimentRoot, task.id);
      await mkdir(slot); // Claim a fresh directory; never reuse partial output.
      const repo = join(slot, 'repo');
      const source = sources.get(task.repository);
      if (source === undefined)
        throw new CliUsageError(`missing --source for ${task.repository}`);
      await git(slot, [
        'init',
        '--quiet',
        '--template=',
        '--initial-branch=main',
        repo,
      ]);
      await git(repo, ['config', 'core.logAllRefUpdates', 'false']);
      // Fetch a SHA, not a branch or a local clone: no future, dangling or
      // shared objects, no remote configuration and no FETCH_HEAD/reflog.
      await git(repo, [
        'fetch',
        '--quiet',
        '--no-tags',
        '--no-write-fetch-head',
        '--depth=1',
        '--',
        source,
        task.baseSha,
      ]);
      await git(repo, ['update-ref', 'refs/heads/main', task.baseSha]);
      await git(repo, ['update-ref', 'refs/remotes/origin/main', task.baseSha]);
      await git(repo, ['checkout', '--quiet', '--force', 'main']);
      const objectCount = await verifySnapshot(
        repo,
        task.baseSha,
        task.exemplarSha,
      );
      tasks.push({ id: task.id, base: task.baseSha, objectCount, path: repo });
    }
    return { experiment: manifest.id, tasks };
  } catch (error) {
    if (error instanceof EvalDataError || error instanceof CliUsageError)
      throw error;
    throw new EvalDataError(
      `prepare: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
