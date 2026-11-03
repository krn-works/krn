import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createTask } from '../../src/task/store.ts';

const cli = fileURLToPath(new URL('../../src/cli/main.ts', import.meta.url));
function fixture(t: { after(fn: () => void): void }) {
  const root = mkdtempSync(join(tmpdir(), 'krn-lane-records-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const main = join(root, 'main');
  const lane = join(root, 'lane');
  mkdirSync(main);
  function git(cwd: string, ...args: string[]) {
    const r = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout.trim();
  }
  git(main, 'init', '-q', '-b', 'main');
  git(main, 'config', 'user.name', 'Fixture');
  git(main, 'config', 'user.email', 'fixture@example.invalid');
  writeFileSync(join(main, '.gitignore'), '.krn/\n');
  createTask(main, { title: 'Subject' }, { makeId: () => 'T-1' });
  createTask(main, { title: 'Dependency' }, { makeId: () => 'T-2' });
  git(main, 'add', '.');
  git(main, 'commit', '-qm', 'fixture');
  git(main, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
  git(main, 'worktree', 'add', '-qb', 'lane', lane);
  function run(cwd: string, ...args: string[]) {
    return spawnSync(process.execPath, [cli, 'task', ...args], {
      cwd,
      encoding: 'utf8',
    });
  }
  function ok(cwd: string, ...args: string[]) {
    const r = run(cwd, ...args);
    assert.equal(r.status, 0, r.stderr);
    return r.stdout.trim();
  }
  const bytes = (cwd: string) =>
    readFileSync(join(cwd, 'tasks/T-1.json'), 'utf8');
  const clean = () => assert.equal(git(main, 'status', '--porcelain'), '');
  return { root, main, lane, git, run, ok, bytes, clean };
}

test('create --worktree writes only in lane and keeps main clean', (t) => {
  const f = fixture(t);
  const id = f.ok(
    f.main,
    'create',
    '--title',
    'Lane task',
    '--worktree',
    f.lane,
  );
  assert.ok(existsSync(join(f.lane, 'tasks', `${id}.json`)));
  assert.equal(existsSync(join(f.main, 'tasks', `${id}.json`)), false);
  f.clean();
});

for (const invalid of ['unregistered', 'missing', 'repeated', 'file']) {
  test(`create --worktree rejects ${invalid} with 64 and writes nothing`, (t) => {
    const f = fixture(t);
    const path = join(f.root, invalid);
    if (invalid === 'unregistered') mkdirSync(path);
    if (invalid === 'file') writeFileSync(path, 'file');
    const args =
      invalid === 'repeated' ? [f.lane, '--worktree', f.lane] : [path];
    const r = f.run(
      f.main,
      'create',
      '--title',
      'Invalid',
      '--worktree',
      ...args,
    );
    assert.equal(r.status, 64, r.stderr);
    assert.deepEqual(readdirSync(join(f.main, 'tasks')).sort(), [
      'T-1.json',
      'T-2.json',
    ]);
    assert.deepEqual(readdirSync(join(f.lane, 'tasks')).sort(), [
      'T-1.json',
      'T-2.json',
    ]);
    assert.equal(existsSync(join(path, 'tasks')), false);
    f.clean();
  });
}

test('uniqueness rejects a main-only forced id from another linked worktree', async (t) => {
  const f = fixture(t);
  const claims = await import('../../src/task/claims.ts');
  assert.equal(typeof claims.mainCheckoutRoot, 'function');
  const main = claims.mainCheckoutRoot(f.lane);
  assert.equal(main, f.main);
  createTask(f.main, { title: 'Main only' }, { makeId: () => 'T-3' });
  const other = join(f.root, 'other');
  f.git(f.main, 'worktree', 'add', '-qb', 'other', other);
  assert.equal(claims.mainCheckoutRoot(other), f.main);
  let attempt = 0;
  const task = createTask(
    other,
    { title: 'Unique' },
    {
      uniquenessRoots: [claims.mainCheckoutRoot(f.lane)],
      makeId: () => (++attempt === 1 ? 'T-3' : 'T-4'),
    },
  );
  assert.equal(task.id, 'T-4');
  assert.equal(existsSync(join(other, 'tasks/T-3.json')), false);
});

for (const [verb, args] of [
  ['close', ['--as', 'done']],
  ['edit', ['--title', 'Changed']],
  ['dep', ['--after', 'T-2']],
  ['dep-rm', ['--after', 'T-2']],
] as const) {
  test(`${verb} follows live lane claim from main without a second write`, (t) => {
    const f = fixture(t);
    if (verb === 'dep-rm') {
      f.ok(f.main, 'close', 'T-2', '--as', 'done');
      f.ok(f.main, 'dep', 'add', 'T-1', '--after', 'T-2');
      f.git(f.main, 'add', '.');
      f.git(f.main, 'commit', '-qm', 'dependency');
      f.git(f.lane, 'merge', '--ff-only', 'main');
    }
    const before = f.bytes(f.main);
    f.ok(f.main, 'claim', 'T-1', '--actor', 'worker', '--worktree', f.lane);
    if (verb === 'dep' || verb === 'dep-rm')
      f.ok(f.main, 'dep', verb === 'dep' ? 'add' : 'rm', 'T-1', ...args);
    else f.ok(f.main, verb, 'T-1', ...args);
    assert.equal(f.bytes(f.main), before);
    assert.notEqual(f.bytes(f.lane), before);
    const record = JSON.parse(f.bytes(f.lane));
    if (verb === 'close') assert.equal(record.status, 'closed');
    if (verb === 'edit') assert.equal(record.title, 'Changed');
    if (verb.startsWith('dep'))
      assert.deepEqual(record.after, verb === 'dep' ? ['T-2'] : []);
    f.clean();
  });
}

for (const state of ['absent', 'expired', 'malformed']) {
  test(`mutation with ${state} claim falls back to cwd`, (t) => {
    const f = fixture(t);
    if (state === 'expired') {
      f.ok(f.main, 'claim', 'T-1', '--actor', 'worker', '--worktree', f.lane);
      f.git(f.main, 'worktree', 'remove', f.lane);
    }
    if (state === 'malformed') {
      mkdirSync(join(f.main, '.krn/task-claims'), { recursive: true });
      writeFileSync(join(f.main, '.krn/task-claims/T-1.json'), '{bad');
    }
    f.ok(f.main, 'edit', 'T-1', '--title', 'Fallback');
    assert.equal(JSON.parse(f.bytes(f.main)).title, 'Fallback');
    if (state !== 'expired')
      assert.equal(JSON.parse(f.bytes(f.lane)).title, 'Subject');
  });
}

test('mutation inside lane with its live claim stays in lane', (t) => {
  const f = fixture(t);
  f.ok(f.main, 'claim', 'T-1', '--actor', 'worker', '--worktree', f.lane);
  f.ok(f.lane, 'edit', 'T-1', '--title', 'Inside lane');
  assert.equal(JSON.parse(f.bytes(f.lane)).title, 'Inside lane');
  assert.equal(JSON.parse(f.bytes(f.main)).title, 'Subject');
  f.clean();
});
