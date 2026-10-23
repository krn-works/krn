import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import * as journey from '../../src/evals/journey-baseline.ts';

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
const validLiveRecord = {
  issue: 'LON-269',
  repo: 'krn',
  commit: 'd657fdf4',
  job: 'job-1',
  interrupted_at_event: 'event-1',
  resumed_session_id: 'session-1',
  lead_interventions: 0,
  reconstruction_prompts: 1,
  escaped_defects: 0,
  tokens: { input: 2, output: 3 },
  outcome: 'completed',
  limitations: [],
  evidence: [],
};

test('B0 schema rejects fewer than three valid task rows', () => {
  assert.equal(
    journey.journeyBaselineSchema.safeParse({
      n: 2,
      tasks: [validTask, validTask],
    }).success,
    false,
  );
});

test('B0 schema rejects unlabeled task rows', () => {
  const { label: _label, ...unlabeledTask } = validTask;
  assert.equal(
    journey.journeyBaselineSchema.safeParse({
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
    journey.journeyBaselineSchema.safeParse({
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
    journey.journeyBaselineSchema.safeParse({
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
    journey.journeyBaselineSchema.safeParse({
      n: 3,
      tasks: [withCount, withUnknown, withCount],
    }).success,
    true,
  );
  assert.equal(
    journey.journeyBaselineSchema.safeParse({
      n: 3,
      tasks: [validTask, validTask, withString],
    }).success,
    false,
  );
});

test('tracked J1 baseline satisfies the B0 schema', async () => {
  const baseline = JSON.parse(
    await readFile(
      new URL('../../evals/journeys/j1-baseline.json', import.meta.url),
      'utf8',
    ),
  );
  assert.equal(journey.journeyBaselineSchema.safeParse(baseline).success, true);
});

test('live counters accept counts and unknown values, but reject strings', () => {
  assert.equal(typeof journey.journeyLiveSchema, 'object');

  const parseLiveRecord = (record: unknown) =>
    journey.journeyLiveSchema.safeParse({ schema: 2, records: [record] })
      .success;
  const withUnknown = {
    ...validLiveRecord,
    reconstruction_prompts: unknown,
    tokens: { input: unknown, output: unknown },
  };

  assert.equal(parseLiveRecord(validLiveRecord), true);
  assert.equal(parseLiveRecord(withUnknown), true);
  assert.equal(
    parseLiveRecord({ ...validLiveRecord, reconstruction_prompts: 'many' }),
    false,
  );
  assert.equal(
    parseLiveRecord({
      ...validLiveRecord,
      tokens: { ...validLiveRecord.tokens, input: 'many' },
    }),
    false,
  );
  assert.equal(
    parseLiveRecord({
      ...validLiveRecord,
      tokens: { ...validLiveRecord.tokens, output: 'many' },
    }),
    false,
  );
});
