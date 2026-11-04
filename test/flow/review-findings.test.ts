import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseJudgeResponse } from '../../src/flow/panel.ts';
import type { ReviewRecord, ReviewRole } from '../../src/flow/types.ts';

const api = await import('../../src/flow/findings.ts').catch(() => undefined);
const finding = {
  severity: 'BLOCKING' as const,
  title: 'Bug',
  path: 'src/a.ts',
  line: 3,
  defect: 'Fails on empty input',
  fix: 'Handle empty input',
};
function judge(role: ReviewRole): ReviewRecord['judges'][number] {
  return {
    state: 'complete',
    role,
    verdict: 'FAIL',
    findings: [finding],
    sessionId: role,
    finalMessage: '{}',
  };
}
test('duplicate findings collect unique sorted role votes', () => {
  assert.equal(typeof api?.consolidateFindings, 'function');
  assert.ok(api);
  const list = api.consolidateFindings([
    judge('spec'),
    judge('standards'),
    judge('spec'),
  ]);
  assert.equal(list.length, 1);
  assert.deepEqual(list[0]?.roles, ['spec', 'standards']);
});
test('style-only blocker becomes PASS and records dropped count', () => {
  assert.equal(typeof api?.dropStyle, 'function');
  const original = judge('spec');
  assert.equal(original.state, 'complete');
  if (original.state !== 'complete') throw new Error('fixture');
  assert.ok(api);
  const result = api.dropStyle({
    ...original,
    findings: [{ ...finding, category: 'style' }],
  });
  assert.equal(result.state, 'complete');
  if (result.state !== 'complete') throw new Error('unexpected incomplete');
  assert.equal(result.verdict, 'PASS');
  assert.equal(result.droppedStyle, 1);
  assert.deepEqual(result.findings, []);
});
test('unknown category rejects judge response', () => {
  assert.throws(() =>
    parseJudgeResponse(
      JSON.stringify({
        verdict: 'FAIL',
        findings: [{ ...finding, category: 'unknown' }],
      }),
    ),
  );
});

test('style filtering preserves real blockers and unresolved prior findings', () => {
  assert.ok(api);
  const original = judge('spec');
  if (original.state !== 'complete') throw new Error('fixture');
  const style = { ...finding, category: 'style' as const };
  const unresolved = api.dropStyle({
    ...original,
    findings: [style],
    prior: [{ index: 0, status: 'UNRESOLVED', evidence: 'Still broken' }],
  });
  assert.equal(unresolved.state === 'complete' && unresolved.verdict, 'FAIL');
  const mixed = api.dropStyle({ ...original, findings: [style, finding] });
  assert.equal(mixed.state === 'complete' && mixed.verdict, 'FAIL');
});
test('consolidation prioritizes severity, preserves null keys and bounds output', () => {
  assert.ok(api);
  const result = api.consolidateFindings([
    {
      state: 'complete',
      role: 'spec',
      findings: [
        { ...finding, severity: 'NON_BLOCKING', path: null, line: null },
      ],
    },
    {
      state: 'complete',
      role: 'adversarial',
      findings: [{ ...finding, path: null, line: null }],
    },
  ]);
  assert.equal(result.length, 1);
  assert.equal(result[0]?.severity, 'BLOCKING');
  assert.deepEqual(result[0]?.roles, ['adversarial', 'spec']);
  assert.equal(result[0]?.path, null);
  assert.equal(result[0]?.line, null);
  const bounded = api.consolidateFindings([
    {
      state: 'complete',
      role: 'spec',
      findings: Array.from({ length: 201 }, (_, line) => ({
        ...finding,
        line: line + 1,
        severity: line === 200 ? 'BLOCKING' : 'NON_BLOCKING',
      })),
    },
  ]);
  assert.equal(bounded.length, 200);
  assert.equal(bounded[0]?.severity, 'BLOCKING');
});
test('CLI text cannot introduce extra lines or control characters', () => {
  assert.ok(api);
  for (const separator of ['\n', '\r', '\u2028', '\u2029'])
    assert.equal(api.oneLine(`safe${separator}injected`), 'safe');
  assert.equal(api.oneLine('a\x1b\u200bb'), 'ab');
});
