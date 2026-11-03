import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { appendOverride, writeReviewRecord } from '../../src/flow/record.ts';
import {
  newReviewRecordSchema,
  panelRoles,
  reviewRecordSchema,
} from '../../src/flow/types.ts';

const blocking = {
  severity: 'BLOCKING' as const,
  title: 'Empty input fails',
  path: 'src.ts',
  line: 1,
  defect: 'An empty input throws instead of returning zero.',
  fix: 'Return zero for an empty input.',
};
const advisory = {
  ...blocking,
  severity: 'NON_BLOCKING' as const,
  title: 'Advisory observation',
};

function git(root: string, ...args: string[]): string {
  const result = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function fixture(t: test.TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'krn-review-prepass-override-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  git(root, 'init', '-q');
  git(root, 'config', 'user.name', 'Review test');
  git(root, 'config', 'user.email', 'review@example.invalid');
  mkdirSync(join(root, '.krn'));
  writeFileSync(join(root, 'src.ts'), 'export const answer = 1;\n');
  git(root, 'add', '.');
  git(root, 'commit', '-qm', 'initial behavior');
  const base = git(root, 'rev-parse', 'HEAD');
  writeFileSync(join(root, 'src.ts'), 'export const answer = 2;\n');
  git(root, 'commit', '-qam', 'review target');
  const head = git(root, 'rev-parse', 'HEAD');
  return { root, base, head };
}

function prepassOnlyRecord(base: string, head: string) {
  return newReviewRecordSchema.parse({
    schemaVersion: 1,
    headSha: head,
    base,
    createdAt: '2026-01-01T00:00:00.000Z',
    redFirst: [],
    judges: [],
    prepass: {
      state: 'complete',
      findings: [blocking],
      sessionId: 'prepass-session',
    },
    lensSha256: 'a'.repeat(64),
    toolSha: base,
  });
}

function advisoryRecord(base: string, head: string) {
  return newReviewRecordSchema.parse({
    schemaVersion: 1,
    headSha: head,
    base,
    createdAt: '2026-01-01T00:00:00.000Z',
    panelVerdict: 'PASS',
    panel: {
      requestedRoles: [...panelRoles],
      requiredRoles: [...panelRoles],
      partial: false,
    },
    redFirst: [],
    judges: panelRoles.map((role) => ({
      state: 'complete' as const,
      role,
      model: `fixture-${role}`,
      reasoningEffort: 'high' as const,
      verdict: 'PASS' as const,
      findings: [],
      sessionId: `judge-${role}`,
      finalMessage: 'PASS',
    })),
    prepass: {
      state: 'complete',
      findings: [advisory],
      sessionId: 'prepass-session',
    },
    lensSha256: 'a'.repeat(64),
    toolSha: base,
  });
}

test('appendOverride persists an override for a complete blocking prepass', (t) => {
  const value = fixture(t);
  writeReviewRecord(value.root, prepassOnlyRecord(value.base, value.head));

  let updated: ReturnType<typeof appendOverride> | undefined;
  assert.doesNotThrow(() => {
    updated = appendOverride(value.root, value.head, {
      reason: 'accepted residual risk',
      evidence: 'verified in the follow-up probe',
    });
  });
  assert.ok(updated);
  assert.equal(updated.override?.reason, 'accepted residual risk');
  assert.equal(updated.headSha, value.head);

  const recordPath = join(
    value.root,
    '.krn',
    'runs',
    'review',
    value.head,
    'record.json',
  );
  const persisted = reviewRecordSchema.parse(
    JSON.parse(readFileSync(recordPath, 'utf8')),
  );
  assert.equal(persisted.override?.reason, 'accepted residual risk');
});

test('appendOverride rejects a prepass with only advisory findings', (t) => {
  const value = fixture(t);
  writeReviewRecord(value.root, advisoryRecord(value.base, value.head));

  assert.throws(
    () =>
      appendOverride(value.root, value.head, {
        reason: 'accepted an advisory',
        evidence: 'no blocking finding was recorded',
      }),
    /override requires a recorded FAIL/u,
  );
});
