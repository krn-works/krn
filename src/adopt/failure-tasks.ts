// A failing standard of a repository with a tracker becomes one ready task there, once.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Failure, Tier } from '../brain/standards.ts';
import { createTask, loadTaskIndex } from '../task/store.ts';
import { detectInitStack } from './init.ts';

/**
 * Adoption tiers (ADR 0023): 1 floor, 2 CI runs the contract commands, 3 lint and types run. A failing
 * standard of tiers 1 to 3 is a `gate` task; any other reflex or finish failure is `debt` behind them.
 * The tier is the task priority, so `krn task list` and claim order follow it.
 */
const GATE_TIERS: Record<string, { tier: 2 | 3; area: string }> = {
  's-gate-in-ci': { tier: 2, area: 'ci' },
  's-gate-lint-runs': { tier: 3, area: 'lint' },
  's-gate-typecheck-runs': { tier: 3, area: 'types' },
};

/** The tier, priority, kind and area of a failing standard's task. */
export function gateCategory(failure: Failure & { tier: Tier }): {
  tier: number;
  kind: 'gate' | 'debt';
  area: string;
} {
  const gate = GATE_TIERS[failure.id];
  if (gate !== undefined) return { ...gate, kind: 'gate' };
  if (failure.tier === 'floor') return { tier: 1, kind: 'gate', area: 'floor' };
  return { tier: 3, kind: 'debt', area: failure.tier };
}

export const firstLine = (text: string) => {
  const line = text.split('\n')[0] ?? text;
  return line.length > 160 ? `${line.slice(0, 160)}...` : line;
};

/**
 * Writes one task per failing enforced standard of any tier (floor, reflex, finish), in adoption tier order with
 * kind, area and the detected stack; a repository without a `tasks/` directory gets
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
  const stack = detectInitStack(root);
  const tiered = failures
    .filter(
      (failure): failure is Failure & { tier: Tier } =>
        failure.tier !== undefined,
    )
    .map((failure) => ({ failure, category: gateCategory(failure) }))
    .sort(
      (left, right) =>
        left.category.tier - right.category.tier ||
        Number(left.category.kind === 'debt') -
          Number(right.category.kind === 'debt'),
    );
  for (const { failure, category } of tiered) {
    const title = `Make standard ${failure.id} pass`;
    if (known.has(title)) continue;
    createTask(root, {
      title,
      priority: category.tier,
      kind: category.kind,
      area: category.area,
      ...(stack === undefined ? {} : { stack: [stack] }),
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
