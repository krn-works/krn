// Adoption gaps: every standard the adopted repository fails, reported and tracked, never silent.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { standardsFailures } from '../brain/standards-cli.ts';
import { createTask, loadTaskIndex } from '../task/store.ts';

export interface AdoptionGaps {
  /** One `gap <id>: <message>` line per failing standard. */
  lines: string[];
  /** Titles of the tracker tasks written (floor and reflex failures only). */
  tasks: string[];
}

const firstLine = (text: string) => {
  const line = text.split('\n')[0] ?? text;
  return line.length > 160 ? `${line.slice(0, 160)}...` : line;
};

/**
 * Runs the repository's standards and lists each failure as a gap. With a tracker (a `tasks/`
 * directory) every floor or reflex failure also becomes one task, once: a rerun finds the title.
 */
export function adoptionGaps(root: string, asOf: string): AdoptionGaps {
  const failures = standardsFailures(root, asOf);
  const lines = failures.map(
    (failure) =>
      `gap ${failure.id}${failure.tier === undefined ? '' : ` (${failure.tier})`}: ${firstLine(failure.message)}`,
  );
  const tasks: string[] = [];
  if (!existsSync(join(root, 'tasks'))) return { lines, tasks };
  const known = new Set(
    [...loadTaskIndex(root).values()].map((task) => task.title),
  );
  for (const failure of failures) {
    if (failure.tier !== 'floor' && failure.tier !== 'reflex') continue;
    const title = `Make standard ${failure.id} pass`;
    if (known.has(title)) continue;
    createTask(root, {
      title,
      priority: failure.tier === 'floor' ? 1 : 2,
      body: [
        `Outcome: \`krn standards check\` no longer fails ${failure.id}.`,
        `Why: adoption found this ${failure.tier} standard failing: ${firstLine(failure.message)}`,
        'Proof: `krn standards check` passes the record.',
      ],
    });
    known.add(title);
    tasks.push(title);
  }
  return { lines, tasks };
}
