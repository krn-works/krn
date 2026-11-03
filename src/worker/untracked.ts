import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  opendirSync,
  openSync,
  readlinkSync,
  readSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, matchesGlob, relative } from 'node:path';
import { git } from './git.ts';
import { WorkerError } from './state.ts';

const limit = 10000;

// Consume NUL records as they arrive, so a large listing is refused, not truncated.
async function paths(
  cwd: string,
  args: string[],
  visit: (path: string) => void,
  input?: string,
  statuses = [0],
) {
  const child = spawn('git', args, {
    cwd,
    timeout: 10000,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
  });
  const completed = new Promise<number | Error | null>((done) => {
    child.once('error', done);
    child.once('close', done);
  });
  child.stdin.on('error', () => undefined);
  child.stdin.end(input);
  child.stderr.resume();
  child.stdout.setEncoding('utf8');
  let pending = '';
  try {
    for await (const chunk of child.stdout) {
      pending += chunk;
      let end = pending.indexOf('\0');
      while (end !== -1) {
        visit(pending.slice(0, end));
        pending = pending.slice(end + 1);
        end = pending.indexOf('\0');
      }
      if (pending.length > 65536)
        throw new WorkerError(70, 'invalid worker path enumeration');
    }
    const status = await completed;
    if (pending || typeof status !== 'number' || !statuses.includes(status))
      throw new WorkerError(70, 'worker path enumeration failed');
  } catch (error) {
    child.kill('SIGKILL');
    await completed;
    if (error instanceof WorkerError) throw error;
    throw new WorkerError(70, 'worker path enumeration failed');
  }
}

async function roots(repo: string, maximum: number) {
  const result: string[] = [];
  await paths(repo, ['ls-files', '--others', '--directory', '-z'], (path) => {
    result.push(path.replace(/\/$/, ''));
    if (result.length > maximum)
      throw new WorkerError(65, 'worker untracked paths exceed 10000');
  });
  return result;
}

// Git interprets committed ignore files in a private tree only while taking the
// baseline. No ignore file, global exclude or info/exclude in the worker tree
// influences subsequent enumeration.
async function ignoredRoots(
  repo: string,
  startCommit: string,
  run: string,
  candidates: string[],
) {
  const tree = mkdtempSync(join(run, 'tmp/ignore-'));
  try {
    git(tree, 'init', '-q', '--template=');
    let mode = '';
    let count = 0;
    await paths(
      repo,
      ['ls-tree', '-rz', '--format=%(objectmode)%x00%(path)', startCommit],
      (field) => {
        if (!mode) {
          mode = field;
          return;
        }
        if (
          (mode === '100644' || mode === '100755') &&
          (field === '.gitignore' || field.endsWith('/.gitignore'))
        ) {
          if (++count > limit)
            throw new WorkerError(65, 'worker ignore files exceed 10000');
          const target = join(tree, field);
          mkdirSync(dirname(target), { recursive: true });
          writeFileSync(target, git(repo, 'show', `${startCommit}:${field}`));
        }
        mode = '';
      },
    );
    const ignored = new Set<string>();
    if (candidates.length)
      await paths(
        tree,
        [
          '-c',
          'core.excludesFile=/dev/null',
          'check-ignore',
          '--no-index',
          '-z',
          '--stdin',
        ],
        (path) => ignored.add(path.replace(/\/$/, '')),
        candidates.map((path) => `${path}/\0`).join(''),
        [0, 1],
      );
    return ignored;
  } finally {
    rmSync(tree, { recursive: true, force: true });
  }
}

