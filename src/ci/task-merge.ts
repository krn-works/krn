import { z } from 'zod';
import { parseTickets } from '../repo/protocol-lines.ts';

/** One merged PR of a branch, as `gh pr list --json number,title,body,mergeCommit` prints it. */
const mergedRow = z.object({
  number: z.number().int(),
  title: z.string(),
  body: z.string().nullish(),
  mergeCommit: z.object({ oid: z.string() }).nullish(),
});
const mergedRows = z.array(mergedRow);

/** The `--json` fields `taskMerge` reads. */
export const taskMergeFields = 'number,title,body,mergeCommit';

/** True when the PR's squash subject or its trailers name the task. */
function namesTask(row: z.infer<typeof mergedRow>, task: string): boolean {
  if (row.title.trimEnd().endsWith(`(${task})`)) return true;
  return parseTickets(`${row.title}\n\n${row.body ?? ''}`).some((line) =>
    line.ids.includes(task),
  );
}

/**
 * The merged PR that already delivered `task` from a branch whose diff against the base is
 * empty, or undefined. A branch name alone never attributes a merge: lanes reuse slugs, so an
 * older merged PR of the same branch can belong to another task, and claiming it would report a
 * merge that never carried this work. The PR must name the task (title suffix or a
 * `Ticket:`/`Refs:` trailer) and its merge commit must be on the base (`onBase`); the newest wins.
 */
export function taskMerge(
  listed: string,
  task: string | undefined,
  onBase: (sha: string) => boolean,
): { pr: number; sha: string } | undefined {
  if (task === undefined || listed.trim() === '') return undefined;
  const rows = mergedRows.parse(JSON.parse(listed));
  const found = rows
    .filter((row) => row.mergeCommit?.oid !== undefined && namesTask(row, task))
    .sort((a, b) => b.number - a.number)
    .find((row) => onBase(row.mergeCommit?.oid ?? ''));
  return found === undefined
    ? undefined
    : { pr: found.number, sha: found.mergeCommit?.oid ?? '' };
}
