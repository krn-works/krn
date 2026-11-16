import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  commitPendingRecords,
  PENDING_REF,
  pendingTaskFiles,
  removePendingTasks,
  takePendingTask,
} from '../../src/task/pending.ts';
import { createTask } from '../../src/task/store.ts';
import { QUALITY_PARAGRAPHS, withCategories } from './task-fixture.ts';

const cli = fileURLToPath(new URL('../../src/cli/main.ts', import.meta.url));

function fixture(t: { after(fn: () => void): void }, withOrigin = true) {
  const root = mkdtempSync(join(tmpdir(), 'krn-pending-records-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const main = join(root, 'main');
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
  createTask(
    main,
    { title: 'Existing', body: QUALITY_PARAGRAPHS },
    { makeId: () => 't-exist01' },
  );
  git(main, 'add', '.');
  git(main, 'commit', '-qm', 'fixture');
  if (withOrigin) git(main, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
  function create(cwd: string, title: string): string {
    const r = spawnSync(
      process.execPath,
      [cli, 'task', ...withCategories(['create', '--title', title])],
      { cwd, encoding: 'utf8' },
    );
    assert.equal(r.status, 0, r.stderr);
    return r.stdout.trim();
  }
  function task(cwd: string, ...args: string[]) {
    return spawnSync(process.execPath, [cli, 'task', ...args], {
      cwd,
      encoding: 'utf8',
    });
  }
  return { root, main, git, create, task };
}

test('two records created in the main checkout wait on the pending ref and the checkout stays clean', (t) => {
  const f = fixture(t);
  const first = f.create(f.main, 'First pending');
  const second = f.create(f.main, 'Second pending');
  assert.equal(f.git(f.main, 'status', '--porcelain'), '');
  const listed = f
    .git(f.main, 'ls-tree', '--name-only', `${PENDING_REF}^{tree}`, 'tasks/')
    .split('\n');
  assert.deepEqual(
    listed,
    [`tasks/${first}.json`, `tasks/${second}.json`].sort(),
  );
  // The lead reads what it just created from the main checkout.
  const shown = f.task(f.main, 'show', first, '--json');
  assert.equal(shown.status, 0, shown.stderr);
  assert.equal(JSON.parse(shown.stdout).task.title, 'First pending');
  const list = f.task(f.main, 'list', '--json');
  assert.equal(list.status, 0, list.stderr);
  const ids = JSON.parse(list.stdout).tasks.map((x: { id: string }) => x.id);
  assert.ok(ids.includes(first) && ids.includes(second));
});

test('publish commits every pending record as one commit cut from the base', (t) => {
  const f = fixture(t);
  const first = f.create(f.main, 'First pending');
  const second = f.create(f.main, 'Second pending');
  const lane = join(f.root, 'publish');
  f.git(f.main, 'worktree', 'add', '-qb', 'publish', lane, 'origin/main');
  const commit = commitPendingRecords(lane, pendingTaskFiles(f.main));
  assert.deepEqual(commit.ids, [first, second].sort());
  assert.equal(f.git(lane, 'rev-list', '--count', 'origin/main..HEAD'), '1');
  const files = f
    .git(lane, 'show', '--name-only', '--format=', 'HEAD')
    .split('\n')
    .sort();
  assert.deepEqual(
    files,
    [`tasks/${first}.json`, `tasks/${second}.json`].sort(),
  );
  assert.match(f.git(lane, 'log', '-1', '--format=%B'), /^Refs: t-/mu);
  assert.match(
    commit.title,
    /^chore\(tasks\): 2 task records \(t-[a-z0-9]+\)$/u,
  );
  // Once the base carries them they are no longer pending, and publish clears the ref.
  f.git(
    f.main,
    'update-ref',
    'refs/remotes/origin/main',
    f.git(lane, 'rev-parse', 'HEAD'),
  );
  assert.equal(pendingTaskFiles(f.main).size, 0);
  removePendingTasks(f.main, commit.ids);
  const ref = spawnSync('git', [
    '-C',
    f.main,
    'rev-parse',
    '--verify',
    '--quiet',
    PENDING_REF,
  ]);
  assert.notEqual(ref.status, 0);
});

test('a lane start takes its pending record into the checkout and off the ref', (t) => {
  const f = fixture(t);
  const id = f.create(f.main, 'Lane-bound');
  const other = f.create(f.main, 'Stays pending');
  assert.equal(takePendingTask(f.main, id), true);
  assert.ok(existsSync(join(f.main, 'tasks', `${id}.json`)));
  assert.match(
    readFileSync(join(f.main, 'tasks', `${id}.json`), 'utf8'),
    /Lane-bound/u,
  );
  assert.deepEqual([...pendingTaskFiles(f.main).keys()], [other]);
  assert.equal(takePendingTask(f.main, id), false);
});

test('without an origin base the record is written in place as before', (t) => {
  const f = fixture(t, false);
  const id = f.create(f.main, 'No origin');
  assert.ok(existsSync(join(f.main, 'tasks', `${id}.json`)));
  assert.equal(pendingTaskFiles(f.main).size, 0);
});

test('a linked worktree neither sees nor writes pending records', (t) => {
  const f = fixture(t);
  const pending = f.create(f.main, 'Main only');
  const lane = join(f.root, 'lane');
  f.git(f.main, 'worktree', 'add', '-qb', 'lane', lane, 'origin/main');
  assert.equal(f.task(lane, 'show', pending).status, 65);
  const id = f.create(lane, 'In the lane');
  assert.ok(existsSync(join(lane, 'tasks', `${id}.json`)));
});
