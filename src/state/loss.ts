// State loss: an open task claim that no capsule (state.md) or handoff
// (handoff.md) under .krn/runs names, so a restarted session cannot tell what
// the claim holder had reached. Shared by `krn state check` and the SessionStart hook.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

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
  try {
    const task: unknown = JSON.parse(
      readFileSync(join(records, 'tasks', `${id}.json`), 'utf8'),
    );
    return (
      typeof task === 'object' &&
      task !== null &&
      (task as { status?: unknown }).status === 'closed'
    );
  } catch {
    return false;
  }
}

// `main` holds .krn/task-claims and .krn/runs; `records` holds tasks/<id>.json.
// Returns the claim file path (relative to main) of each open claim without a record.
export function stateLoss(main: string, records: string = main): string[] {
  const claims = join(main, '.krn', 'task-claims');
  if (!existsSync(claims)) return [];
  const texts: string[] = [];
  recordTexts(join(main, '.krn', 'runs'), texts);
  const lost: string[] = [];
  for (const entry of readdirSync(claims, { withFileTypes: true }).sort(
    (a, b) => a.name.localeCompare(b.name),
  )) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    let id: unknown;
    try {
      id = (
        JSON.parse(readFileSync(join(claims, entry.name), 'utf8')) as {
          id?: unknown;
        }
      ).id;
    } catch {
      continue;
    }
    if (typeof id !== 'string' || id === '' || taskClosed(records, id))
      continue;
    if (!texts.some((text) => text.includes(id)))
      lost.push(`.krn/task-claims/${entry.name}`);
  }
  return lost;
}
