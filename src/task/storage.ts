import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { contractBase } from '../repo/contract.ts';
import {
  ARCHIVE_AFTER_DAYS,
  type ArchivedLine,
  archiveTexts,
  dueForArchive,
  findArchived,
  readArchive,
} from './archive.ts';
import {
  addPendingTask,
  commitPendingRecords,
  editGoesPending,
  type PublishCommit,
  pendingApplies,
  pendingTaskFiles,
  removePendingTasks,
  takePendingTask,
} from './pending.ts';
import {
  parseTaskDocument,
  serializeTask,
  TaskDataError,
  type TaskId,
  type TaskRecord,
} from './record.ts';
import { atomicWrite } from './staged-write.ts';

/** Where a task record lives: the pending ref, `tasks/`, the archive, or nowhere. */
export type TaskLocation = 'pending' | 'tree' | 'archived' | 'absent';

export interface LocatedTask {
  where: TaskLocation;
  record?: TaskRecord;
}

/**
 * The one owner of where a task record lives. Precedence is the pending ref, then `tasks/`,
 * then the archive; a malformed record in `tasks/` is reported, not skipped.
 */
export function locateTask(root: string, id: TaskId): LocatedTask {
  const pending = pendingTaskFiles(root).get(id);
  if (pending !== undefined) {
    const parsed = parseTaskDocument(pending);
    if (parsed.record !== undefined && parsed.id === id)
      return { where: 'pending', record: parsed.record };
  }
  const path = join(root, 'tasks', `${id}.json`);
  if (existsSync(path)) {
    const parsed = parseTaskDocument(readFileSync(path));
    if (parsed.record === undefined || parsed.id !== id)
      throw new TaskDataError(
        parsed.findings.map((finding) => `tasks/${id}.json: ${finding}`),
      );
    return { where: 'tree', record: parsed.record };
  }
  const archived = findArchived(root, id);
  if (archived !== undefined) return { where: 'archived', record: archived };
  return { where: 'absent' };
}

/** The pending ref's record texts by id: the versions that replace a `tasks/` copy of the same id. */
export function pendingRecordTexts(root: string): Map<TaskId, Buffer> {
  return pendingTaskFiles(root);
}

/** The archive's lines, the lowest precedence of `locateTask`. */
export function archivedLines(root: string): ArchivedLine[] {
  return readArchive(root);
}

/** Whether a record of `where` is written to the pending ref (a published record is, in the main checkout). */
function writesPending(root: string, id: TaskId, where: TaskLocation) {
  if (where === 'pending') return true;
  if (where === 'tree') return editGoesPending(root, id);
  return where === 'absent' && pendingApplies(root);
}

/**
 * Writes `record` where `locateTask` finds it: pending stays pending, a published record stays
 * in the tree (on the pending ref when the main checkout would otherwise be left dirty), an
 * archived one is refused with exit 65. A new record goes to the pending ref in the main
 * checkout and to `tasks/` in a lane worktree.
 */
export function writeTaskRecord(root: string, record: TaskRecord): void {
  const { where } = locateTask(root, record.id);
  if (where === 'archived')
    throw new TaskDataError([
      `tasks/${record.id}.json: task is archived and read-only; create a new task instead`,
    ]);
  const contents = serializeTask(record);
  if (writesPending(root, record.id, where))
    addPendingTask(root, record.id, contents);
  else
    atomicWrite(root, join(root, 'tasks', `${record.id}.json`), contents, true);
}

/** Whether a record created in `root` waits on the pending ref (the main checkout) rather than `tasks/`. */
export function createsPending(root: string): boolean {
  return pendingApplies(root);
}

/**
 * Creates a new record on the pending ref when the caller asked for it (`createsPending` says it
 * applies), else in `tasks/`, where a file that already exists throws EEXIST.
 */
