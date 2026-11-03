import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { appendOverride, writeReviewRecord } from '../../src/flow/record.ts';
import * as types from '../../src/flow/types.ts';

const { newReviewRecordSchema, panelRoles, reviewRecordSchema } = types;

const blocking = {
  severity: 'BLOCKING' as const,
  title: 'Empty input fails',
  path: 'src.ts',
  line: 1,
  defect: 'An empty input throws instead of returning zero.',
  fix: 'Return zero for an empty input.',
};

function git(root: string, ...args: string[]): string {
  const result = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function fixture(t: test.TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'krn-override-admission-'));
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
  return { root, base, head: git(root, 'rev-parse', 'HEAD') };
}

const failJudge = (role: string) => ({
  state: 'complete' as const,
  role,
  model: `fixture-${role}`,
  reasoningEffort: 'high' as const,
  verdict: 'FAIL' as const,
  findings: [blocking],
  sessionId: `judge-${role}`,
  finalMessage: 'FAIL',
});
const incompleteJudge = (role: string) => ({
  state: 'incomplete' as const,
  role,
  model: `fixture-${role}`,
  reasoningEffort: 'high' as const,
  reason: 'nonzero_exit' as const,
  reasonKind: 'nonzero_exit',
  sessionId: `judge-${role}`,
  exitCode: 1,
});

function panelFail(base: string, head: string, complete: boolean) {
  return newReviewRecordSchema.parse({
    schemaVersion: 1,
    headSha: head,
    base,
    createdAt: '2026-01-01T00:00:00.000Z',
    panelVerdict: 'FAIL',
    panel: {
      requestedRoles: [...panelRoles],
      requiredRoles: [...panelRoles],
      partial: false,
    },
    redFirst: [],
    judges: panelRoles.map((role, index) =>
      complete || index === 0 ? failJudge(role) : incompleteJudge(role),
    ),
    lensSha256: 'a'.repeat(64),
    toolSha: base,
  });
}

test('the shared overridable-failure predicate is exported', () => {
  assert.equal(typeof types.isOverridableFailure, 'function');
});

test('appendOverride refuses a panel FAIL with an incomplete judge', (t) => {
  const value = fixture(t);
  const record = panelFail(value.base, value.head, false);
  assert.equal(record.panelVerdict, 'FAIL');
  writeReviewRecord(value.root, record);
  assert.throws(
    () =>
      appendOverride(value.root, value.head, {
        reason: 'accept residual risk',
        evidence: 'one judge failed, the others did not finish',
      }),
    /override requires a recorded FAIL/u,
  );
});

test('the predicate refuses partial or incomplete panels and accepts a complete FAIL', (t) => {
  assert.equal(typeof types.isOverridableFailure, 'function');
  const value = fixture(t);
  const complete = reviewRecordSchema.parse(
    panelFail(value.base, value.head, true),
  );
  assert.equal(types.isOverridableFailure(complete), true);
  const incomplete = reviewRecordSchema.parse(
    panelFail(value.base, value.head, false),
  );
  assert.equal(types.isOverridableFailure(incomplete), false);
  assert.equal(
    types.isOverridableFailure({
      ...complete,
      panel: { ...complete.panel!, partial: true },
    }),
    false,
  );
  assert.equal(
    types.isOverridableFailure({ ...complete, panelVerdict: 'PASS' }),
    false,
  );
});

test('appendOverride accepts a complete panel FAIL', (t) => {
  const value = fixture(t);
  writeReviewRecord(value.root, panelFail(value.base, value.head, true));
  const updated = appendOverride(value.root, value.head, {
    reason: 'accept residual risk',
    evidence: 'every judge completed',
  });
  assert.equal(updated.override?.reason, 'accept residual risk');
});
