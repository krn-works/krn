import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { findArchived } from './archive.ts';
import {
  addPendingTask,
  editGoesPending,
  pendingApplies,
  pendingTaskFiles,
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
