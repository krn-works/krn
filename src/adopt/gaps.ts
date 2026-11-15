// Adoption gaps: every standard the adopted repository fails, reported and tracked, never silent.

import { standardsFailures } from '../brain/standards-cli.ts';
import { firstLine, trackFailures } from './failure-tasks.ts';

export interface AdoptionGaps {
  /** One `gap <id>: <message>` line per failing standard. */
  lines: string[];
  /** Titles of the tracker tasks written (one per failing enforced standard). */
  tasks: string[];
}

/**
 * Runs the repository's standards and lists each failure as a gap. With a tracker (a `tasks/`
 * directory) every failing standard also becomes one task, once: a rerun finds the title.
 */
export function adoptionGaps(root: string, asOf: string): AdoptionGaps {
  const failures = standardsFailures(root, asOf);
  const lines = failures.map(
    (failure) =>
      `gap ${failure.id}${failure.tier === undefined ? '' : ` (${failure.tier})`}: ${firstLine(failure.message)}`,
  );
  return { lines, tasks: trackFailures(root, failures, 'adoption') };
}
