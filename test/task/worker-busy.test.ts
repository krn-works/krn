import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

const api = await import('../../src/task/worker-busy.ts').catch(
  () => undefined,
);
const cli = resolve('src/cli/main.ts');
function setup(t: { after(fn: () => void): void }) {
  assert.equal(typeof api?.assertWorkerIdle, 'function');
  const dir = mkdtempSync(join(tmpdir(), 'krn-busy-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  assert.equal(spawnSync('git', ['init', '-q', dir]).status, 0);
  const run = (...args: string[]) =>
    spawnSync(process.execPath, [cli, 'task', ...args], {
      cwd: dir,
      encoding: 'utf8',
    });
  const id = run('create', '--title', 'Initial').stdout.trim();
  assert.ok(id);
  const runs = join(dir, '.krn/runs');
  mkdirSync(join(runs, 'worker'), { recursive: true });
  return { dir, run, id, runs, session: join(runs, 'worker/session.json') };
}
test('running worker refuses all tracker writes with remedy and unchanged files', (t) => {
  const f = setup(t);
  writeFileSync(f.session, '{"status":"running"}');
  const before = readdirSync(join(f.dir, 'tasks')).map((p) => [
    p,
    readFileSync(join(f.dir, 'tasks', p), 'utf8'),
  ]);
  for (const args of [
    ['create', '--title', 'Blocked'],
    ['close', f.id, '--as', 'done'],
    ['dep', 'add', f.id, '--after', 't-other'],
    ['edit', f.id, '--title', 'Blocked'],
  ]) {
    const r = f.run(...args);
    assert.equal(r.status, 75, r.stderr);
    assert.match(
      r.stderr,
      /has an open worker session .*; run krn worker stop --run /,
    );
    assert.deepEqual(
      readdirSync(join(f.dir, 'tasks')).map((p) => [
        p,
        readFileSync(join(f.dir, 'tasks', p), 'utf8'),
      ]),
      before,
    );
  }
});
test('inactive, malformed, renamed and symlinked sessions are ignored', (t) => {
  const f = setup(t);
  for (const text of [
    '{"status":"stopped"}',
    '{"status":"dead"}',
    '{',
    'null',
    '[]',
    '"running"',
  ]) {
    writeFileSync(f.session, text);
    assert.equal(
      f.run('edit', f.id, '--title', 'Allowed').status,
      0,
      text.slice(0, 30),
    );
  }
  rmSync(f.session);
  writeFileSync(
    join(f.runs, 'worker/closed-session.json'),
    '{"status":"running"}',
  );
  assert.equal(f.run('edit', f.id, '--title', 'Allowed').status, 0);
  const external = join(f.dir, 'external');
  mkdirSync(external);
  writeFileSync(join(external, 'session.json'), '{"status":"running"}');
  symlinkSync(join(external, 'session.json'), f.session);
  symlinkSync(external, join(f.runs, 'link'));
  assert.equal(f.run('edit', f.id, '--title', 'Allowed').status, 0);
  rmSync(f.runs, { recursive: true });
  symlinkSync(external, f.runs);
  assert.equal(f.run('edit', f.id, '--title', 'Allowed').status, 0);
});
test('depth and entry bounds refuse rather than silently exceed scan budget', (t) => {
  const f = setup(t);
  mkdirSync(join(f.runs, 'a/b/c'), { recursive: true });
  writeFileSync(join(f.runs, 'a/b/c/session.json'), '{"status":"running"}');
  assert.equal(f.run('edit', f.id, '--title', 'Blocked').status, 75);
  rmSync(join(f.runs, 'a'), { recursive: true });
  for (let i = 0; i < 4096; i++) writeFileSync(join(f.runs, `entry-${i}`), '');
  const r = f.run('edit', f.id, '--title', 'Blocked');
  assert.equal(r.status, 75, r.stderr);
  assert.match(r.stderr, /too many run entries/);
});

test('guard scans the resolved receiver for explicit and claim-routed writes', (t) => {
  const f = setup(t);
  const git = (...args: string[]) => {
    const r = spawnSync('git', args, { cwd: f.dir, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
  };
  git('add', 'tasks');
  git(
    '-c',
    'user.name=Test',
    '-c',
    'user.email=test@example.com',
    'commit',
    '-qm',
    'fixture',
  );
  const receiver = join(f.dir, '.krn/worktrees/receiver');
  git('worktree', 'add', '-qb', 'receiver', receiver);
  assert.equal(
    f.run('claim', f.id, '--actor', 'lead', '--worktree', receiver).status,
    0,
  );
  const session = join(receiver, '.krn/runs/worker/session.json');
  mkdirSync(join(receiver, '.krn/runs/worker'), { recursive: true });
  writeFileSync(session, '{"status":"running"}');
  const original = readFileSync(
    join(receiver, 'tasks', `${f.id}.json`),
    'utf8',
  );
  for (const args of [
    ['create', '--title', 'Blocked', '--worktree', receiver],
    ['close', f.id, '--as', 'done'],
    ['dep', 'add', f.id, '--after', 't-other'],
    ['edit', f.id, '--title', 'Blocked'],
  ]) {
    const r = f.run(...args);
    assert.equal(r.status, 75, r.stderr);
    assert.ok(
      r.stderr.includes(
        `worktree ${receiver} has an open worker session ${session}`,
      ),
    );
    assert.equal(
      readFileSync(join(receiver, 'tasks', `${f.id}.json`), 'utf8'),
      original,
    );
    assert.equal(readdirSync(join(receiver, 'tasks')).length, 1);
  }
});

test('an oversized session refuses instead of being skipped', (t) => {
  const f = setup(t);
  writeFileSync(f.session, `{"status":"running"}${' '.repeat(65537)}`);
  const result = f.run('edit', f.id, '--title', 'Blocked');
  assert.equal(result.status, 75);
  assert.match(result.stderr, /cannot read worker session/u);
});