export async function untrackedBaseline(
  repo: string,
  startCommit: string,
  run: string,
  protectedRoots: string[] = ['.krn'],
  forbidden: string[] = [],
) {
  const initialRoots = await roots(repo, 2 * limit);
  const ignored = await ignoredRoots(repo, startCommit, run, initialRoots);
  const ownRun = relative(repo, run);
  const baseline = new Map<string, string>();
  let bytes = 0;
  let visited = 0;
  let directories = 0;
  let entries = 0;
  const underRun = (path: string) =>
    path === ownRun || path.startsWith(`${ownRun}/`);
  const runAncestor = (path: string) => ownRun.startsWith(`${path}/`);
  const protectedPath = (path: string) =>
    protectedRoots.some(
      (root) =>
        path === root ||
        path.startsWith(`${root}/`) ||
        root.startsWith(`${path}/`),
    );
  const scanRoots = (paths: string[]) => [
    ...paths.filter((path) => path !== '.krn' && !path.startsWith('.krn/')),
    '.krn',
  ];

  function walk(
    path: string,
    result: Map<string, string>,
    inheritedIgnore = false,
  ) {
    if (++entries > 1000000)
      throw new WorkerError(65, 'worker directory entries exceed 1000000');
    const stat = lstatSync(join(repo, path));
    if (underRun(path) && !stat.isSymbolicLink()) return;
    const isIgnored = inheritedIgnore || ignored.has(path);
    // Ignore ordinary dependency contents, while still observing control files
    // and symlinks hidden anywhere beneath a committed ignored root.
    if (
      isIgnored &&
      stat.isFile() &&
      !runAncestor(path) &&
      !protectedPath(path) &&
      !forbidden.some((glob) => matchesGlob(path, glob))
    )
      return;
    if (stat.isDirectory() ? ++directories > limit : ++visited > limit)
      throw new WorkerError(65, 'worker untracked paths exceed 10000');
    let value = `${stat.mode & constants.S_IFMT}:${stat.isDirectory() ? 0 : stat.size}`;
    if (stat.isSymbolicLink()) {
      const target = readlinkSync(join(repo, path));
      value += `:${createHash('sha256').update(target).digest('hex')}:${target}`;
    } else if (stat.isFile()) {
      bytes += stat.size;
      if (bytes > 1024 * 1024 * 1024)
        throw new WorkerError(65, 'worker untracked contents exceed 1 GB');
      const fd = openSync(
        join(repo, path),
        constants.O_RDONLY | constants.O_NOFOLLOW,
      );
      try {
        const opened = fstatSync(fd);
        if (
          opened.dev !== stat.dev ||
          opened.ino !== stat.ino ||
          opened.size !== stat.size
        )
          throw new WorkerError(
            65,
            'worker untracked file changed during read',
          );
        const hash = createHash('sha256');
        const buffer = Buffer.alloc(64 * 1024);
        let read = 0;
        for (;;) {
          const length = readSync(fd, buffer, 0, buffer.length, null);
          if (!length) break;
          read += length;
          if (read > stat.size)
            throw new WorkerError(
              65,
              'worker untracked file changed during read',
            );
          hash.update(buffer.subarray(0, length));
        }
        const after = fstatSync(fd);
        if (
          read !== stat.size ||
          after.mtimeMs !== stat.mtimeMs ||
          after.ctimeMs !== stat.ctimeMs
        )
          throw new WorkerError(
            65,
            'worker untracked file changed during read',
          );
        value += `:${hash.digest('hex')}`;
      } finally {
        closeSync(fd);
      }
    }
    result.set(path, value);
    if (!stat.isDirectory()) return;
    const dir = opendirSync(join(repo, path));
    try {
      for (let entry = dir.readSync(); entry; entry = dir.readSync())
        walk(join(path, entry.name), result, isIgnored);
    } finally {
      dir.closeSync();
    }
  }
  try {
    for (const path of scanRoots(initialRoots)) walk(path, baseline);
  } catch (error) {
    if (error instanceof WorkerError) throw error;
    throw new WorkerError(70, 'worker path enumeration failed');
  }
  return async () => {
    const result = new Map<string, string>();
    visited = 0;
    directories = 0;
    entries = 0;
    bytes = 0;
    try {
      for (const path of scanRoots(await roots(repo, limit + baseline.size)))
        walk(path, result);
    } catch (error) {
      if (error instanceof WorkerError) throw error;
      throw new WorkerError(70, 'worker path enumeration failed');
    }
    return [...new Set([...baseline.keys(), ...result.keys()])].filter(
      (path) =>
        baseline.get(path) !== result.get(path) &&
        // New empty directories are traversal only, as in Git's file model.
        (baseline.has(path) ||
          !result.get(path)?.startsWith(`${constants.S_IFDIR}:`)),
    );
  };
}
