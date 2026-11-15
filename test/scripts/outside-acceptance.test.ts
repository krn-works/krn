import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  adoptArgs,
  adoptEnv,
  baseCommit,
  caseCounts,
  defaultScratch,
  drainBlocker,
  drainFacts,
  entryCommit,
  failedCases,
  failedRow,
  goToolchainBin,
  gradedRow,
  harvestRows,
  hiddenResult,
  hiddenSeedTask,
  hookCell,
  hookPath,
  hookTreeCommit,
  hostCredentialArgs,
  metricsCells,
  outsideBranch,
  ownedLaneBranches,
  parseOptions,
  parseTaskFile,
  pick,
  publishRefusal,
  pushFailureNote,
  remoteVisibility,
  repoFor,
  repoUrl,
  rowCredentialArgs,
  rowGreen,
  scratchRegistryEnv,
  scratchRowEnv,
  seedTask,
  sweepOwnedRows,
  workflowFiles,
  writeSeedTask,
} from '../../scripts/outside-acceptance.ts';
import { GREEN_BASE_TASK_TITLE } from '../../src/adopt/adopt.ts';
import { stopCommand } from '../../src/adopt/stop-hook.ts';
import { sessionEnvironment } from '../../src/cli/lane-run/environment.ts';

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
    turns: 12,
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

test('a row can target its own private repository while the public one stays refused for the same operator copy', () => {
  const options = parseOptions(
    [
      '--repo',
      'php=krn-works/outside-php',
      '--repo',
      'npm=krn-works/outside-npm',
    ],
    '/r',
    '/s',
  );
  const visibility: Record<string, string> = {
    'krn-works/outside-php': 'private',
    'krn-works/outside-npm': 'private',
    'krn-works/krn': 'public',
  };
  // An operator copy has no UPSTREAM.json.
  const refusalFor = (stack: string) =>
    publishRefusal(undefined, visibility[repoFor(options.repos, stack)]);
  assert.equal(refusalFor('php'), undefined);
  assert.equal(refusalFor('npm'), undefined);
  assert.match(refusalFor('py') ?? '', /remote is public/u);
  assert.equal(repoFor(options.repos, 'py'), 'krn-works/krn');
  assert.equal(
    repoUrl(repoFor(options.repos, 'php')),
    'https://github.com/krn-works/outside-php.git',
  );
  assert.match(
    gradedRow({
      repo: 'krn-works/outside-php',
      stack: 'php',
      adoptExit: 0,
      firstPr: '#1',
      drain: undefined,
    }),
    /^krn-works\/outside-php outside\/php \|/u,
  );
  assert.throws(() => parseOptions(['--repo', 'php'], '/r', '/s'), /STACK=/u);
  assert.throws(
    () => parseOptions(['--repo', 'php=https://x/y'], '/r', '/s'),
    /bad repository/u,
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
    [
      'php',
      'npm',
      'py',
      'php-red',
      'npm-workspaces',
      'wp-plugin',
      'frontend',
      'rust',
      'go',
    ],
  );
  for (const row of rows) assert.match(row.fix, /^[0-9a-f]{7,40}$/u);
});