export function createTaskRecord(
  root: string,
  record: TaskRecord,
  pending = false,
): void {
  const contents = serializeTask(record);
  if (pending) addPendingTask(root, record.id, contents);
  else atomicWrite(root, join(root, 'tasks', `${record.id}.json`), contents);
}

/**
 * Moves the pending record of `id` into the checkout's `tasks/`; `restore` puts the ref and the
 * checkout back as they were. Undefined when nothing is pending for `id`.
 */
export function takePendingRecord(
  root: string,
  id: TaskId,
): { restore: () => void } | undefined {
  const contents = pendingTaskFiles(root).get(id);
  if (contents === undefined) return undefined;
  const file = join(root, 'tasks', `${id}.json`);
  const before = existsSync(file) ? readFileSync(file) : undefined;
  takePendingTask(root, id);
  return {
    restore: () => {
      if (before === undefined) rmSync(file, { force: true });
      else writeFileSync(file, before);
      addPendingTask(root, id, contents.toString());
    },
  };
}

/** Commits the pending records into `worktree` as one commit; the ref keeps them until `settlePublished`. */
export function publishPendingRecords(
  worktree: string,
  files: ReadonlyMap<string, Buffer>,
): PublishCommit {
  return commitPendingRecords(worktree, files);
}

/** Drops published records from the pending ref. */
export function settlePublished(root: string, ids: readonly string[]): void {
  removePendingTasks(root, ids);
}

/** A record of the main checkout a lane start carries: the file and whether git tracks it. */
export interface CarriedRecord {
  readonly file: string;
  readonly tracked: boolean;
}

/** Copies a carried record into the lane worktree; false when the lane already holds an untracked copy. */
export function carryTaskRecord(
  { file, tracked }: CarriedRecord,
  worktree: string,
  id: TaskId,
): boolean {
  const target = join(worktree, 'tasks', `${id}.json`);
  if (existsSync(target) && !tracked) return false;
  mkdirSync(dirname(target), { recursive: true });
  copyFileSync(file, target);
  return true;
}

/** Removes the checkout's untracked copy of a record the lane now holds. */
export function dropCarriedCopy(carried: CarriedRecord): void {
  rmSync(carried.file);
}

export interface ArchiveResult {
  archived: TaskId[];
  files: string[];
}

/**
 * Moves closed tasks created at least `olderThanDays` before `today` into
 * `tasks/archive/<YYYY-MM>.jsonl`, wherever `locateTask` finds them: a record in `tasks/` and a
 * pending one both end up in the archive, and neither location keeps a copy. The archive files
 * are on disk before any source is removed, so an interrupted run loses nothing.
 */
export function archiveClosedTasks(
  root: string,
  records: Iterable<TaskRecord>,
  today: Date,
  olderThanDays = ARCHIVE_AFTER_DAYS,
): ArchiveResult {
  const moving: TaskRecord[] = [];
  const pending: TaskId[] = [];
  for (const { id } of [...records].filter((record) =>
    dueForArchive(record, today, olderThanDays),
  )) {
    const found = locateTask(root, id);
    if (found.where === 'archived' || found.record === undefined) continue;
    if (!dueForArchive(found.record, today, olderThanDays)) continue;
    moving.push(found.record);
    if (found.where === 'pending') pending.push(id);
  }
  const texts = archiveTexts(root, moving);
  for (const [file, text] of texts)
    atomicWrite(root, join(root, file), text, true);
  for (const record of moving)
    rmSync(join(root, 'tasks', `${record.id}.json`), { force: true });
  removePendingTasks(root, pending);
  return {
    archived: moving.map((record) => record.id).sort(),
    files: [...texts.keys()],
  };
}

