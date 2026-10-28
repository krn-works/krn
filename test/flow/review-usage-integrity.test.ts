import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { runReview } from '../../src/flow/index.ts';
import {
  newReviewRecordSchema,
  reviewRecordSchema,
} from '../../src/flow/types.ts';
import { CodexHost } from '../../src/hosts/codex.ts';

const timing = {
  startedAt: '2026-10-28T00:00:00.000Z',
  endedAt: '2026-10-28T00:00:01.000Z',
  durationMs: 1000,
};
const base = {
  schemaVersion: 2,
  round: 1,
  timing,
  redFirstTiming: timing,
  headSha: 'a'.repeat(40),
  base: 'b'.repeat(40),
  createdAt: timing.endedAt,
  lensSha256: 'c'.repeat(64),
  toolSha: 'd'.repeat(40),
  redFirst: [],
  contracts: [],
  redFirstCauses: [],
};
const unknownUsage = {
  state: 'unknown',
  reason: 'No valid counters were reported',
  tokens: {},
  turnsStarted: 2,
  turnsCompleted: 2,
  invalidFields: 0,
  missingRequiredTurns: 2,
  complete: false,
  multiTurnSemantics: 'unverified',
};
const blockingFinding = {
  severity: 'BLOCKING',
  title: 'Blocking prepass finding',
  path: 'src/example.ts',
  line: 1,
  defect: 'Concrete defect',
  fix: 'Correct the defect',
};

function blockedPrepass(prepass: Record<string, unknown>) {
  return {
    ...base,
    judges: [],
    prepass: {
      state: 'complete',
      findings: [blockingFinding],
      sessionId: 'prepass',
      ...prepass,
    },
  };
}

test('v2 requires timing and usage evidence for a blocking prepass', () => {
  assert.equal(reviewRecordSchema.safeParse(blockedPrepass({})).success, false);
  assert.equal(
    reviewRecordSchema.safeParse(
      blockedPrepass({ timing, usage: unknownUsage }),
    ).success,
    true,
  );
  const completeUsage = {
    state: 'observed',
    tokens: { inputTokens: 10, outputTokens: 5 },
    turnsStarted: 1,
    turnsCompleted: 1,
    invalidFields: 0,
    complete: true,
    multiTurnSemantics: 'single-turn',
  };
  for (const missingRequiredTurns of [undefined, null, 1])
    assert.equal(
      reviewRecordSchema.safeParse(
        blockedPrepass({
          timing,
          usage: { ...completeUsage, missingRequiredTurns },
        }),
      ).success,
      false,
    );
  assert.equal(
    reviewRecordSchema.safeParse(
      blockedPrepass({
        timing,
        usage: { ...completeUsage, missingRequiredTurns: 0 },
      }),
    ).success,
    true,
  );
});

test('v2 preserves incomplete prepass evidence when the panel continues', () => {
  const value = {
    ...base,
    panelVerdict: 'INCOMPLETE',
    panel: {
      requestedRoles: ['standards'],
      requiredRoles: ['standards', 'spec', 'adversarial'],
      partial: true,
    },
    prepass: {
      state: 'incomplete',
      findings: [],
      sessionId: 'prepass',
      timing,
      usage: unknownUsage,
      reason: 'turn_incomplete',
    },
    judges: [
      {
        state: 'incomplete',
        role: 'standards',
        model: 'gpt-6-luna',
        reasoningEffort: 'high',
        reason: 'turn_incomplete',
        reasonKind: 'agent_message',
        sessionId: 'judge',
        exitCode: null,
        timing,
        usage: unknownUsage,
      },
    ],
  };
  assert.equal(reviewRecordSchema.safeParse(value).success, true);
  const nullCoverage = {
    ...value,
    prepass: {
      ...value.prepass,
      usage: { ...unknownUsage, missingRequiredTurns: null },
    },
    judges: value.judges.map((judge) => ({
      ...judge,
      usage: { ...unknownUsage, missingRequiredTurns: null },
    })),
  };
  assert.equal(reviewRecordSchema.safeParse(nullCoverage).success, true);
});

