// A failing standard of a repository with a tracker becomes one ready task there, once.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Failure } from '../brain/standards.ts';
import { createTask, loadTaskIndex } from '../task/store.ts';

/** A finish standard reports only, so its task is last in line. */
const PRIORITY = { floor: 1, reflex: 2, finish: 3 } as const;

export const firstLine = (text: string) => {
  const line = text.split('\n')[0] ?? text;
  return line.length > 160 ? `${line.slice(0, 160)}...` : line;
};

/**
 * Writes one task per failing enforced standard of any tier (floor, reflex, finish); a repository without a `tasks/` directory gets
 * none unless `startTracker` asks for one, and a failure whose title is already tracked (open or closed) is not written again.
 * Returns the titles written.
 */
export function trackFailures(
  root: string,
  failures: readonly Failure[],
  source = 'a standards check',
  startTracker = false,
): string[] {
  const tasks: string[] = [];
  if (!startTracker && !existsSync(join(root, 'tasks'))) return tasks;
  const known = new Set(
    [...loadTaskIndex(root).values()].map((task) => task.title),
  );
  for (const failure of failures) {
    if (failure.tier === undefined) continue;
    const title = `Make standard ${failure.id} pass`;
    if (known.has(title)) continue;
    createTask(root, {
      title,
      priority: PRIORITY[failure.tier],
      body: [
        `Outcome: \`krn standards check --record ${failure.id}\` no longer fails ${failure.id}.`,
        `Why: ${source} found this ${failure.tier} standard failing: ${firstLine(failure.message)}`,
        'Files: the files the failing check names (run the Proof command).',
        `Proof: \`krn standards check --record ${failure.id}\``,
      ],
    });
    known.add(title);
    tasks.push(title);
  }
  return tasks;
}
