import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  kindOfTitle,
  proofCommands,
  proofOfTitle,
  proofShell,
  renderPrBody,
} from '../../src/cli/pr-body.ts';
import type { TaskRecord } from '../../src/task/record.ts';

const cli = fileURLToPath(new URL('../../src/cli/main.ts', import.meta.url));

const task: TaskRecord = {
  id: 't-abc1234' as TaskRecord['id'],
  status: 'open',
  resolution: null,
  created: '2026-11-09',
  priority: 3,
  title: 'Cut text',
  after: [],
  body: [
    'Outcome: generated bodies.\nWhy: hand-written text costs money.\nProof: a test.',
  ],
};

test('pr body renders template sections from the task and commits', () => {
  const text = renderPrBody({
    task,
    commits: ['feat(cli): body (t-abc1234)'],
    verified: 'npm run fast: PASS',
    agent: 'A',
    refs: false,
  });
  assert.match(text, /## Problem\n\nhand-written text costs money\./);
  assert.match(text, /- feat\(cli\): body \(t-abc1234\)/);
  assert.match(text, /## Verification\n\nnpm run fast: PASS/);
  assert.match(text, /\nTicket: t-abc1234\n\nAgent: A\n/);
  assert.match(text, /Generated with \[Claude Code\]/);
});

test('pr body uses Refs and the planned proof when nothing was verified', () => {
  const text = renderPrBody({
    task,
    commits: [],
    verified: '',
    agent: 'A',
    refs: true,
  });
  assert.match(text, /Refs: t-abc1234/);
  assert.match(text, /Planned proof: a test\./);
  assert.match(text, /- generated bodies\./);
});

test('krn pr body reads the real task record and git log', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pr-body-'));
  try {
    const git = (...a: string[]) =>
      spawnSync('git', ['-C', dir, ...a], { encoding: 'utf8' });
    git('init', '-q', '-b', 'main');
    git('config', 'user.name', 't');
    git('config', 'user.email', 't@example.invalid');
    mkdirSync(join(dir, 'tasks'));
    writeFileSync(
      join(dir, 'tasks', 't-abc1234.json'),
      `${JSON.stringify(task, null, 2)}\n`,
    );
    git('add', '.');
    git('commit', '-qm', 'seed');
    git('commit', '-q', '--allow-empty', '-m', 'feat(x): one (t-abc1234)');
    const result = spawnSync(
      process.execPath,
      [cli, 'pr', 'body', '--task', 't-abc1234', '--base', 'HEAD~1'],
      { cwd: dir, encoding: 'utf8' },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /- feat\(x\): one \(t-abc1234\)/);
    assert.match(result.stdout, /Ticket: t-abc1234/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('krn pr body --worktree finds a task created only in that worktree', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pr-body-wt-'));
  try {
    const main = join(dir, 'main');
    const lane = join(dir, 'lane');
    mkdirSync(main);
    const git = (cwd: string, ...a: string[]) =>
      spawnSync('git', ['-C', cwd, ...a], { encoding: 'utf8' });
    git(main, 'init', '-q', '-b', 'main');
    git(main, 'config', 'user.name', 't');
    git(main, 'config', 'user.email', 't@example.invalid');
    mkdirSync(join(main, 'tasks'));
    writeFileSync(
      join(main, 'tasks', 't-def5678.json'),
      `${JSON.stringify({ ...task, id: 't-def5678' }, null, 2)}\n`,
    );
    git(main, 'add', '.');
    git(main, 'commit', '-qm', 'seed');
    git(main, 'worktree', 'add', '-q', '-b', 'lane', lane);
    writeFileSync(
      join(lane, 'tasks', 't-abc1234.json'),
      `${JSON.stringify(task, null, 2)}\n`,
    );
    git(lane, 'add', '.');
    git(lane, 'commit', '-qm', 'chore(task): add (t-abc1234)');
    const run = (...extra: string[]) =>
      spawnSync(
        process.execPath,
        [cli, 'pr', 'body', '--task', 't-abc1234', '--base', 'main', ...extra],
        { cwd: main, encoding: 'utf8' },
      );
    const missing = run();
    assert.equal(missing.status, 64);
    assert.match(
      missing.stderr,
      /Unknown task t-abc1234 in .*needs --worktree <path>/,
    );
    const result = run('--worktree', lane);
    assert.equal(result.status, 0, result.stderr);
    assert.match(
      result.stdout,
      /## Problem\n\nhand-written text costs money\./,
    );
    assert.match(result.stdout, /- chore\(task\): add \(t-abc1234\)/);
    assert.match(result.stdout, /## Task\n\nTicket: t-abc1234/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('krn pr body defaults the base to the contract base branch', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pr-body-base-'));
  try {
    const git = (...a: string[]) =>
      spawnSync('git', ['-C', dir, ...a], { encoding: 'utf8' });
    git('init', '-q', '-b', 'master');
    git('config', 'user.name', 't');
    git('config', 'user.email', 't@example.invalid');
    mkdirSync(join(dir, 'tasks'));
    writeFileSync(
      join(dir, 'tasks', 't-abc1234.json'),
      `${JSON.stringify(task, null, 2)}\n`,
    );
    writeFileSync(join(dir, 'krn.json'), '{"base": "master"}\n');
    git('add', '.');
    git('commit', '-qm', 'seed');
    git('update-ref', 'refs/remotes/origin/master', 'HEAD');
    git('commit', '-q', '--allow-empty', '-m', 'feat(x): one (t-abc1234)');
    const result = spawnSync(
      process.execPath,
      [cli, 'pr', 'body', '--task', 't-abc1234'],
      { cwd: dir, encoding: 'utf8' },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /- feat\(x\): one \(t-abc1234\)/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('pr body --lane adds the lane marker line and the plain body has none', () => {
  const input = { task, commits: [], verified: 'x', agent: 'a', refs: false };
  assert.match(
    renderPrBody({ ...input, lane: true }),
    /^Lane: krn lane brief$/m,
  );
  assert.doesNotMatch(renderPrBody(input), /^Lane:/m);
});

test('pr body --lane records the advisor arm: fable when given, none otherwise', () => {
  const input = { task, commits: [], verified: 'x', agent: 'a', refs: false };
  assert.match(
    renderPrBody({ ...input, lane: true, advisor: 'fable' }),
    /^Advisor arm: fable$/m,
  );
  assert.match(renderPrBody({ ...input, lane: true }), /^Advisor arm: none$/m);
  assert.doesNotMatch(renderPrBody(input), /^Advisor arm:/m);
});

test('proofCommands keeps the runnable backtick spans of the Proof field', () => {
  const record = {
    ...task,
    body: [
      'Outcome: x.\nProof: `node --test test/ci/ship.test.ts`. Also `npm run fast` PASS, see `main` and `docs/x.md`.',
    ],
  };
  assert.deepEqual(proofCommands(record), [
    'node --test test/ci/ship.test.ts',
    'npm run fast',
  ]);
  assert.deepEqual(proofCommands(task), []);
});

test('proofCommands skips a span that names a placeholder (t-et62hcd)', () => {
  // Evidence: lane t-dz2axwx, ship exit 81: `krn adopt <clone of perfect-memory>` ran under sh.
  const record = {
    ...task,
    body: [
      'Proof: `krn adopt <clone of perfect-memory>` exits 0; `node --test a.test.ts 2>&1`.',
    ],
  };
  assert.deepEqual(proofCommands(record), ['node --test a.test.ts 2>&1']);
});

test('proofCommands runs a plan `command: verdict` span as its command and checks a numeric verdict', () => {
  // Evidence: wave-1 lanes, ship exit 81: `node --test x.test.ts: pass` ran under sh with `: pass` as a file.
  const record = {
    ...task,
    body: [
      "Proof: `node --test test/a.test.ts: pass` and `git ls-files docs/x.md | wc -l: 0` and `node evals/a.ts --arms P,PC: prints delta with CI` and `grep -c 'Ticket: t-x' f`.",
    ],
  };
  assert.deepEqual(proofCommands(record), [
    'node --test test/a.test.ts',
    '[ "$(git ls-files docs/x.md | wc -l)" = "0" ]',
    'node evals/a.ts --arms P,PC',
  ]);
});

test('a numeric verdict fails the proof when stdout differs, against real sh', () => {
  const sh = (command: string) =>
    spawnSync('sh', ['-c', command], { encoding: 'utf8' }).status;
  assert.equal(sh(proofShell('printf 0: 0')), 0);
  assert.notEqual(sh(proofShell('printf 1: 0')), 0);
  assert.equal(sh(proofShell("printf 'a: b'")), 0, 'quoted colon stays');
});

test('pr body carries the worker assumptions as a bulleted section', () => {
  const text = renderPrBody({
    task,
    commits: [],
    verified: 'v',
    agent: 'A',
    refs: false,
    assumptions: 'file named x.ts\n- flag defaults to off\n',
  });
  assert.match(
    text,
    /## Verification\n\nv\n\n## Assumptions\n\n- file named x\.ts\n- flag defaults to off\n\n## Task/,
  );
});

test('pr body has no assumptions section when none are given', () => {
  const text = renderPrBody({
    task,
    commits: [],
    verified: 'v',
    agent: 'A',
    refs: false,
  });
  assert.doesNotMatch(text, /## Assumptions/);
});

test('krn pr body --assumptions reaches the printed body', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pr-body-assume-'));
  try {
    const git = (...a: string[]) =>
      spawnSync('git', ['-C', dir, ...a], { encoding: 'utf8' });
    git('init', '-q', '-b', 'main');
    git('config', 'user.name', 't');
    git('config', 'user.email', 't@example.invalid');
    mkdirSync(join(dir, 'tasks'));
    writeFileSync(
      join(dir, 'tasks', 't-abc1234.json'),
      `${JSON.stringify(task, null, 2)}\n`,
    );
    git('add', '.');
    git('commit', '-qm', 'seed');
    git('commit', '-q', '--allow-empty', '-m', 'feat(x): one (t-abc1234)');
    const result = spawnSync(
      process.execPath,
      [
        cli,
        'pr',
        'body',
        '--task',
        't-abc1234',
        '--base',
        'HEAD~1',
        '--assumptions',
        'output order is stable',
      ],
      { cwd: dir, encoding: 'utf8' },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /## Assumptions\n\n- output order is stable\n/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('proofCommands skips a span whose arguments are a bare ellipsis', () => {
  const record = {
    ...task,
    body: [
      'Proof: a test asserts the marker is printed for a `krn ...` Proof; `node --test a.test.ts`.',
    ],
  };
  assert.deepEqual(proofCommands(record), ['node --test a.test.ts']);
});

test('krn pr body prints Refs and no Ticket when every commit carries Refs (t-5yd4nx8)', () => {
  // Evidence: PR #1249 commits carried 'Refs: t-1p7dmw9' but the body said Ticket.
  const dir = mkdtempSync(join(tmpdir(), 'pr-body-refs-'));
  try {
    const git = (...a: string[]) =>
      spawnSync('git', ['-C', dir, ...a], { encoding: 'utf8' });
    git('init', '-q', '-b', 'main');
    git('config', 'user.name', 't');
    git('config', 'user.email', 't@example.invalid');
    mkdirSync(join(dir, 'tasks'));
    writeFileSync(
      join(dir, 'tasks', 't-abc1234.json'),
      `${JSON.stringify(task, null, 2)}\n`,
    );
    git('add', '.');
    git('commit', '-qm', 'seed');
    git(
      'commit',
      '-q',
      '--allow-empty',
      '-m',
      'feat(x): one (t-abc1234)\n\nRefs: t-abc1234',
    );
    const run = () =>
      spawnSync(
        process.execPath,
        [cli, 'pr', 'body', '--task', 't-abc1234', '--base', 'HEAD~1'],
        { cwd: dir, encoding: 'utf8' },
      );
    const open = run();
    assert.equal(open.status, 0, open.stderr);
    assert.match(open.stdout, /^Refs: t-abc1234$/m);
    assert.doesNotMatch(open.stdout, /^Ticket:/m);
    git(
      'commit',
      '-q',
      '--allow-empty',
      '-m',
      'feat(x): two (t-abc1234)\n\nTicket: t-abc1234',
    );
    const closing = spawnSync(
      process.execPath,
      [cli, 'pr', 'body', '--task', 't-abc1234', '--base', 'HEAD~2'],
      { cwd: dir, encoding: 'utf8' },
    );
    assert.match(closing.stdout, /^Ticket: t-abc1234$/m);
    assert.doesNotMatch(closing.stdout, /^Refs:/m);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// A defect closed as a duplicate (t-yvgv720) carried only its record, and ship refused it for
// lacking a regression test: the gates belong to the task that delivered the work.
test('a defect closed as a duplicate asks ship for no Proof and no base-red test', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pr-body-dup-'));
  try {
    spawnSync('git', ['init', '-q', dir]);
    mkdirSync(join(dir, 'tasks'));
    writeFileSync(
      join(dir, 'tasks', 't-def5678.json'),
      `${JSON.stringify({ ...task, id: 't-def5678' }, null, 2)}\n`,
    );
    const record = (status: 'open' | 'closed', resolution: unknown) =>
      writeFileSync(
        join(dir, 'tasks', 't-abc1234.json'),
        `${JSON.stringify({ ...task, kind: 'defect', body: ['Outcome: o.\nProof: `node --test x.test.ts`: exit 0'], status, resolution }, null, 2)}\n`,
      );
    const title = 'chore(tasks): close a duplicate (t-abc1234)';
    record('open', null);
    assert.equal(kindOfTitle(dir, title), 'defect');
    assert.equal(proofOfTitle(dir, title).length, 1);
    record('closed', { kind: 'duplicate', ref: 't-def5678', note: 'shipped' });
    assert.equal(kindOfTitle(dir, title), undefined);
    assert.deepEqual(proofOfTitle(dir, title), []);
    record('closed', { kind: 'done', ref: null, note: 'fixed' });
    assert.equal(kindOfTitle(dir, title), 'defect');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