test('v2 refuses complete multi-turn usage with missing per-turn counters', () => {
  const value = {
    ...base,
    panelVerdict: 'INCOMPLETE',
    panel: {
      requestedRoles: ['standards'],
      requiredRoles: ['standards', 'spec', 'adversarial'],
      partial: true,
    },
    judges: [
      {
        state: 'incomplete',
        role: 'standards',
        model: 'gpt-6-luna',
        reasoningEffort: 'high',
        reason: 'nonzero_exit',
        reasonKind: 'process_exit',
        sessionId: 'judge',
        exitCode: 1,
        timing,
        usage: {
          ...unknownUsage,
          state: 'observed',
          reason: undefined,
          tokens: { inputTokens: 10, outputTokens: 5 },
          missingRequiredTurns: 1,
          complete: true,
        },
      },
    ],
  };
  assert.equal(newReviewRecordSchema.safeParse(value).success, false);
});

test('v1 keeps complete usage without v2 turn coverage while v2 requires known coverage', () => {
  const completeUsage = {
    state: 'observed',
    tokens: { inputTokens: 10, outputTokens: 5 },
    turnsStarted: 1,
    turnsCompleted: 1,
    invalidFields: 0,
    complete: true,
    multiTurnSemantics: 'single-turn',
  };
  const judge = {
    state: 'complete',
    role: 'standards',
    model: 'gpt-6-luna',
    reasoningEffort: 'high',
    verdict: 'PASS',
    findings: [],
    sessionId: 'judge',
    finalMessage: 'PASS',
  };
  const v1 = {
    schemaVersion: 1,
    headSha: 'a'.repeat(40),
    base: 'b'.repeat(40),
    createdAt: timing.endedAt,
    panelVerdict: 'PASS',
    redFirst: [],
    judges: [{ ...judge, usage: completeUsage }],
  };
  assert.equal(reviewRecordSchema.safeParse(v1).success, true);

  const v2 = {
    ...base,
    round: 1,
    panelVerdict: 'INCOMPLETE',
    lensSha256: 'c'.repeat(64),
    toolSha: 'd'.repeat(40),
    panel: {
      requestedRoles: ['standards'],
      requiredRoles: ['standards', 'spec', 'adversarial'],
      partial: true,
    },
    judges: [
      {
        ...judge,
        timing,
        usage: completeUsage,
      },
    ],
  };
  assert.equal(newReviewRecordSchema.safeParse(v2).success, false);
  for (const missingRequiredTurns of [undefined, null, 1]) {
    assert.equal(
      newReviewRecordSchema.safeParse({
        ...v2,
        judges: [
          {
            ...v2.judges[0],
            usage: { ...completeUsage, missingRequiredTurns },
          },
        ],
      }).success,
      false,
    );
  }
  assert.equal(
    newReviewRecordSchema.safeParse({
      ...v2,
      judges: [
        {
          ...v2.judges[0],
          usage: { ...completeUsage, missingRequiredTurns: 0 },
        },
      ],
    }).success,
    true,
  );
});

