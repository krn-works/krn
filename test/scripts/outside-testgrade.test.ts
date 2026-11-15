import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assertPublicPull,
  grade,
  renderTable,
  rowKind,
  summarize,
  testCommand,
  testFiles,
} from '../../scripts/outside-testgrade.ts';

test('test files are picked from every stack and trackers never count', () => {
  const changed = [
    'tasks/t-1.json',
    'src/get_in.php',
    'tests/GetInTest.php',
    'test/parse-link-header.js',
    'tests/test_import.py',
    'lib/a.test.mjs',
    'index.js',
  ];
  assert.deepEqual(testFiles(changed), [
    'tests/GetInTest.php',
    'test/parse-link-header.js',
    'tests/test_import.py',
    'lib/a.test.mjs',
  ]);
});

test('python tests run under pytest, other stacks keep the row command', () => {
  assert.equal(
    testCommand(['tests/test_a.py'], '.venv/bin/python -m pytest'),
    'PYTHONPATH=. pytest -q tests/test_a.py',
  );
  assert.equal(
    testCommand(
      ['tests/test_a.py'],
      'x',
      'python3 -m venv .venv && pip install',
    ),
    '.venv/bin/python -m pytest -q tests/test_a.py',
  );
  assert.equal(
    testCommand(['tests/smoke.php'], 'php tests/smoke.php'),
    'php tests/smoke.php',
  );
});

test('grade separates a red-on-base fix from a covering test', () => {
  assert.equal(grade(1, 0), 'red-then-green');
  assert.equal(grade(0, 0), 'green-on-both');
  assert.equal(grade(0, 1), 'red-on-merge');
  assert.equal(grade(1, 1), 'red-on-both');
});

test('row kind is fix only when a source changes beside the test', () => {
  assert.equal(
    rowKind(['tasks/t.json', 'tests/run.php', 'krn.json']),
    'test-only',
  );
  assert.equal(
    rowKind(['tasks/t.json', 'src/get_in.php', 'tests/GetInTest.php']),
    'fix',
  );
});

test('summary and table count red on base and green on merge', () => {
  const rows = [
    {
      pull: 1,
      merged: 'aaa',
      kind: 'fix',
      files: ['t'],
      baseExit: 1,
      mergedExit: 0,
    },
    {
      pull: 2,
      merged: 'bbb',
      kind: 'test-only',
      files: ['u'],
      baseExit: 0,
      mergedExit: 0,
    },
  ];
  assert.deepEqual(summarize(rows), {
    rows: 2,
    redOnBase: 1,
    greenOnMerge: 2,
    redThenGreen: 1,
  });
  assert.match(renderTable(rows), /Red on base: 1\/2\. Green on merge: 2\/2/u);
});

test('operator pull requests are refused', () => {
  assert.throws(() => assertPublicPull(868), /operator code/u);
  assert.throws(() => assertPublicPull(878), /operator code/u);
  assert.throws(() => assertPublicPull(0), /bad pull/u);
  assert.doesNotThrow(() => assertPublicPull(883));
});
