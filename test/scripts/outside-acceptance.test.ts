import assert from 'node:assert/strict';
import test from 'node:test';
import {
  adoptArgs,
  baseCommit,
  drainFacts,
  gradedRow,
  outsideBranch,
  parseOptions,
  seedTask,
} from '../../scripts/outside-acceptance.ts';

test('only outside/<stack> branches can be named, so a cleanup never touches another branch', () => {
  assert.equal(outsideBranch('php'), 'outside/php');
  for (const bad of ['', '../x', 'a/b', 'Py', 'x y'])
    assert.throws(() => outsideBranch(bad), /bad stack name/u);
});

test('options default to the three stacks, one task per drain, and reject unknown input', () => {
  const options = parseOptions([], '/repo');
  assert.deepEqual(options.stacks, ['php', 'npm', 'py']);
  assert.equal(options.max, 1);
  // The drain's own 8h vault window: a bw serve session lasts 10h, so 24h can never pass doctor.
  assert.equal(options.windowHours, 8);
  assert.equal(parseOptions(['--window-hours', '3'], '/repo').windowHours, 3);
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
    'verdict: merged abc1234def',
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
  const green = drainFacts(
    0,
    't-a t-a exit=0 1s\nPR #5\nverdict: merged abc1234def',
  );
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

test('the seeded task is a priority-0 open task whose acceptance is the stack test command', () => {
  const seed = seedTask('php', 'php tests/run.php', '2026-11-15');
  const task = JSON.parse(seed.text) as Record<string, unknown>;
  assert.equal(seed.file, `tasks/${String(task.id)}.json`);
  assert.match(String(task.id), /^t-[0-9a-z]{7}$/u);
  assert.equal(task.priority, 0);
  assert.equal(task.status, 'open');
  assert.deepEqual(task.acceptance, [
    { verify: 'php tests/run.php', passes: false, exit: null },
  ]);
});

test('the drain output of a real merged run is graded all merged with its commit as the PR', () => {
  const output = [
    't-04ewf92 t-04ewf92 exit=0 30s',
    'lane t-04ewf92: shipped verdict: merged 510b485aef26b755ca0e44925bb8032ac7090155 model sonnet cost $0.12 turns 5 packet 7964ce2867fc',
  ].join('\n');
  const facts = drainFacts(0, output);
  assert.deepEqual(facts.prs, ['510b485']);
  assert.equal(facts.merged, 1);
  assert.match(
    gradedRow({ stack: 'php', adoptExit: 0, firstPr: '510b485', drain: facts }),
    /\| 0 \| 510b485 \(all merged\) \| 1 \| \$0\.12$/u,
  );
});
