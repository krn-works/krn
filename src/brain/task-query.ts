// The task keys retrieval: a session or lane packet asks for the standards of one claimed task,
// by its title, Outcome, Files, stack, area and touched paths (ADR 0020), or asks for nothing.
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { listClaims, readTaskFields } from '../task/store.ts';

/** What identifies a task for retrieval. */
export type TaskKey = {
  readonly id: string;
  /** The words a packet is ranked against: title, Outcome, Files, stack, area. */
  readonly text: string;
  /** Paths the task names (its Files line). */
  readonly files: readonly string[];
};

const FIELD = /^(Outcome|Files):[ \t]*(.*)$/gmu;

const words = (value: unknown): string[] =>
  typeof value === 'string'
    ? [value]
    : Array.isArray(value)
      ? value.filter((entry): entry is string => typeof entry === 'string')
      : [];

/** The retrieval key of task `id` read from `<root>/tasks/<id>.json`, undefined when the record is absent or closed. */
export function taskKey(root: string, id: string): TaskKey | undefined {
  const record = readTaskFields(root, id);
  if (record === undefined || record.status === 'closed') return undefined;
  const body = words(record.body).join('\n');
  const fields = new Map<string, string>();
  for (const match of body.matchAll(FIELD))
    fields.set(match[1] ?? '', match[2] ?? '');
  const files = (fields.get('Files') ?? '')
    .split(/[\s,;`]+/u)
    .filter((word) => /[/.]/u.test(word) && !/^[(]|[)]$/u.test(word));
  return {
    id,
    text: [
      ...words(record.title),
      fields.get('Outcome') ?? '',
      fields.get('Files') ?? '',
      ...words(record.stack),
      ...words(record.area),
    ]
      .filter((part) => part !== '')
      .join('\n'),
    files,
  };
}

/** Paths the working tree changed against HEAD, so the packet follows the work, not only the plan. */
export function touchedPaths(project: string): string[] {
  try {
    return execFileSync('git', ['diff', '--name-only', 'HEAD'], {
      cwd: project,
      encoding: 'utf8',
      timeout: 2000,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .split('\n')
      .filter((path) => path !== '');
  } catch {
    return [];
  }
}

/**
 * The task a session in `project` (on `branch`) works on: the one live claim in the main
 * checkout's `.krn/task-claims` whose worktree or branch is the session's. Undefined when none.
 */
export function claimedTask(
  project: string,
  main: string,
  branch: string,
): TaskKey | undefined {
  const here = resolve(project);
  for (const { claim } of listClaims(main)) {
    if (typeof claim.id !== 'string') continue;
    const worktree =
      typeof claim.worktree === 'string' ? resolve(claim.worktree) : '';
    const mine =
      worktree === here || (worktree !== main && claim.branch === branch);
    if (!mine) continue;
    const key = taskKey(here, claim.id) ?? taskKey(main, claim.id);
    if (key !== undefined) return key;
  }
  return undefined;
}

/** The query text of a task: its key text plus the paths it names and touches. */
export function taskQueryText(
  key: TaskKey,
  touched: readonly string[],
): string {
  return [key.text, ...key.files, ...touched].join('\n');
}