test('clause 5 and clause 6: the frontend row grades a held-back component test and names its fix', () => {
  const row = parseTaskFile(shippedRows).find((r) => r.stack === 'frontend');
  assert.ok(row, 'no frontend row');
  assert.match(row.upstream, /^https:\/\/github\.com\//u);
  assert.equal(row.license, 'MIT');
  assert.deepEqual(row.hidden, [
    'packages/tailwind-merge/tests/important-modifier.test.ts',
  ]);
  assert.match(row.test ?? '', /vitest/u);
  assert.match(row.related ?? '', /\{files\}/u);
});

test('clause 7: the frontend row seeds a priority-0 task whose acceptance is the row test', () => {
  const row = parseTaskFile(shippedRows).find((r) => r.stack === 'frontend');
  assert.ok(row);
  const seeded = JSON.parse(hiddenSeedTask(row, '2026-11-15').text);
  assert.equal(seeded.priority, 0);
  assert.equal(seeded.acceptance[0].verify, row.test);
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

/** A git tree with a bin/krn whose `doctor` reports the host's product entry, like the real one, never the tree. */
function krnTree(dir: string, mark: string): { bin: string; commit: string } {
  mkdirSync(join(dir, 'bin'), { recursive: true });
  writeFileSync(join(dir, 'mark'), mark);
  fakeKrn(join(dir, 'bin'), 'c'.repeat(40));
  const git = (...args: string[]) =>
    spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], {
      cwd: dir,
      encoding: 'utf8',
    });
  git('init', '--quiet');
  git('add', '-A');
  git('commit', '--quiet', '-m', 'tree');
  return {
    bin: join(dir, 'bin'),
    commit: git('rev-parse', 'HEAD').stdout.trim(),
  };
}

test('the hook cell names the tree the hook command resolves, not what krn doctor reports', () => {
  const work = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), 'hook-tree-'));
  const checkout = krnTree(join(work, 'checkout'), 'checkout');
  const release = krnTree(join(work, 'release'), 'release');
  assert.notEqual(checkout.commit, release.commit);
  const rowPath = hookPath(
    join(work, 'checkout'),
    `${release.bin}:/usr/bin:/bin`,
  );
  const env = { PATH: rowPath };
  assert.equal(hookTreeCommit(env, work), checkout.commit);
  assert.equal(
    hookTreeCommit({ PATH: `${release.bin}:/usr/bin:/bin` }, work),
    release.commit,
  );
  // doctor reports the same host commit from both trees: it cannot tell them apart.
  assert.equal(
    doctorCommit(rowPath),
    doctorCommit(`${release.bin}:/usr/bin:/bin`),
  );
  assert.equal(hookTreeCommit({ PATH: '/nonexistent' }, work), undefined);
});

test('the Stop hook command a lane session runs executes the checkout krn, behind the lane session environment', () => {
  const work = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), 'hook-run-'));
  const checkout = krnTree(join(work, 'checkout'), 'checkout');
  const release = krnTree(join(work, 'release'), 'release');
  for (const bin of [checkout.bin, release.bin])
    writeFileSync(
      join(bin, 'krn'),
      `#!/bin/sh\necho "hook ran from ${bin}: $*"\nexit 2\n`,
    );
  const row = hookPath(join(work, 'checkout'), `${release.bin}:/usr/bin:/bin`);
  const session = sessionEnvironment({ PATH: row }, join(work, 'cache'), {
    lane: 'row',
  });
  const result = spawnSync('sh', ['-c', stopCommand], {
    encoding: 'utf8',
    env: session,
    input: '{}',
  });
  assert.equal(result.status, 2);
  assert.equal(
    result.stdout.trim(),
    `hook ran from ${checkout.bin}: hook stop`,
  );
  assert.equal(hookTreeCommit(session, work), checkout.commit);
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

test('case counts read pytest, TAP and the PHP shim output as passed over total', () => {
  assert.deepEqual(caseCounts('==== 2 failed, 5 passed in 0.12s ===='), {
    passed: 5,
    total: 7,
  });
  assert.deepEqual(caseCounts('5 passed in 0.01s'), { passed: 5, total: 5 });
  assert.deepEqual(caseCounts('ok 1 - a\n# tests 4\n# pass 3\n# fail 1\n'), {
    passed: 3,
    total: 4,
  });
  assert.deepEqual(caseCounts('FAIL T::a #0\nran 6, failed 2\n'), {
    passed: 4,
    total: 6,
  });
  assert.equal(caseCounts('no runner output'), undefined);
});

test('a graded row carries the hidden-case fraction, regressions, refusals and turns after the hook', () => {
  const drain = drainFacts(
    0,
    't-a t-a exit=0 1s\nPR #5 cost $0.2 turns 31\nverdict: merged abc1234def',
  );
  assert.equal(drain.turns, 31);
  const row = gradedRow({
    stack: 'py',
    adoptExit: 0,
    firstPr: '#5',
    drain,
    hidden: 'fail',
    metrics: { cases: { passed: 3, total: 5 }, regressions: 0, refusals: 1 },
  });
  assert.match(row, /\| fail \| none \| 3\/5 \| 0 \| 1 \| 31$/u);
  assert.deepEqual(
    metricsCells(
      { cases: undefined, regressions: undefined, refusals: 0 },
      undefined,
    ),
    ['none', 'none', '0', 'none'],
  );
});

