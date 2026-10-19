import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { ReviewUsageError, reviewCommand } from '../../src/flow/cli.ts';
import { reviewRecordSchema } from '../../src/flow/types.ts';
import { CodexHost, type CodexStartInput } from '../../src/hosts/codex.ts';

function git(root: string, ...args: string[]): string {
  const result = spawnSync('git', ['-C', root, ...args], {
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function fixture(): {
  readonly root: string;
  readonly base: string;
  readonly head: string;
  readonly lens: string;
  readonly cleanup: () => void;
} {
  const root = mkdtempSync(join(tmpdir(), 'krn-review-effort-'));
  git(root, 'init', '-q');
  git(root, 'config', 'user.name', 'KRN test');
  git(root, 'config', 'user.email', 'krn-test@example.invalid');
  writeFileSync(join(root, 'README.md'), 'fixture\n');
  git(root, 'add', '.');
  git(root, 'commit', '-qm', 'fixture base');
  const base = git(root, 'rev-parse', 'HEAD');
  writeFileSync(join(root, 'src.ts'), 'export const answer = 42;\n');
  git(root, 'add', 'src.ts');
  git(root, 'commit', '-qm', 'review target');
  const head = git(root, 'rev-parse', 'HEAD');
  const lens = join(root, 'lens.txt');
  writeFileSync(lens, 'Check acceptance.\n');
  return {
    root,
    base,
    head,
    lens,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

test('review command passes selected reasoning effort to each judge', async (t) => {
  const originalStart = CodexHost.prototype.start;
  const startInputs: CodexStartInput[] = [];
  let incomplete = false;
  CodexHost.prototype.start = async (input) => {
    startInputs.push(input);
    const finalMessage = '{"verdict":"PASS","findings":[]}';
    return {
      id: 'fake-review-session',
      wait: async () => ({
        sessionId: 'fake-review-session',
        reasonKind: 'turn_complete',
        reasonSha256: 'a'.repeat(64),
        reasonLength: finalMessage.length,
        claimsDone: !incomplete,
        finalMessage,
        exitCode: 0,
        signal: null,
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        usageObservation: {
          turnsStarted: 1,
          turnsCompleted: 1,
          invalidFields: 0,
        },
      }),
    };
  };
  try {
    const cases = [
      { effort: 'max', incomplete: false, state: 'complete' },
      { effort: 'xhigh', incomplete: true, state: 'incomplete' },
      { effort: 'low', incomplete: false, state: 'complete' },
      { effort: 'medium', incomplete: false, state: 'complete' },
      { effort: 'high', incomplete: false, state: 'complete' },
    ] as const;
    for (const { effort, incomplete: isIncomplete, state } of cases)
      await t.test(effort, async () => {
        incomplete = isIncomplete;
        const { root, base, head, lens, cleanup } = fixture();
        const priorCallCount = startInputs.length;
        try {
          const outcome = await reviewCommand([
            '--repo',
            root,
            '--base',
            base,
            '--head',
            head,
            '--lens',
            lens,
            '--reasoning-effort',
            effort,
          ]);
          assert.equal(outcome, isIncomplete ? 'INCOMPLETE' : 'PASS');
          const judgeStarts = startInputs.slice(priorCallCount);
          assert.equal(judgeStarts.length, 3);
          assert.ok(
            judgeStarts.every((input) => input.reasoningEffort === effort),
            'selected reasoning effort must reach CodexHost.start',
          );
          const persisted = JSON.parse(
            readFileSync(
              join(root, '.krn', 'runs', 'review', head, 'record.json'),
              'utf8',
            ),
          ) as {
            readonly judges: readonly {
              readonly reasoningEffort?: string;
              readonly state: string;
            }[];
          };
          assert.equal(persisted.judges.length, 3);
          assert.ok(persisted.judges.every((judge) => judge.state === state));
          assert.ok(
            persisted.judges.every((judge) => judge.reasoningEffort === effort),
          );
        } finally {
          cleanup();
        }
      });
    await t.test('omitted flag retains high', async () => {
      incomplete = false;
      const { root, base, head, lens, cleanup } = fixture();
      const priorCallCount = startInputs.length;
      try {
        const outcome = await reviewCommand([
          '--repo',
          root,
          '--base',
          base,
          '--head',
          head,
          '--lens',
          lens,
        ]);
        assert.equal(outcome, 'PASS');
        const judgeStarts = startInputs.slice(priorCallCount);
        assert.equal(judgeStarts.length, 3);
        assert.ok(
          judgeStarts.every((input) => input.reasoningEffort === 'high'),
        );
        const persisted = JSON.parse(
          readFileSync(
            join(root, '.krn', 'runs', 'review', head, 'record.json'),
            'utf8',
          ),
        ) as {
          readonly judges: readonly {
            readonly reasoningEffort?: string;
          }[];
        };
        assert.equal(persisted.judges.length, 3);
        assert.ok(
          persisted.judges.every((judge) => judge.reasoningEffort === 'high'),
        );
      } finally {
        cleanup();
      }
    });
  } finally {
    CodexHost.prototype.start = originalStart;
  }
});

test('invalid reasoning effort is rejected as usage before review work', async () => {
  await assert.rejects(
    reviewCommand(['--reasoning-effort', 'ultra']),
    (error: unknown) =>
      error instanceof ReviewUsageError &&
      error.message.includes('--reasoning-effort'),
  );
  await assert.rejects(
    reviewCommand(['--reasoning-effort']),
    (error: unknown) =>
      error instanceof ReviewUsageError &&
      error.message.includes('--reasoning-effort'),
  );
});

test('historical review records retain optional low, medium, and high effort', () => {
  const historical = {
    schemaVersion: 1,
    headSha: 'a'.repeat(40),
    base: 'b'.repeat(40),
    createdAt: '2026-10-11T00:00:00.000Z',
    panelVerdict: 'PASS',
    redFirst: [],
    judges: [
      {
        state: 'complete',
        role: 'standards',
        verdict: 'PASS',
        findings: [],
        sessionId: 'historical-session',
        finalMessage: 'PASS',
      },
    ],
  };
  assert.equal(
    reviewRecordSchema.parse(historical).judges[0]?.reasoningEffort,
    undefined,
  );
  for (const effort of ['low', 'medium', 'high'] as const) {
    const parsed = reviewRecordSchema.parse({
      ...historical,
      judges: [{ ...historical.judges[0], reasoningEffort: effort }],
    });
    assert.equal(parsed.judges[0]?.reasoningEffort, effort);
  }
});
