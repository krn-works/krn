import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  adoptArgs,
  baseCommit,
  defaultScratch,
  drainFacts,
  entryCommit,
  gradedRow,
  hiddenResult,
  hiddenSeedTask,
  hookCell,
  hookPath,
  outsideBranch,
  parseOptions,
  parseTaskFile,
  pick,
  publishRefusal,
  rowGreen,
  seedTask,
  workflowFiles,
} from '../../scripts/outside-acceptance.ts';
import { GREEN_BASE_TASK_TITLE } from '../../src/adopt/adopt.ts';

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
    /^krn-works\/krn outside\/py \| py \| 0 \| #5 \| 0 \| #5 \(all merged\) \| 1 \| \$0\.00 \| none \| none$/u,
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
    /\| not run \| none \| 0 \| \$0\.00 \| none \| none \| push failed$/u,
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
    /\| 0 \| 510b485 \(all merged\) \| 1 \| \$0\.12 \| none \| none$/u,
  );
});

test('pick carries install and related from the scratch krn.json and names the orphan branch as the base', () => {
  assert.deepEqual(
    pick({ test: 't', install: 'i', related: 'r' } as never, 'outside/php'),
    { base: 'outside/php', install: 'i', related: 'r' },
  );
  assert.deepEqual(pick({ test: 't', base: 'main' }, 'outside/py'), {
    base: 'outside/py',
  });
});

test('the scratch default is the env override, else krn-outside in the system temp dir', () => {
  assert.equal(defaultScratch({ KRN_OUTSIDE_SCRATCH: '/x' }), '/x');
  assert.match(defaultScratch({ KRN_OUTSIDE_SCRATCH: '' }), /krn-outside$/u);
});

test('a public or unknown remote takes only a copy with a public upstream and an open licence', () => {
  const ok = JSON.stringify({ url: 'https://github.com/o/r', license: 'MIT' });
  assert.equal(publishRefusal(undefined, 'private'), undefined);
  assert.equal(publishRefusal(ok, 'public'), undefined);
  assert.match(publishRefusal(undefined, 'public') ?? '', /no UPSTREAM\.json/u);
  assert.match(
    publishRefusal(undefined, undefined) ?? '',
    /unknown visibility/u,
  );
  assert.match(publishRefusal('{', 'public') ?? '', /not JSON/u);
  assert.match(
    publishRefusal(
      JSON.stringify({ url: '/var/www/x', license: 'MIT' }),
      'public',
    ) ?? '',
    /https "url"/u,
  );
  assert.match(
    publishRefusal(
      JSON.stringify({ url: 'https://x/y', license: 'proprietary' }),
      'public',
    ) ?? '',
    /open "license"/u,
  );
});

const shippedRows = readFileSync(
  new URL('../../scripts/outside-hidden/tasks.json', import.meta.url),
  'utf8',
);

test('the shipped task file holds one public fixed-issue row per stack and parses', () => {
  const rows = parseTaskFile(shippedRows);
  assert.deepEqual(
    rows.map((row) => row.stack),
    ['php', 'npm', 'py', 'php-red', 'npm-workspaces', 'wp-plugin'],
  );
  for (const row of rows) assert.match(row.fix, /^[0-9a-f]{7,40}$/u);
});

test('a task file refuses a malformed, private or escaping row before anything is pushed', () => {
  const row = JSON.parse(shippedRows).rows[0];
  const text = (patch: Record<string, unknown>) =>
    JSON.stringify({ rows: [{ ...row, ...patch }] });
  assert.throws(() => parseTaskFile('nope'), /not JSON/u);
  assert.throws(() => parseTaskFile('{}'), /"rows" array/u);
  assert.throws(() => parseTaskFile(text({ fix: 'main' })), /not a commit/u);
  assert.throws(
    () => parseTaskFile(text({ hidden: ['../x'] })),
    /leaves the repository/u,
  );
  assert.throws(
    () => parseTaskFile(text({ license: 'proprietary' })),
    /open "license"/u,
  );
  assert.throws(
    () => parseTaskFile(text({ upstream: 'git@github.com:a/b.git' })),
    /https "url"/u,
  );
  assert.throws(() => parseTaskFile(text({ title: '' })), /needs "title"/u);
});

test('the fixed-issue seed names the bug and verifies with the row test command, never the hidden one', () => {
  const [row] = parseTaskFile(shippedRows);
  if (row === undefined) throw new Error('no row');
  const seed = hiddenSeedTask(row, '2026-11-15');
  const task = JSON.parse(seed.text) as Record<string, unknown>;
  assert.equal(task.priority, 0);
  assert.equal(task.title, row.title);
  assert.deepEqual(task.body, row.body);
  assert.deepEqual(task.acceptance, [
    { verify: row.test, passes: false, exit: null },
  ]);
  assert.doesNotMatch(seed.text, /phpunit-shim/u);
});

test('a red-base row seeds the green-base task, so a red baseline admits it, and every shipped row parses', () => {
  const rows = parseTaskFile(shippedRows);
  const red = rows.find((row) => row.redBase === true);
  if (red === undefined) throw new Error('no red-base row shipped');
  const task = JSON.parse(hiddenSeedTask(red, '2026-11-15').text) as Record<
    string,
    unknown
  >;
  assert.equal(task.title, GREEN_BASE_TASK_TITLE);
  assert.deepEqual(task.body, [red.title, ...red.body]);
  // The red row's hidden test is the red test itself: it is the same file on the base and on the fix.
  assert.deepEqual(red.hidden, ['tests/GetInTest.php']);
  for (const stack of ['npm-workspaces', 'wp-plugin'])
    assert.ok(
      rows.some((row) => row.stack === stack),
      stack,
    );
  assert.notEqual(
    JSON.parse(hiddenSeedTask(rows[0] as never, '2026-11-15').text).title,
    GREEN_BASE_TASK_TITLE,
  );
});