test('a task row may name the existing suite whose failures count as regressions', () => {
  const row = (extra: object) =>
    JSON.stringify({
      rows: [
        {
          stack: 'py',
          upstream: 'https://github.com/o/r.git',
          license: 'MIT',
          fix: 'abc1234',
          title: 't',
          body: ['b'],
          hidden: ['tests/t.py'],
          hiddenVerify: 'true',
          ...extra,
        },
      ],
    });
  assert.equal(
    parseTaskFile(row({ suite: 'pytest -q' }))[0]?.suite,
    'pytest -q',
  );
  assert.equal(parseTaskFile(row({}))[0]?.suite, undefined);
});

test('every support file of the discriminating rows exists and the mock shim serves the mock package API', () => {
  const rows = parseTaskFile(
    readFileSync('scripts/outside-hidden/discriminating-tasks.json', 'utf8'),
  );
  for (const row of rows)
    for (const source of Object.values(row.support ?? {}))
      assert.ok(readFileSync(source, 'utf8').length > 0, source);
  const dir = mkdtempSync(join(tmpdir(), 'mock-shim-'));
  writeFileSync(
    join(dir, 'mock.py'),
    readFileSync('scripts/outside-hidden/py-mock-shim.py'),
  );
  const run = spawnSync(
    'python3',
    ['-c', 'import mock; assert mock.Mock and mock.patch'],
    { encoding: 'utf8', cwd: dir },
  );
  assert.equal(run.status, 0, run.stderr);
});

test('adoptEnv drops the test-first arm and keeps the rest', () => {
  const env = adoptEnv({ KRN_TEST_FIRST: '1', PATH: '/bin', HOME: '/h' });
  assert.deepEqual(env, { PATH: '/bin', HOME: '/h' });
});

test('failed cases name each failing hidden case from pytest, TAP and shim output', () => {
  const pytest = [
    'FAILED tests/test_a.py::test_threshold_counter - assert 1 == 2',
    'FAILED tests/test_a.py::test_bytes2human[1024] - AssertionError',
    'FAILED tests/test_a.py::test_threshold_counter - again',
    '==== 3 failed, 8 passed in 0.12s ====',
  ].join('\n');
  assert.deepEqual(failedCases(pytest), [
    'test_threshold_counter',
    'test_bytes2human[1024]',
  ]);
  assert.deepEqual(failedCases('ok 1 - a\nnot ok 2 - b c\n'), ['b c']);
  assert.deepEqual(failedCases('FAIL T::a #0\nran 6, failed 1\n'), ['a']);
  assert.deepEqual(failedCases('5 passed in 0.01s'), []);
});

test('a graded row names the failed hidden cases after the metrics', () => {
  const row = gradedRow({
    stack: 'py',
    adoptExit: 0,
    firstPr: '#5',
    drain: undefined,
    metrics: {
      cases: { passed: 5, total: 7 },
      regressions: 0,
      refusals: 0,
      failed: ['test_a', 'test_b'],
    },
  });
  assert.match(row, /\| 5\/7 \| 0 \| 0 \| none \| failed test_a test_b$/u);
});

test('reps takes a positive integer and defaults to one', () => {
  assert.equal(parseOptions([], '/r', '/s').reps, 1);
  assert.equal(parseOptions(['--reps', '3'], '/r', '/s').reps, 3);
  assert.throws(() => parseOptions(['--reps', '0'], '/r', '/s'), /--reps/u);
});

test('a lane branch left by an earlier run of the same row is owned and removed, any other branch is kept', () => {
  const subject: Record<string, string> = {
    't-a': 'chore: orphan base for py-fs-sweep',
    't-b': 'feat: a real lane of the product',
    't-c': 'chore: orphan base for py-other',
  };
  assert.deepEqual(
    ownedLaneBranches(
      ['t-a', 't-b', 't-c', 't-d'],
      ['main', 't-a', 't-b', 't-c'],
      (id) => subject[id],
      'py-fs-sweep',
    ),
    ['t-a'],
  );
});

