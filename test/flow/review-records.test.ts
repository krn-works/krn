import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { loadPriorReview } from '../../src/flow/prior.ts';
import { appendOverride } from '../../src/flow/record.ts';
import {
  newReviewRecordSchema,
  reviewRecordSchema,
} from '../../src/flow/types.ts';

// Verbatim archived v1 receiver record, embedded so the frozen observer is self-contained.
const archivedResult = reviewRecordSchema.safeParse(
  JSON.parse(String.raw`{
  "schemaVersion": 1,
  "headSha": "255083535f0a92f8c89d8574fe79d3073143ac4e",
  "base": "05c9eb332a7f5b43d3839bfc184696d2f3977255",
  "createdAt": "2026-10-27T20:26:45.660Z",
  "panelVerdict": "PASS",
  "redFirst": [],
  "contracts": [
    {
      "commit": "255083535f0a92f8c89d8574fe79d3073143ac4e",
      "path": "test/task/ergonomics.test.ts",
      "kind": "green->green",
      "green": {
        "path": "test/task/ergonomics.test.ts",
        "side": "head",
        "sha": "255083535f0a92f8c89d8574fe79d3073143ac4e",
        "classification": "pass",
        "exitCode": 0,
        "durationMs": 20390,
        "outputSha256": "9fe01742eb99fa2a8b72ce6629fe95bd13607c6e2b5bd6c2ecfa8a85d566b886",
        "summary": ""
      },
      "proven": true
    }
  ],
  "redFirstCauses": [],
  "judges": [
    {
      "state": "complete",
      "role": "standards",
      "model": "gpt-6-luna",
      "reasoningEffort": "high",
      "verdict": "PASS",
      "findings": [],
      "sessionId": "a3f0d904-6cd4-40ee-ba16-cd9097242078",
      "finalMessage": "{\"verdict\":\"PASS\",\"findings\":[]}"
    },
    {
      "state": "complete",
      "role": "spec",
      "model": "gpt-6-luna",
      "reasoningEffort": "high",
      "verdict": "PASS",
      "findings": [],
      "sessionId": "c0b41936-56ad-48b6-9eac-e588a59a43ca",
      "finalMessage": "{\"verdict\":\"PASS\",\"findings\":[]}"
    },
    {
      "state": "complete",
      "role": "adversarial",
      "model": "gpt-6-luna",
      "reasoningEffort": "high",
      "verdict": "PASS",
      "findings": [],
      "sessionId": "132d815b-3ba4-452d-ae74-5db64abd3fc8",
      "finalMessage": "{\"verdict\":\"PASS\",\"findings\":[]}"
    }
  ],
  "lensSha256": "8b8526e5fd6048f6ba2c4b57f397675304762835b04a60e5220489ae8dfbedd1",
  "panel": {
    "requestedRoles": [
      "standards",
      "spec",
      "adversarial"
    ],
    "requiredRoles": [
      "standards",
      "spec",
      "adversarial"
    ],
    "partial": false
  },
  "toolSha": "05c9eb332a7f5b43d3839bfc184696d2f3977255"
}`),
);
assert.equal(
  archivedResult.success,
  true,
  'archived v1 receiver record must parse',
);
if (!archivedResult.success)
  throw new Error('archived v1 receiver record is invalid');
const archived = archivedResult.data;

const timing = {
  startedAt: '2026-10-28T00:00:00.000Z',
  endedAt: '2026-10-28T00:00:01.000Z',
  durationMs: 1000,
};
const usage = {
  state: 'observed',
  tokens: {
    inputTokens: 20385,
    cachedInputTokens: 12160,
    cacheWriteInputTokens: 0,
    outputTokens: 47,
    reasoningOutputTokens: 0,
  },
  turnsStarted: 1,
  turnsCompleted: 1,
  invalidFields: 0,
  missingRequiredTurns: 0,
  complete: true,
  multiTurnSemantics: 'single-turn',
};
function record() {
  const result = newReviewRecordSchema.safeParse({
    ...archived,
    schemaVersion: 2,
    round: 1,
    timing,
    redFirstTiming: timing,
    judges: archived.judges.map((judge) => ({
      ...judge,
      timing,
      usage,
    })),
  });
  assert.equal(
    result.success,
    true,
    'constructed v2 record satisfies its schema',
  );
  if (!result.success) throw new Error('constructed v2 record is invalid');
  return result.data;
}

test('archived v1 and observed v2 records pass both record schemas', () => {
  for (const value of [archived, record()]) {
    assert.ok(reviewRecordSchema.safeParse(value).success);
    assert.ok(newReviewRecordSchema.safeParse(value).success);
  }
  assert.equal(record().judges[0]?.usage?.tokens.cachedInputTokens, 12160);
});

