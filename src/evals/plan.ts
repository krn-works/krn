import { createHash } from 'node:crypto';
import { EvalDataError, type ExperimentManifest } from './manifest.ts';

function hash(parts: readonly (string | number)[]): string {
  return createHash('sha256').update(parts.join('\0'), 'utf8').digest('hex');
}

export function planExperiment(
  manifest: ExperimentManifest,
  options: { draft?: boolean } = {},
) {
  if (!manifest.frozen && !options.draft)
    throw new EvalDataError(
      'experiment must be frozen; use --draft to print a draft plan',
    );
  const runs = [];
  // Task order is manifest order; replica numbers are one-based paired blocks.
  // Every task receives the complete manifest arm set in each block.
  for (const task of manifest.tasks) {
    for (let replica = 1; replica <= manifest.replicas; replica += 1) {
      const arms = manifest.arms
        .map((arm) => ({
          id: arm.id,
          key: hash([manifest.seed, task.id, replica, arm.id]),
        }))
        .sort((a, b) =>
          a.key < b.key ? -1 : a.key > b.key ? 1 : a.id.localeCompare(b.id),
        );
      for (const arm of arms) {
        runs.push({
          task: task.id,
          replica,
          arm: arm.id,
          runId: hash([manifest.id, task.id, replica, arm.id]),
        });
      }
    }
  }
  return { experiment: manifest.id, draft: !manifest.frozen, runs };
}