test('a discriminating row body names every identifier its hidden cases assert', () => {
  const rows = parseTaskFile(
    readFileSync(
      new URL(
        '../../scripts/outside-hidden/discriminating-tasks.json',
        import.meta.url,
      ),
      'utf8',
    ),
  );
  const body = (stack: string) =>
    rows.find((row) => row.stack === stack)?.body.join(' ') ?? '';
  assert.match(body('py-mistune-image-depth'), /max_image_depth.*default 20/u);
  assert.match(
    body('py-fs-sweep'),
    /SyntaxError instead of the documented ValueError/u,
  );
});

test('the seed task is written into a row clone that has no tasks directory', () => {
  const dir = mkdtempSync(join(tmpdir(), 'krn-seed-'));
  const seed = seedTask('npm', 'npm test', '2026-01-01');
  writeSeedTask(dir, seed);
  assert.equal(readFileSync(join(dir, seed.file), 'utf8'), seed.text);
  writeSeedTask(dir, seed);
});

test('the visibility lookup asks for an App token scoped to the row repository, not the current directory repository', () => {
  const seen: Array<string | undefined> = [];
  const exec = (
    _command: string,
    _args: string[],
    _cwd: string,
    env?: NodeJS.ProcessEnv,
  ) => {
    seen.push(env?.KRN_APP_REPOSITORY);
    return {
      status: 0,
      output:
        env?.KRN_APP_REPOSITORY === 'krn-works/outside-php' ? 'private\n' : '',
    };
  };
  assert.equal(
    remoteVisibility('/krn-root', 'krn-works/outside-php', exec),
    'private',
  );
  assert.deepEqual(seen, ['krn-works/outside-php']);
});

test('the seed push of a private row uses the host login and every lane push or public remote keeps the App token', () => {
  const repo = 'krn-works/outside-php';
  const host = rowCredentialArgs(repo, 'private', true);
  assert.deepEqual(host, hostCredentialArgs());
  assert.ok(host.some((a) => a.endsWith('=!/usr/bin/gh auth git-credential')));
  assert.ok(host.every((a) => !a.includes('github-app-token')));
  for (const args of [
    rowCredentialArgs(repo, 'private', false),
    rowCredentialArgs(repo, 'public', true),
    rowCredentialArgs(repo, undefined, true),
  ]) {
    assert.ok(args.some((a) => a.includes('github-app-token')));
    assert.ok(args.every((a) => !a.includes('gh auth')));
  }
});

test('a row adopts into a scratch registry inside its scratch directory', () => {
  assert.deepEqual(scratchRegistryEnv('/scratch/rows'), {
    KRN_ADOPTED_REGISTRY: '/scratch/rows/registry.json',
  });
});

test('clause 1: a row checkout that is not a git repository is skipped and reported, not fatal', () => {
  const root = realpathSync(join(import.meta.dirname, '..', '..'));
  const plain = mkdtempSync(join(tmpdir(), 'krn-harvest-plain-'));
  // Verbatim shape of the 1115i crash: a row directory that exists without a checkout.
  const missing = join(plain, 'runs', 'py-1794752669827');
  const lines = harvestRows([plain, missing], root);
  assert.match(lines.join('\n'), /skipped: .*is not a git repository/u);
  assert.match(lines.join('\n'), /skipped: .*is not a directory/u);
  assert.match(
    lines.at(-2) ?? '',
    /^harvest: 0 candidates from 0 proposals in 0 repositories/u,
  );
  assert.equal(lines.at(-1), 'promoted: none');
});

test('clause 6: a row that threw names the repository its --repo choice gave, not the default', () => {
  const row = failedRow(
    'py',
    { py: 'krn-works/outside-py' },
    new Error(
      'outside-acceptance: py: tests/test_unzip_http.py not in the fix',
    ),
  );
  assert.ok(row.startsWith('krn-works/outside-py outside/py | py | 1 |'));
  assert.ok(failedRow('py', undefined, 'x').startsWith('krn-works/krn '));
});

test('clause 7: sweeping a finished invocation leaves the rows of another invocation sharing the scratch directory', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'krn-sweep-'));
  const mine = join(scratch, 'runs', 'py-1');
  const theirs = join(scratch, 'runs', 'py-upstream-2');
  mkdirSync(join(mine, '.krn', 'worktrees', 'a'), { recursive: true });
  mkdirSync(join(theirs, '.krn', 'worktrees', 'b'), { recursive: true });
  sweepOwnedRows([mine, join(scratch, 'runs', 'never-created')]);
  assert.equal(existsSync(mine), false);
  assert.equal(existsSync(join(theirs, '.krn', 'worktrees', 'b')), true);
});

