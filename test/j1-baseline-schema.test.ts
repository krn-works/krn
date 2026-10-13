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
  lead_interventions: 2,
  escaped_defects: 0,
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

test('valid baseline rows require lead_interventions', () => {
  const {
    lead_interventions: _leadInterventions,
    ...withoutLeadInterventions
  } = validTask;
  assert.equal(
    journeyBaselineSchema.safeParse({
      n: 3,
      tasks: [validTask, validTask, withoutLeadInterventions],
    }).success,
    false,
  );
});

test('valid baseline rows require escaped_defects', () => {
  const { escaped_defects: _escapedDefects, ...withoutEscapedDefects } =
    validTask;
  assert.equal(
    journeyBaselineSchema.safeParse({
      n: 3,
      tasks: [validTask, validTask, withoutEscapedDefects],
    }).success,
    false,
  );
});

test('lead_interventions accepts counters and unknown values, but not strings', () => {
  const withCount = { ...validTask, lead_interventions: 0 };
  const withUnknown = { ...validTask, lead_interventions: unknown };
  const withString = { ...validTask, lead_interventions: 'many' };

  assert.equal(
    journeyBaselineSchema.safeParse({
      n: 3,
      tasks: [withCount, withUnknown, withCount],
    }).success,
    true,
  );
  assert.equal(
    journeyBaselineSchema.safeParse({
      n: 3,
      tasks: [validTask, validTask, withString],
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
