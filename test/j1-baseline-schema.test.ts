import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { journeyBaselineSchema } from '../src/evals/journey-baseline.ts';

const unknown = { value: null, reason: 'not recorded in results.md' };
const validTask = {
  task: 'task',
  repo: 'repo',
  label: 'valid',
  operator_minutes: 0,
  reconstruction_prompts: unknown,
  first_useful_action: unknown,
  lost_stages: unknown,
  tokens: { input: 1, cached_input: unknown, output: unknown },
  judge_rounds: unknown,
  outcome: 'completed',
};

test('B0 schema rejects fewer than three valid task rows', () => {
  assert.equal(
    journeyBaselineSchema.safeParse({ n: 2, tasks: [validTask, validTask] })
      .success,
    false,
  );
});

test('B0 schema rejects unlabeled task rows', () => {
  const { label: _label, ...unlabeledTask } = validTask;
  assert.equal(
    journeyBaselineSchema.safeParse({
      n: 3,
      tasks: [validTask, validTask, unlabeledTask],
    }).success,
    false,
  );
});

test('tracked J1 baseline satisfies the B0 schema', async () => {
  const baseline = JSON.parse(
    await readFile(
      new URL('../evals/journeys/j1-baseline.json', import.meta.url),
      'utf8',
    ),
  );
  assert.equal(journeyBaselineSchema.safeParse(baseline).success, true);
});