test('clause 6 and 12: the Rust and Go rows name MIT-licensed upstream fixes whose hidden test files are the receiver of the drain', () => {
  const rows = parseTaskFile(shippedRows);
  const rust = rows.find((row) => row.stack === 'rust');
  const go = rows.find((row) => row.stack === 'go');
  assert.ok(rust && go, 'a rust row and a go row are shipped');
  assert.match(rust.license, /MIT/u);
  assert.match(go.license, /MIT/u);
  assert.match(rust.hiddenVerify, /^cargo test /u);
  assert.match(go.hiddenVerify, /^go test /u);
  assert.deepEqual(rust.hidden, ['tests/test_downcast.rs']);
  assert.deepEqual(go.hidden, ['bytes_test.go', 'bigbytes_test.go']);
  assert.equal(rust.test, 'cargo test');
  assert.equal(go.test, 'go test ./...');
});

test('clause 7: a Go row finds the newest installed Go toolchain, and none when mise holds no Go', () => {
  const present = new Set(['/m/installs/go/1.27.3/bin/go']);
  const dirs = ['1.26.0', '1.27.3', '1.27.2', 'latest', '1'];
  assert.equal(
    goToolchainBin(
      '/m/installs',
      (path) => present.has(path),
      () => dirs,
    ),
    '/m/installs/go/1.27.3/bin',
  );
  assert.equal(
    goToolchainBin(
      '/m/installs',
      () => false,
      () => dirs,
    ),
    undefined,
  );
  assert.equal(
    goToolchainBin('/m/installs', existsSync, () => {
      throw new Error('ENOENT');
    }),
    undefined,
  );
});

// The drain line of outside php row 1115k (php.log), its worktree path neutralised.
test('a failed drain row names the lane BLOCKER without the drain suffix', () => {
  const output = [
    't-04ewf93 t-04ewf93 exit=73 43s',
    'lane t-04ewf93: BLOCKER: the Stop hook reports no test file changed on this branch, but `tests/run.php` differs from `outside/php` in `9eee856`. It also requires a test that is red at the base, which a characterizati (worktree /work/runs/php-1/.krn/worktrees/t-04ewf93, rerun reuses it, claim released) model sonnet cost $0.22 turns 9 packet f40688c89cf3',
  ].join('\n');
  assert.equal(
    drainBlocker(output),
    'blocker: the Stop hook reports no test file changed on this branch, but `tests/run.php` differs from `outside/php` in `9eee856`. It also requires a test that is red at the base, which a characterizati',
  );
  assert.equal(drainBlocker('t-a t-a exit=0 1s\n'), undefined);
});

// Rows 1115k3: wp-plugin's test command read an unset ${KRN_OUTSIDE_SCRATCH:?}
// (exit 127, red baseline 72) and the go lane ran `mise use`, leaving an
// untracked .tool-versions (dirty tree 74).
test('a row exports its scratch root and the chosen Go version', () => {
  assert.deepEqual(scratchRowEnv('/work/scratch', '/work/mise/go/1.25.4/bin'), {
    KRN_OUTSIDE_SCRATCH: '/work/scratch',
    MISE_GO_VERSION: '1.25.4',
  });
  assert.deepEqual(scratchRowEnv('/work/scratch', undefined), {
    KRN_OUTSIDE_SCRATCH: '/work/scratch',
  });
});

test('a failed orphan-base push puts the git stderr, redacted and on one line, in the row note', () => {
  const stderr =
    'remote: error: GH013: Repository rule violations found\nTo https://x-access-token:ghs_abc123@github.com/krn-works/krn.git\n ! [remote rejected] outside/rust -> outside/rust (push declined)\n';
  const note = pushFailureNote(stderr);
  assert.match(note, /push of the orphan base failed: remote: error: GH013/u);
  assert.match(note, /push declined/u);
  assert.doesNotMatch(note, /ghs_|abc123|\n|\|/u);
  assert.equal(pushFailureNote(''), 'push of the orphan base failed');
  const row = failedRow('rust', undefined, new Error(note));
  assert.match(row, /push declined/u);
});