test('v2 persists unknown coverage for rejected judges and numeric zero for observed empty turns', async () => {
  const root = mkdtempSync(join(tmpdir(), 'review-usage-integrity-'));
  const git = (...args: string[]) => {
    const result = spawnSync('git', ['-C', root, ...args], {
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  const originalStart = CodexHost.prototype.start;
  let startMode: 'rejected' | 'observed-empty' = 'rejected';
  CodexHost.prototype.start = async (input) => {
    const role = /ROLE: (standards|spec|adversarial)/u.exec(input.prompt)?.[1];
    assert.ok(role, 'the review role reaches the mocked host');
    if (startMode === 'rejected')
      throw new Error(`${role} startup failed before host observation`);
    return {
      id: `mocked-${role}`,
      wait: async () => ({
        sessionId: `mocked-${role}`,
        reasonKind: 'process_exit',
        reasonSha256: 'e'.repeat(64),
        reasonLength: 0,
        claimsDone: false,
        exitCode: 1,
        signal: null,
        usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
        usageObservation: {
          turnsStarted: 0,
          turnsCompleted: 0,
          invalidFields: 0,
          reportedFields: [],
          missingRequiredTurns: 0,
        },
      }),
    };
  };

  try {
    git('init', '-q');
    git('config', 'user.name', 'Review usage test');
    git('config', 'user.email', 'review-usage@example.invalid');
    writeFileSync(join(root, 'README.md'), 'base\n');
    git('add', 'README.md');
    git('commit', '-qm', 'base');
    const baseSha = git('rev-parse', 'HEAD');
    writeFileSync(join(root, 'README.md'), 'first head\n');
    git('commit', '-qam', 'first head');
    const firstHead = git('rev-parse', 'HEAD');
    const lens = join(root, 'lens.txt');
    writeFileSync(lens, 'Validate review observations.\n');

    await runReview({ repo: root, base: baseSha, head: firstHead, lens });
    const rejectedResult = reviewRecordSchema.safeParse(
      JSON.parse(
        readFileSync(
          join(root, '.krn/runs/review', firstHead, 'record.json'),
          'utf8',
        ),
      ),
    );
    assert.ok(rejectedResult.success, 'written rejected record matches schema');
    assert.equal(rejectedResult.data.schemaVersion, 2);
    const rejectedRecord = rejectedResult.data;
    assert.equal(rejectedRecord.judges.length, 3);
    for (const judge of rejectedRecord.judges) {
      assert.ok(judge.timing);
      assert.ok(judge.usage);
      assert.equal(judge.usage.state, 'unknown');
      assert.equal(
        judge.usage.reason,
        'Judge failed before host observation was available',
      );
      assert.equal(judge.usage.missingRequiredTurns, null);
      assert.equal(judge.usage.turnsStarted, 0);
      assert.equal(judge.usage.turnsCompleted, 0);
    }

    startMode = 'observed-empty';
    writeFileSync(join(root, 'README.md'), 'second head\n');
    git('commit', '-qam', 'second head');
    const secondHead = git('rev-parse', 'HEAD');
    await runReview({ repo: root, base: baseSha, head: secondHead, lens });
    const observedResult = reviewRecordSchema.safeParse(
      JSON.parse(
        readFileSync(
          join(root, '.krn/runs/review', secondHead, 'record.json'),
          'utf8',
        ),
      ),
    );
    assert.ok(observedResult.success, 'written observed record matches schema');
    assert.equal(observedResult.data.schemaVersion, 2);
    const observedRecord = observedResult.data;
    assert.equal(observedRecord.judges.length, 3);
    for (const judge of observedRecord.judges) {
      assert.ok(judge.timing);
      assert.ok(judge.usage);
      assert.equal(judge.usage.state, 'unknown');
      assert.equal(judge.usage.missingRequiredTurns, 0);
      assert.equal(judge.usage.turnsStarted, 0);
      assert.equal(judge.usage.turnsCompleted, 0);
    }
  } finally {
    CodexHost.prototype.start = originalStart;
    rmSync(root, { recursive: true, force: true });
  }
});

test('v2 rejects subset totals above their parent while retaining unknown-parent uncertainty', () => {
  const judge = {
    state: 'incomplete',
    role: 'standards',
    model: 'gpt-6-luna',
    reasoningEffort: 'high',
    reason: 'nonzero_exit',
    reasonKind: 'process_exit',
    sessionId: 'judge',
    exitCode: 1,
    timing,
  };
  const record = (
    tokens: Record<string, number>,
    complete = false,
    invalidFields = 0,
  ) => ({
    ...base,
    panelVerdict: 'INCOMPLETE',
    panel: {
      requestedRoles: ['standards'],
      requiredRoles: ['standards', 'spec', 'adversarial'],
      partial: true,
    },
    judges: [
      {
        ...judge,
        usage: {
          state: 'observed',
          tokens,
          turnsStarted: 1,
          turnsCompleted: 1,
          invalidFields,
          missingRequiredTurns: complete ? 0 : 1,
          complete,
          multiTurnSemantics: 'single-turn',
        },
      },
    ],
  });
  assert.equal(
    newReviewRecordSchema.safeParse(
      record({ inputTokens: 10, cachedInputTokens: 11 }),
    ).success,
    false,
  );
  assert.equal(
    newReviewRecordSchema.safeParse(record({ cachedInputTokens: 11 }, false, 1))
      .success,
    true,
  );
  assert.equal(
    newReviewRecordSchema.safeParse(record({ cachedInputTokens: 11 })).success,
    false,
  );
  assert.equal(
    newReviewRecordSchema.safeParse(
      record(
        {
          inputTokens: 10,
          cacheWriteInputTokens: 10,
          outputTokens: 4,
          reasoningOutputTokens: 4,
        },
        true,
      ),
    ).success,
    true,
  );
});

test('v2 rejects prepass multi-turn semantics that disagree with completed turns', () => {
  assert.equal(
    reviewRecordSchema.safeParse(
      blockedPrepass({
        timing,
        usage: {
          state: 'unknown',
          reason: 'No valid counters were reported',
          tokens: {},
          turnsStarted: 2,
          turnsCompleted: 2,
          invalidFields: 0,
          missingRequiredTurns: 2,
          complete: false,
          multiTurnSemantics: 'single-turn',
        },
      }),
    ).success,
    false,
  );
});
