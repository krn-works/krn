import assert from 'node:assert/strict';
import test from 'node:test';
import {
  extractCases,
  fingerprint,
  hasAncestor,
  isFix,
  isTestPath,
  nearest,
  similarity,
  wilson,
} from '../../evals/sibling-transplant/detector.ts';

const sibling = (name: string, input: string, want: string) =>
  `it('${name}', () => {\n  const result = parse${name}(${JSON.stringify(input)});\n  expect(result.value).toBe(${JSON.stringify(want)});\n  expect(result.errors).toEqual([]);\n  expect(result.done).toBe(true);\n});`;

test('a sibling with other names and literals is a clone of the case it was copied from', () => {
  const a = fingerprint(sibling('Url', 'http://a', 'x'));
  const b = fingerprint(sibling('Mail', 'a@b', 'y'));
  assert.ok(hasAncestor(similarity(a, b)));
});

test('an unrelated test body is not an ancestor', () => {
  const a = fingerprint(sibling('Url', 'http://a', 'x'));
  const other = fingerprint(
    "it('loops', async () => { for (const item of await load()) { if (item.hidden) continue; await Promise.all(item.jobs.map((j) => run(j, { retries: 3 }))); } });",
  );
  assert.ok(!hasAncestor(nearest(other, [a])));
});

test('typescript cases are found with nested parens, strings holding parens and modifier forms', () => {
  const src =
    "describe('x', () => {\n  it('a (b)', () => { f(')'); });\n  test.only(\"c\", () => {});\n  it(`d`, () => { g(h(1)); });\n});";
  assert.deepEqual(
    extractCases(src, 'ts').map((c) => c.name),
    ['a (b)', 'c', 'd'],
  );
});

test('python cases end at the next line at or below the def indentation', () => {
  const src =
    'def helper():\n    pass\n\ndef test_one():\n    assert 1\n\n    assert 2\n\nclass T:\n    def test_two(self):\n        assert 3\n';
  const got = extractCases(src, 'py');
  assert.deepEqual(
    got.map((c) => c.name),
    ['test_one', 'test_two'],
  );
  assert.ok(got[0]?.body.includes('assert 2'));
  assert.ok(!got[0]?.body.includes('class T'));
});

test('test paths are recognised per language and the fix subject heuristic', () => {
  assert.ok(isTestPath('src/a.test.ts', 'ts'));
  assert.ok(isTestPath('packages/x/tests/a.ts', 'ts'));
  assert.ok(!isTestPath('src/a.ts', 'ts'));
  assert.ok(isTestPath('tests/test_a.py', 'py'));
  assert.ok(!isTestPath('src/a.py', 'py'));
  assert.ok(isFix('fix(url): reject empty host'));
  assert.ok(isFix('Handle a regression in routing'));
  assert.ok(!isFix('feat: add the mail parser'));
});

test('wilson interval brackets the share', () => {
  const w = wilson(50, 100);
  assert.ok(w.lo < 0.5 && w.hi > 0.5);
  assert.deepEqual(wilson(0, 0), { lo: 0, hi: 1 });
});
