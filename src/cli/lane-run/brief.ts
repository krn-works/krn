import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { findContract } from '../../repo/contract.ts';
import { taskLookupRoot } from '../../task/claims.ts';
import { getTask } from '../../task/store.ts';
import { laneBrief } from '../lane-brief.ts';

/** The command the session runs before it finishes: the contract's quick check, else its tests. */
export function checkCommand(root: string): string {
  const contract = findContract(root)?.contract;
  return contract?.fast ?? contract?.test ?? 'npm run fast';
}

/** How a session invokes krn: the repository's own `bin/krn` inside KRN, else `krn` from PATH. */
export function krnInvocation(root: string): string {
  return existsSync(join(root, 'bin', 'krn')) ? 'bin/krn' : 'krn';
}

export function taskRecordBrief(
  root: string,
  id: string,
  lanes: string[],
): string {
  const task = getTask(taskLookupRoot(root, id, lanes), id);
  const acceptance = task.acceptance ?? [];
  return [
    `Task ${task.id}: ${task.title}`,
    '',
    ...task.body,
    '',
    ...(acceptance.length === 0
      ? []
      : [
          'Acceptance lines (each command must exit 0 in this worktree before you finish; `krn task close` runs them):',
          ...acceptance.map((entry) => `- \`${entry.verify}\``),
          '',
        ]),
    `Deliver this task in the current worktree: commit with a "Ticket: ${task.id}" trailer and close the task with \`${krnInvocation(root)} task close ${task.id} --as done --note ...\` in the same commit. The commit title is \`type(scope): outcome (${task.id})\`. Run \`${checkCommand(root)}\` and fix what it reports before you finish; the caller ships only a tree it passed on. Do not push or open a pull request; the caller ships the commit.`,
  ].join('\n');
}

/** The session prompt for a repository without a tracker: the goal text instead of a task record. */
export function goalBrief(
  root: string,
  goal: string,
  asOf = new Date().toISOString().slice(0, 10),
): string {
  return goalLaneBrief(root, goal, asOf).text;
}

export function goalLaneBrief(
  root: string,
  goal: string,
  asOf = new Date().toISOString().slice(0, 10),
): { text: string; packet: string | null } {
  return laneBrief(
    root,
    [
      goal.trim(),
      '',
      `Deliver this goal in the current worktree: commit with a title \`type(scope): outcome\`. Run \`${checkCommand(root)}\` and fix what it reports before you finish; the caller ships only a tree it passed on. Do not push or open a pull request; the caller ships the commit.`,
    ].join('\n'),
    asOf,
  );
}

/** A lane slug from the goal's first words. */
export function goalSlug(goal: string): string {
  const slug = goal
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-+/u, '')
    .slice(0, 40)
    .replace(/-+$/u, '');
  return `goal-${slug || 'lane'}`;
}

/** The session prompt: the packet `krn lane brief --task ID` prints (ADR 0002, FR-40), then the task record. */
export function taskBrief(
  root: string,
  id: string,
  asOf = new Date().toISOString().slice(0, 10),
  lanes: string[] = [],
): string {
  return taskLaneBrief(root, id, asOf, lanes).text;
}

export function taskLaneBrief(
  root: string,
  id: string,
  asOf = new Date().toISOString().slice(0, 10),
  lanes: string[] = [],
): { text: string; packet: string | null } {
  return laneBrief(root, taskRecordBrief(root, id, lanes), asOf, id);
}
