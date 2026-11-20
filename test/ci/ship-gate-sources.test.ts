import assert from 'node:assert/strict';
import test from 'node:test';
import { verifyGaps } from '../../src/adopt/verify.ts';
import { pinned, product, shipWith } from './ship-receiver.ts';

test('a green Actions aggregate and a green any-source Check of the same ruleset merge', async (t) => {
  const result = await shipWith(t, {
    required: [pinned, { context: 'external / Check' }],
    checks: [
      product,
      {
        ...product,
        id: 11,
        name: 'external / Check',
        appId: 42,
        detailsUrl: 'https://ci.example/build/1',
      },
    ],
    runs: [],
  });
  assert.deepEqual(result, { exitCode: 0, mergeRequested: true });
});

test('a ruleset naming the Check with no App is gated on the Actions run of that name', async (t) => {
  const result = await shipWith(t, {
    required: [{ context: 'ci / Check', integration_id: null }],
    checks: [product],
    runs: [],
  });
  assert.deepEqual(result, { exitCode: 0, mergeRequested: true });
});

test('an any-source run of the required name never satisfies the gate', async (t) => {
  const result = await shipWith(t, {
    required: [{ context: 'ci / Check' }],
    checks: [{ ...product, appId: 42 }],
    runs: [],
  });
  assert.equal(result.mergeRequested, false);
});

test('adoption does not count a ruleset with no App requirement as a verified Actions check', () => {
  const repository = JSON.stringify({
    default_branch: 'main',
    allow_auto_merge: true,
  });
  const rules = JSON.stringify([
    {
      type: 'required_status_checks',
      parameters: { required_status_checks: [{ context: 'Check' }] },
    },
  ]);
  assert.deepEqual(verifyGaps(repository, '{}', rules), [
    'branch main has no single required status check from GitHub Actions',
  ]);
});

const failed = { ...product, conclusion: 'FAILURE' };

test('a forbidden run list leaves the failed Check final: exit 74', async (t) => {
  const result = await shipWith(t, {
    required: [pinned],
    checks: [failed],
    runs: new Error('HTTP 403: Resource not accessible by integration'),
  });
  assert.deepEqual(result, { exitCode: 74, mergeRequested: false });
});

test('a run list failing with a gateway error after the failed Check ends undecided: exit 75', async (t) => {
  const result = await shipWith(t, {
    required: [pinned],
    checks: [failed],
    runs: new Error('HTTP 502: Bad Gateway'),
  });
  assert.deepEqual(result, { exitCode: 75, mergeRequested: false });
});

test('a Check an any-source ruleset entry names is judged once the Actions App ran it', async (t) => {
  const result = await shipWith(t, {
    required: [pinned, { context: 'Check', integration_id: null }],
    checks: [
      product,
      { ...product, id: 11, name: 'Check', conclusion: 'FAILURE' },
    ],
    runs: [],
  });
  assert.deepEqual(result, { exitCode: 74, mergeRequested: false });
});
