import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { findArchived } from './archive.ts';
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

/** Creates a new record where `createsPending` says; a `tasks/` file that already exists throws EEXIST. */
export function createTaskRecord(root: string, record: TaskRecord): void {
  const contents = serializeTask(record);
  if (createsPending(root)) addPendingTask(root, record.id, contents);
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
