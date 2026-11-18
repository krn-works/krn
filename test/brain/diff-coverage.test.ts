import assert from 'node:assert/strict';
import test from 'node:test';
import {
  changedSourceLines,
  diffCoverage,
  diffCoverageText,
  lcovLines,
} from '../../src/brain/diff-coverage.ts';

// The plainest unified diff, as `git diff -U0` prints it: one source file and one test file changed.
const diff = `diff --git a/src/a.ts b/src/a.ts
index 1111111..2222222 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -2,0 +3,4 @@ export function a(x: number) {
+  if (x < 0) {
+    // negative input
+    return 0;
+
@@ -9 +13 @@ export function b() {
-  return 1;
+  return 2;
diff --git a/test/a.test.ts b/test/a.test.ts
new file mode 100644
--- /dev/null
+++ b/test/a.test.ts
@@ -0,0 +1 @@
+test('a', () => {});
diff --git a/README.md b/README.md
--- a/README.md
+++ b/README.md
@@ -1 +1 @@
-old
+new
`;

const lcov = `TN:
SF:src/a.ts
DA:3,1
DA:4,0
DA:5,0
DA:6,0
DA:13,1
end_of_record
`;

test('the changed source lines are the added lines of script files, without tests, comments or blank lines', () => {
  assert.deepEqual([...changedSourceLines(diff)], [['src/a.ts', [3, 5, 13]]]);
});

test('a change adding an unexecuted branch reports that line uncovered by file:line', () => {
  const coverage = diffCoverage(changedSourceLines(diff), lcovLines(lcov));
  assert.deepEqual(coverage, {
    covered: 2,
    changed: 3,
    uncovered: ['src/a.ts:5'],
  });
  assert.equal(
    diffCoverageText(coverage),
    'diff-coverage 2/3 (uncovered src/a.ts:5)',
  );
});

test('a fully covered change reports 0 uncovered', () => {
  const coverage = diffCoverage(
    new Map([['src/a.ts', [3, 13]]]),
    lcovLines(lcov),
  );
  assert.deepEqual(coverage, { covered: 2, changed: 2, uncovered: [] });
  assert.equal(diffCoverageText(coverage), 'diff-coverage 2/2');
});

test('a changed file no test loaded is uncovered on every changed line', () => {
  const coverage = diffCoverage(
    new Map([['src/b.ts', [1, 2]]]),
    lcovLines(lcov),
  );
  assert.deepEqual(coverage?.uncovered, ['src/b.ts:1', 'src/b.ts:2']);
});

test('no coverage source reports diff-coverage n/a, and a long list names ten lines and counts the rest', () => {
  assert.equal(diffCoverage(new Map(), lcovLines(lcov)), undefined);
  assert.equal(diffCoverageText(undefined), 'diff-coverage n/a');
  const lines = Array.from({ length: 12 }, (_, i) => i + 1);
  const text = diffCoverageText(
    diffCoverage(new Map([['src/c.ts', lines]]), new Map()),
  );
  assert.match(
    text,
    /^diff-coverage 0\/12 \(uncovered src\/c\.ts:1 .* src\/c\.ts:10 \+2 more\)$/u,
  );
});
