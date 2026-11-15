// Adoption gaps: every standard the adopted repository fails, reported and tracked, never silent.

import { standardsFailures } from '../brain/standards-cli.ts';
import { firstLine, trackFailures } from './failure-tasks.ts';
import { remediateHost } from './host-remediation.ts';

export interface AdoptionGaps {
  /** One `gap <id> (<tier>): <remedy>` line per failing standard; the remedy is the standard's statement, not its check command. */
  lines: string[];
  /** Files the host wrote to fix a failing standard a lane could not (CI workflow, lockfile). */
  remediated: string[];
  /** Titles of the tracker tasks written (one per failing enforced standard). */
  tasks: string[];
}

/**
 * Runs the repository's standards and lists each failure as a gap. With a tracker (a `tasks/`
 * directory) every failing standard also becomes one task, once: a rerun finds the title.
 */
export function adoptionGaps(root: string, asOf: string): AdoptionGaps {
  const first = standardsFailures(root, asOf);
  const host = remediateHost(root, first);
  const failures =
    host.written.length === 0 ? first : standardsFailures(root, asOf);
  const lines = [
    ...host.unfixed.map((reason) => `host remediation skipped ${reason}`),
    ...failures.map(
      (failure) =>
        `gap ${failure.id}${failure.tier === undefined ? '' : ` (${failure.tier})`}: ${firstLine(failure.remedy ?? failure.message)}`,
    ),
  ];
  return {
    lines,
    remediated: host.written,
    tasks: trackFailures(root, failures, 'adoption'),
  };
}