test('v2 rejects missing observations and inconsistent usage', () => {
  const value = record();
  for (const invalid of [
    { ...usage, state: 'unknown' },
    { ...usage, tokens: {}, state: 'unknown', reason: 'unreported' },
    { ...usage, invalidFields: 1 },
    { ...usage, turnsCompleted: 0 },
    { ...usage, turnsCompleted: 2 },
    { ...usage, tokens: { inputTokens: -1 } },
    { ...usage, tokens: { inputTokens: '12' } },
  ])
    assert.equal(
      reviewRecordSchema.safeParse({
        ...value,
        judges: value.judges.map((judge) => ({ ...judge, usage: invalid })),
      }).success,
      false,
    );
  assert.equal(
    reviewRecordSchema.safeParse({ ...value, timing: undefined }).success,
    false,
  );
  assert.equal(
    reviewRecordSchema.safeParse({
      ...value,
      judges: value.judges.map((judge) => ({ ...judge, usage: undefined })),
    }).success,
    false,
  );
});

test('unknown, invalid and multi-turn observations preserve uncertainty', () => {
  const value = record();
  for (const observation of [
    {
      ...usage,
      state: 'unknown',
      tokens: {},
      reason: 'No valid token counts reported by the host',
      complete: false,
      turnsCompleted: 0,
    },
    { ...usage, invalidFields: 1, complete: false },
    {
      ...usage,
      turnsStarted: 2,
      turnsCompleted: 2,
      multiTurnSemantics: 'unverified',
      tokens: {
        inputTokens: 20,
        outputTokens: 5,
        cachedInputTokens: 9,
        cacheWriteInputTokens: 3,
        reasoningOutputTokens: 2,
      },
    },
  ])
    assert.ok(
      reviewRecordSchema.safeParse({
        ...value,
        judges: value.judges.map((judge) => ({ ...judge, usage: observation })),
      }).success,
    );
});

test('incomplete judges retain timing for nonzero exit and timeout', () => {
  for (const reasonKind of ['nonzero_exit', 'timeout']) {
    const value = record();
    const parsed = reviewRecordSchema.parse({
      ...value,
      panelVerdict: 'INCOMPLETE',
      judges: value.judges.map((judge) => ({
        ...judge,
        state: 'incomplete',
        reason: 'nonzero_exit',
        reasonKind,
        exitCode: reasonKind === 'timeout' ? null : 1,
      })),
    });
    assert.deepEqual(parsed.judges[0]?.timing, timing);
  }
});

test('round two links prior bytes and head and refuses a third round or oversized record', () => {
  const root = mkdtempSync(join(tmpdir(), 'review-records-'));
  const git = (...args: string[]) => {
    const child = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' });
    assert.equal(child.status, 0, child.stderr);
    return child.stdout.trim();
  };
  try {
    git('init', '-q');
    git('config', 'user.name', 'Test');
    git('config', 'user.email', 'test@example.invalid');
    writeFileSync(join(root, 'file'), 'base');
    git('add', '.');
    git('commit', '-qm', 'base');
    const base = git('rev-parse', 'HEAD');
    writeFileSync(join(root, 'file'), 'head');
    git('commit', '-qam', 'head');
    const head = git('rev-parse', 'HEAD');
    const path = join(root, 'prior.json');
    for (const original of [archived, record()]) {
      const priorRecord = {
        ...original,
        headSha: base,
        contracts: [],
        panelVerdict: 'FAIL',
        judges: original.judges.map((judge: object) => ({
          ...judge,
          verdict: 'FAIL',
        })),
      };
      const bytes = JSON.stringify(priorRecord);
      writeFileSync(path, bytes);
      const reviewDirectory = join(root, '.krn', 'runs', 'review', base);
      mkdirSync(reviewDirectory, { recursive: true });
      writeFileSync(join(reviewDirectory, 'record.json'), bytes);
      assert.equal(
        appendOverride(root, base, {
          reason: 'Fixture decision',
          evidence: 'Fixture evidence',
        }).schemaVersion,
        original.schemaVersion,
      );
      const prior = loadPriorReview(root, head, path);
      assert.equal(prior.headSha, base);
      assert.equal(
        prior.recordSha256,
        createHash('sha256').update(bytes).digest('hex'),
      );
      const value = record();
      const second = {
        ...value,
        headSha: head,
        contracts: [],
        round: 2,
        prior,
        judges: value.judges.map((judge) => ({ ...judge, prior: [] })),
      };
      assert.ok(reviewRecordSchema.safeParse(second).success);
      assert.equal(
        reviewRecordSchema.safeParse({ ...second, round: 1 }).success,
        false,
      );
      writeFileSync(path, JSON.stringify(second));
      assert.throws(
        () => loadPriorReview(root, base, path),
        /already a second-round record/u,
      );
    }
    writeFileSync(path, ' '.repeat(1024 * 1024 + 1));
    assert.throws(() => loadPriorReview(root, head, path), /exceeds 1 MB/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('timing uses a monotonic duration despite a wall clock reversal', async (t) => {
  const timingFactory: unknown = Reflect.get(
    await import('../../src/flow/types.ts'),
    'startTiming',
  );
  assert.equal(typeof timingFactory, 'function', 'timing factory is exported');
  if (typeof timingFactory !== 'function')
    throw new Error('timing factory is unavailable');
  const finish = timingFactory();
  t.mock.method(
    globalThis,
    'Date',
    class extends Date {
      constructor() {
        super('2000-01-01T00:00:00.000Z');
      }
    },
  );
  const result = finish();
  assert.ok(result.durationMs >= 0);
  assert.ok(result.endedAt < result.startedAt);
});
