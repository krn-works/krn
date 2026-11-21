// State loss: an open task claim that no capsule (state.md) or handoff
// (handoff.md) under .krn/runs names, so a restarted session cannot tell what
// the claim holder had reached. Shared by `krn state check` and the SessionStart hook.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { listClaims, readTaskFields } from '../task/store.ts';

function recordTexts(directory: string, texts: string[]): void {
  if (!existsSync(directory)) return;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) recordTexts(path, texts);
    else if (
      entry.isFile() &&
      (entry.name === 'handoff.md' || entry.name === 'state.md')
    )
      try {
        texts.push(readFileSync(path, 'utf8'));
      } catch {
        /* An unreadable record names nothing. */
      }
  }
}

function taskClosed(records: string, id: string): boolean {
  return readTaskFields(records, id)?.status === 'closed';
}

// `main` holds .krn/task-claims and .krn/runs; `records` holds tasks/<id>.json.
// Returns the claim file path (relative to main) of each open claim without a record.
export function stateLoss(main: string, records: string = main): string[] {
  const claims = listClaims(main);
  if (claims.length === 0) return [];
  const texts: string[] = [];
  recordTexts(join(main, '.krn', 'runs'), texts);
  const lost: string[] = [];
  for (const { id: file, claim } of claims) {
    const id = claim.id;
    if (typeof id !== 'string' || id === '' || taskClosed(records, id))
      continue;
    if (!texts.some((text) => text.includes(id)))
      lost.push(`.krn/task-claims/${file}.json`);
  }
  return lost;
}
