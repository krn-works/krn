import assert from 'node:assert/strict';
import test from 'node:test';
import {
  adoptArgs,
  baseCommit,
  drainFacts,
  gradedRow,
  outsideBranch,
  parseOptions,
} from '../../scripts/outside-acceptance.ts';

test('only outside/<stack> branches can be named, so a cleanup never touches another branch', () => {
  assert.equal(outsideBranch('php'), 'outside/php');
  for (const bad of ['', '../x', 'a/b', 'Py', 'x y'])
    assert.throws(() => outsideBranch(bad), /bad stack name/u);
});

test('options default to the three stacks, two tasks per drain, and reject unknown input', () => {
  const options = parseOptions([], '/repo');
  assert.deepEqual(options.stacks, ['php', 'npm', 'py']);
  assert.equal(options.max, 2);
  assert.equal(options.summary, '/repo/.krn/runs/outside/summary.txt');
  assert.deepEqual(
    parseOptions(['--stack', 'py', '--max', '1'], '/repo').stacks,
    ['py'],
  );
  assert.throws(
    () => parseOptions(['--max', '0'], '/repo'),
    /positive integer/u,
  );
  assert.throws(
    () => parseOptions(['--stack', 'main/x'], '/repo'),
    /bad stack name/u,
  );
  assert.throws(() => parseOptions(['--bogus'], '/repo'), /unknown argument/u);
  assert.throws(() => parseOptions(['--stack'], '/repo'), /requires a value/u);
});

test('the orphan base is the parent of the adopt commit', () => {
  const log = [
    { sha: 'c', parent: 'b', subject: 'test: later' },
    { sha: 'b', parent: 'a', subject: 'chore: adopt krn' },
    { sha: 'a', parent: undefined, subject: 'drop workflows' },
  ];
  assert.equal(baseCommit(log), 'a');
  assert.throws(
    () => baseCommit([log[2] as (typeof log)[number]]),
    /no "chore: adopt krn"/u,
  );
});

test('adopt arguments carry the scratch copy test command', () => {
  assert.deepEqual(adoptArgs('/d', { test: 'php tests/run.php' }), [
    'adopt',
    '/d',
    '--tracker',
    '--test',
    'php tests/run.php',
  ]);
  assert.deepEqual(adoptArgs('/d', {}), ['adopt', '/d', '--tracker']);
});

test('drain facts count sessions, merged verdicts, PRs and cost', () => {
  const output = [
    't-aaa t-aaa exit=0 120s',
    'cost $0.15 turns 12',
    'https://github.com/krn-works/krn/pull/901',
    'verdict: merged abc123',
    't-bbb t-bbb exit=74 90s',
    'PR #902 cost $0.22',
  ].join('\n');
  assert.deepEqual(drainFacts(74, output), {
    exitCode: 74,
    sessions: 2,
    merged: 1,
    prs: ['#901', '#902'],
    usd: 0.37,
  });
});

test('a row is graded all merged only for exit 0 with every PR merged', () => {
  const green = drainFacts(0, 't-a t-a exit=0 1s\nPR #5\nverdict: merged x');
  assert.match(
    gradedRow({ stack: 'py', adoptExit: 0, firstPr: '#5', drain: green }),
    /^krn-works\/krn outside\/py \| py \| 0 \| #5 \| 0 \| #5 \(all merged\) \| 1 \| \$0\.00$/u,
  );
  const red = drainFacts(73, 't-a t-a exit=73 1s\nPR #5');
  assert.match(
    gradedRow({ stack: 'py', adoptExit: 0, firstPr: '#5', drain: red }),
    /\| 73 \| #5 \(0 merged\)/u,
  );
  assert.match(
    gradedRow({
      stack: 'php',
      adoptExit: 1,
      firstPr: 'none',
      drain: undefined,
      note: 'push failed',
    }),
    /\| not run \| none \| 0 \| \$0\.00 \| push failed$/u,
  );
});
