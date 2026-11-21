import { join } from 'node:path';

// Where task records live. Code outside src/task names the tracker directory only through these helpers.
export const TASKS_DIR = 'tasks';

/** The repo-relative path of one task record. */
export function taskFile(id: string): string {
  return `${TASKS_DIR}/${id}.json`;
}

/** Whether a repo-relative path is inside the tracker directory. */
export function isTaskPath(path: string): boolean {
  return path.startsWith(`${TASKS_DIR}/`);
}

/** The directory of task claim files in the main checkout `main`. */
export function claimsDirectory(main: string): string {
  return join(main, '.krn', 'task-claims');
}

/** The claim file of task `id` in the main checkout `main`. */
export function claimFile(main: string, id: string): string {
  return join(claimsDirectory(main), `${id}.json`);
}