function gitText(root: string, args: string[]): string | undefined {
  const out = spawnSync('git', ['-C', root, ...args], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  return out.status === 0 ? out.stdout : undefined;
}

/** A record text in one form, so a reformatted copy of the same record compares equal. */
function normalized(text: string): string {
  const parsed = parseTaskDocument(text);
  return parsed.record === undefined ? text : serializeTask(parsed.record);
}

/** The worktree path of `branch`: the lane directory when it exists (also detached), else the one git lists. */
function worktreeOfBranch(main: string, branch: string): string | undefined {
  const lane = join(main, '.krn', 'worktrees', branch);
  if (existsSync(lane)) return lane;
  const listing = gitText(main, ['worktree', 'list', '--porcelain', '-z']);
  let path: string | undefined;
  for (const field of (listing ?? '').split('\0')) {
    if (field.startsWith('worktree ')) path = field.slice('worktree '.length);
    else if (field === `branch refs/heads/${branch}` && path !== undefined)
      return path;
  }
  return undefined;
}

const nulList = (text: string | undefined) =>
  (text ?? '').split('\0').filter(Boolean);

/** Every `tasks/<id>.json` version the lane holds: its worktree files and index, or its branch tip. */
function laneVersions(main: string, branch: string): Map<TaskId, string[]> {
  const base = contractBase(main);
  const published = (ref: string) =>
    spawnSync('git', [
      '-C',
      main,
      'merge-base',
      '--is-ancestor',
      ref,
      `origin/${base}`,
    ]).status === 0;
  const found = new Map<TaskId, string[]>();
  const add = (path: string, text: string | undefined) => {
    const match = /^tasks\/(t-[a-z0-9]+)\.json$/u.exec(path);
    if (match?.[1] === undefined || text === undefined) return;
    const id = match[1] as TaskId;
    found.set(id, [...(found.get(id) ?? []), text]);
  };
  // The lane's versions are the set {branch tip blob, index blob, worktree file}, each read on its own:
  // the absence of one never hides another.
  const tip = `refs/heads/${branch}`;
  const tipPaths = nulList(
    gitText(main, ['ls-tree', '-r', '-z', '--name-only', tip, '--', 'tasks']),
  );
  const tipText = (path: string) => gitText(main, ['show', `${tip}:${path}`]);
  // A version unchanged from a tip already on origin/<base> is published.
  const tipPublished = published(tip);
  const keep = (path: string, text: string | undefined) =>
    text !== undefined && !(tipPublished && text === tipText(path))
      ? text
      : undefined;
  for (const path of tipPaths) add(path, keep(path, tipText(path)));
  const worktree = worktreeOfBranch(main, branch);
  if (worktree === undefined) return found;
  const paths = new Set(
    nulList(
      gitText(worktree, [
        'ls-files',
        '-z',
        '--cached',
        '--others',
        '--exclude-standard',
        '--',
        'tasks',
      ]),
    ),
  );
  for (const path of paths) {
    const file = join(worktree, path);
    if (existsSync(file) && statSync(file).isFile())
      add(path, keep(path, readFileSync(file, 'utf8')));
    add(path, keep(path, gitText(worktree, ['show', `:${path}`])));
  }
  return found;
}

/**
 * The ids of the task record versions that exist only in the lane `branch`: held by its worktree tree or index,
 * or by its branch tip when the worktree is gone, and equal to no copy in the main checkout (pending ref,
 * `tasks/`, archive) or on `origin/<base>`. A staged deletion holds no version.
 * A version counts as held only when its bytes equal a copy there, or when the lane tip it is unchanged from is already
 * an ancestor of `origin/<base>`.
 */
export function laneOnlyRecords(main: string, branch: string): TaskId[] {
  const base = contractBase(main);
  const only: TaskId[] = [];
  for (const [id, versions] of laneVersions(main, branch)) {
    const held: string[] = [];
    try {
      const located = locateTask(main, id);
      if (located.record !== undefined)
        held.push(serializeTask(located.record));
    } catch {
      /* A malformed record in the main checkout holds no usable version. */
    }
    const origin = gitText(main, ['show', `origin/${base}:tasks/${id}.json`]);
    if (origin !== undefined) held.push(normalized(origin));
    if (versions.some((text) => !held.includes(normalized(text))))
      only.push(id);
  }
  return only.sort();
}