test('the hidden column grades pass, fail or none from the held-back test exit code', () => {
  assert.equal(hiddenResult(0), 'pass');
  assert.equal(hiddenResult(1), 'fail');
  assert.equal(hiddenResult(undefined), 'none');
  const green = drainFacts(
    0,
    't-a t-a exit=0 1s\nPR #5\nverdict: merged abc1234def',
  );
  const row = (hidden: 'pass' | 'fail' | 'none') =>
    gradedRow({
      stack: 'php',
      adoptExit: 0,
      firstPr: '#5',
      drain: green,
      hidden,
      note: 'merged abc1234',
    });
  assert.match(row('pass'), /\| \$0\.00 \| pass \| none \| merged abc1234$/u);
  assert.equal(rowGreen(row('pass')), true);
  assert.equal(rowGreen(row('none')), true);
  assert.equal(rowGreen(row('fail')), false);
});

test('a task file option is read and a row with a red drain is never green', () => {
  assert.equal(
    parseOptions(['--task-file', 'rows.json'], '/repo').taskFile,
    `${process.cwd()}/rows.json`,
  );
  const red = drainFacts(73, 't-a t-a exit=73 1s\nPR #5');
  assert.equal(
    rowGreen(
      gradedRow({
        stack: 'py',
        adoptExit: 0,
        firstPr: '#5',
        drain: red,
        hidden: 'pass',
      }),
    ),
    false,
  );
});

test('workflow files are dropped from an outside base because a GitHub App cannot push them', () => {
  assert.deepEqual(
    workflowFiles([
      'README.md',
      '.github/workflows/main.yml',
      '.github/dependabot.yml',
      '.github/workflows/b.yaml',
    ]),
    ['.github/workflows/main.yml', '.github/workflows/b.yaml'],
  );
});

test('a row may carry support files for its base and refuses paths that escape', () => {
  const row = JSON.parse(shippedRows).rows[0];
  const text = (support: unknown) =>
    JSON.stringify({ rows: [{ ...row, support }] });
  assert.deepEqual(
    parseTaskFile(text({ 'tests/a.php': 'scripts/x.php' }))[0]?.support,
    {
      'tests/a.php': 'scripts/x.php',
    },
  );
  assert.throws(
    () => parseTaskFile(text({ '../a': 'x' })),
    /leaves the repository/u,
  );
  assert.throws(
    () => parseTaskFile(text({ a: '/etc/passwd' })),
    /leaves the repository/u,
  );
  assert.equal(
    JSON.parse(shippedRows).rows[0].support['tests/shim.php'],
    'scripts/outside-hidden/phpunit-shim.php',
  );
});

test('a row carries the related-test command of a stack whose detected one the host cannot run', () => {
  const rows = parseTaskFile(shippedRows);
  const py = rows.find((row) => row.stack === 'py');
  assert.match(String(py?.related), /pytest -q \{files\}$/u);
  assert.equal(rows.find((row) => row.stack === 'php')?.related, undefined);
});

const head = 'a'.repeat(40);
const stale = 'b'.repeat(40);

/** A krn on PATH whose `doctor` prints the commit it was built from, like the real entry. */
function fakeKrn(dir: string, commit: string): string {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'krn'), `#!/bin/sh\necho "entry-commit=${commit}"\n`);
  chmodSync(join(dir, 'krn'), 0o755);
  return dir;
}

const doctorCommit = (pathEnv: string) =>
  entryCommit(
    spawnSync('krn', ['doctor'], {
      encoding: 'utf8',
      env: { PATH: pathEnv },
    }).stdout,
  );

test('the checkout bin comes first on PATH, so a stale installed shim cannot serve the hooks', () => {
  const work = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), 'hook-skew-'));
  const shim = fakeKrn(join(work, 'shim'), stale);
  fakeKrn(join(work, 'root/bin'), head);
  const path = hookPath(join(work, 'root'), `${shim}:/usr/bin:/bin`);
  assert.equal(path.split(':')[0], join(work, 'root/bin'));
  assert.equal(doctorCommit(path), head);
  assert.equal(doctorCommit(`${shim}:/usr/bin:/bin`), stale);
});

test('a row whose hook commit differs from the checkout HEAD is skewed and not green', () => {
  assert.equal(entryCommit(`entry-commit=${head}\nstatus=fresh\n`), head);
  assert.equal(entryCommit('entry-commit=unknown\n'), undefined);
  assert.equal(hookCell({ commit: head, head }), 'aaaaaaa');
  assert.equal(hookCell({ commit: stale, head }), 'skew bbbbbbb != aaaaaaa');
  assert.equal(
    hookCell({ commit: undefined, head }),
    'skew unknown != aaaaaaa',
  );
  const drain = drainFacts(
    0,
    't-a t-a exit=0 1s\nPR #5\nverdict: merged abc1234def',
  );
  const row = (commit: string) =>
    gradedRow({
      stack: 'py',
      adoptExit: 0,
      firstPr: '#5',
      drain,
      hook: { commit, head },
    });
  assert.equal(rowGreen(row(head)), true);
  assert.equal(rowGreen(row(stale)), false);
});
