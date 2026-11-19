import { type SpawnSyncReturns, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { contractBase } from '../repo/contract.ts';
import { isTaskId, parseTaskDocument } from './record.ts';

/**
 * Task records created in the main checkout wait on this ref until `krn task publish` ships
 * them, so the main checkout's working tree stays clean. The ref's tree holds only
 * `tasks/<id>.json` entries; a record already on origin/<base> or in the working tree is no
 * longer pending and drops out at the next write.
 */
export const PENDING_REF = 'refs/krn/pending-tasks';

// The ref is internal bookkeeping: its commits carry a fixed identity, so an unconfigured
// clone can still record a task.
const IDENTITY = {
  GIT_AUTHOR_NAME: 'krn',
  GIT_AUTHOR_EMAIL: 'krn@localhost',
  GIT_COMMITTER_NAME: 'krn',
  GIT_COMMITTER_EMAIL: 'krn@localhost',
};

function git(
  root: string,
  args: string[],
  input?: string | Buffer,
): SpawnSyncReturns<Buffer> {
  return spawnSync('git', ['-C', root, ...args], {
    ...(input === undefined ? {} : { input }),
    env: { ...process.env, ...IDENTITY },
    maxBuffer: 64 * 1024 * 1024,
  });
}

function gitText(root: string, args: string[], input?: string): string {
  const run = git(root, args, input);
  if (run.status !== 0)
    throw new Error(
      `git ${args.join(' ')} failed: ${run.stderr.toString().trim()}`,
    );
  return run.stdout.toString().trim();
}

/** Whether `branch` exists on origin; false only when origin answers that it does not. */
export function branchOnOrigin(root: string, branch: string): boolean {
  return (
    git(root, ['ls-remote', '--exit-code', '--heads', 'origin', branch])
      .status !== 2
  );
}

/** Whether `root` is the main checkout rather than a linked worktree. */
export function isMainCheckout(root: string): boolean {
  const run = git(root, [
    'rev-parse',
    '--path-format=absolute',
    '--git-dir',
    '--git-common-dir',
  ]);
  if (run.status !== 0) return false;
  const [gitDir, commonDir] = run.stdout.toString().trim().split('\n');
  return gitDir !== undefined && gitDir === commonDir;
}

function baseRef(root: string): string | undefined {
  const ref = `origin/${contractBase(root)}`;
  return git(root, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`])
    .status === 0
    ? ref
    : undefined;
}

/**
 * Whether a record created in `root` goes to the pending ref: only in the main checkout of a
 * clone whose origin base branch exists, since publish cuts its branch from that base.
 */
export function pendingApplies(root: string): boolean {
  return isMainCheckout(root) && baseRef(root) !== undefined;
}

interface Entry {
  readonly name: string;
  readonly blob: string;
}

function refEntries(root: string): Entry[] {
  const run = git(root, ['ls-tree', '-z', `${PENDING_REF}^{tree}`, 'tasks/']);
  if (run.status !== 0) return [];
  const entries: Entry[] = [];
  for (const line of run.stdout.toString().split('\0')) {
    // Any valid task id: a narrower pattern left a pending close invisible to every read.
    const match = /^100644 blob ([0-9a-f]+)\ttasks\/([^/]+)\.json$/u.exec(line);
    if (match !== null && isTaskId(match[2]))
      entries.push({ blob: match[1] as string, name: `${match[2]}.json` });
  }
  return entries;
}

/** Every blob the base history holds for `tasks/<name>`: the record as published, then as changed. */
function publishedBlobs(root: string, base: string, name: string): Set<string> {
  const run = git(root, [
    'log',
    '--raw',
    '--no-abbrev',
    '--format=',
    base,
    '--',
    `tasks/${name}`,
  ]);
  const blobs = new Set<string>();
  if (run.status !== 0) return blobs;
  for (const line of run.stdout.toString().split('\n')) {
    const match = /^:\d+ \d+ [0-9a-f]+ ([0-9a-f]+) [ACMR]\d*\t/u.exec(line);
    if (match !== null) blobs.add(match[1] as string);
  }
  return blobs;
}

function stillPending(
  root: string,
  base: string | undefined,
  entry: Entry,
): boolean {
  const onBase =
    base !== undefined &&
    git(root, ['cat-file', '-e', `${base}:tasks/${entry.name}`]).status === 0;
  if (existsSync(join(root, 'tasks', entry.name))) {
    // An untracked file is a record taken out of the ref; a tracked one is published, and the
    // ref holds only an edit of it.
    if (!isTracked(root, entry.name)) return false;
    if (!onBase) return false;
  }
  if (base === undefined || !onBase) return true;
  // An edit is a pending blob the base never held: a record the base published and a lane later
  // changed (closed) is older than the base's, not an edit of it.
  return !publishedBlobs(root, base, entry.name).has(entry.blob);
}

function isTracked(root: string, name: string): boolean {
  return (
    git(root, ['ls-files', '--error-unmatch', '--', `tasks/${name}`]).status ===
    0
  );
}

/**
 * Whether an edit of `id` made in `root` goes to the pending ref: the main checkout holds a
 * published (tracked) record, which an in-place edit would leave as a dirty working tree.
 */
export function editGoesPending(root: string, id: string): boolean {
  return (
    existsSync(join(root, 'tasks', `${id}.json`)) &&
    pendingApplies(root) &&
    isTracked(root, `${id}.json`)
  );
}

function liveEntries(root: string): Entry[] {
  const entries = refEntries(root);
  if (entries.length === 0) return entries;
  const base = baseRef(root);
  return entries.filter((entry) => stillPending(root, base, entry));
}

/** Pending records of the main checkout by id; empty in a linked worktree. */
export function pendingTaskFiles(root: string): Map<string, Buffer> {
  const files = new Map<string, Buffer>();
  if (!isMainCheckout(root)) return files;
  for (const entry of liveEntries(root)) {
    const run = git(root, ['cat-file', 'blob', entry.blob]);
    if (run.status === 0) files.set(entry.name.slice(0, -5), run.stdout);
  }
  return files;
}

/** Whether `id` is held on the pending ref, whatever the working tree says. */
export function isPendingId(root: string, id: string): boolean {
  return refEntries(root).some((entry) => entry.name === `${id}.json`);
}

function writeEntries(root: string, entries: Entry[], message: string): void {
  const parent = git(root, [
    'rev-parse',
    '--verify',
    '--quiet',
    `${PENDING_REF}^{commit}`,
  ]);
  const old = parent.status === 0 ? parent.stdout.toString().trim() : '';
  const tasksTree = gitText(
    root,
    ['mktree', '-z'],
    entries
      .map((entry) => `100644 blob ${entry.blob}\t${entry.name}\0`)
      .join(''),
  );
  const tree = gitText(root, ['mktree'], `040000 tree ${tasksTree}\ttasks\n`);
  const commit = gitText(root, [
    'commit-tree',
    tree,
    ...(old === '' ? [] : ['-p', old]),
    '-m',
    message,
  ]);
  // Compare-and-swap: a concurrent create fails loudly instead of losing a record.
  gitText(root, ['update-ref', PENDING_REF, commit, old]);
}

/** Records `contents` as the pending record of `id`; stale entries drop out. */
export function addPendingTask(root: string, id: string, contents: string) {
  const blob = gitText(root, ['hash-object', '-w', '--stdin'], contents);
  const name = `${id}.json`;
  const entries = liveEntries(root).filter((entry) => entry.name !== name);
  entries.push({ name, blob });
  writeEntries(root, entries, `pending task ${id}`);
}

/** Removes `ids` from the pending ref; the ref is deleted once nothing is pending. */
export function removePendingTasks(root: string, ids: readonly string[]) {
  const names = new Set(ids.map((id) => `${id}.json`));
  const before = refEntries(root);
  if (!before.some((entry) => names.has(entry.name))) return;
  const entries = liveEntries(root).filter((entry) => !names.has(entry.name));
  if (entries.length === 0) {
    gitText(root, ['update-ref', '-d', PENDING_REF]);
    return;
  }
  writeEntries(root, entries, `published ${ids.join(' ')}`);
}

/**
 * Moves the pending record of `id` into the main checkout's `tasks/` (untracked), so a lane start
 * carries it like any record created there; returns whether one moved.
 */
export function takePendingTask(root: string, id: string): boolean {
  const contents = pendingTaskFiles(root).get(id);
  if (contents === undefined) return false;
  mkdirSync(join(root, 'tasks'), { recursive: true });
  writeFileSync(join(root, 'tasks', `${id}.json`), contents, { flag: 'wx' });
  removePendingTasks(root, [id]);
  return true;
}

export interface PublishCommit {
  readonly ids: string[];
  readonly title: string;
  readonly body: string;
}

/**
 * Writes the pending records into `worktree` and commits them as one commit. The commit refers to
 * the first id with `Refs:`: the records stay open, and CI refuses `Ticket:` on an open task.
 */
export function commitPendingRecords(
  worktree: string,
  files: ReadonlyMap<string, Buffer>,
): PublishCommit {
  const ids = [...files.keys()].sort();
  const first = ids[0];
  if (first === undefined) throw new Error('no pending task records');
  mkdirSync(join(worktree, 'tasks'), { recursive: true });
  const lines: string[] = [];
  for (const id of ids) {
    const contents = files.get(id) as Buffer;
    writeFileSync(join(worktree, 'tasks', `${id}.json`), contents);
    lines.push(`- ${id} ${parseTaskDocument(contents).record?.title ?? ''}`);
  }
  gitText(worktree, ['add', '--', ...ids.map((id) => `tasks/${id}.json`)]);
  const title = `chore(tasks): ${ids.length} task record${ids.length === 1 ? '' : 's'} (${first})`;
  gitText(worktree, [
    'commit',
    '-q',
    '-m',
    title,
    '-m',
    lines.join('\n'),
    '-m',
    `Refs: ${first}`,
  ]);
  const body = `## Why\n\nTask records created in the main checkout reach the tracker:\n\n${lines.join('\n')}\n\n## Verified\n\nkrn task check runs in CI.\n\n## Task\n\nRefs: ${first}\n`;
  return { ids, title, body };
}
