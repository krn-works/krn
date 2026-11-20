import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { addPendingTask, pendingTaskFiles } from '../../src/task/pending.ts';
import { serializeTask, type TaskRecord } from '../../src/task/record.ts';
import { locateTask, writeTaskRecord } from '../../src/task/storage.ts';
import {
  changeDependency,
  closeTask,
  editTask,
  readTask,
} from '../../src/task/store.ts';

function git(cwd: string, ...args: string[]): string {
  const out = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
  assert.equal(out.status, 0, out.stderr);
  return out.stdout.trim();
}

const mk = (id: string, title: string) =>
  serializeTask({
    id,
    status: 'open',
    resolution: null,
    created: '2026-11-10',
    priority: 2,
    title,
    after: [],
    body: ['Outcome: exit 0', 'Proof: node --test a', 'Files: src/a.ts'],
  });

/** A bare origin and a clone holding two published records. */
function fixture() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'krn-storage-')));
  const origin = join(base, 'origin.git');
  const repo = join(base, 'repo');
  git(base, 'init', '-q', '--bare', '-b', 'main', origin);
  git(base, 'clone', '-q', origin, repo);
  git(repo, 'config', 'user.name', 't');
  git(repo, 'config', 'user.email', 't@e.invalid');
  git(repo, 'checkout', '-q', '-b', 'main');
  mkdirSync(join(repo, 'tasks'));
  writeFileSync(join(repo, 'tasks', 't-dep0001.json'), mk('t-dep0001', 'Dep'));
  writeFileSync(
    join(repo, 'tasks', 't-pub0002.json'),
    mk('t-pub0002', 'Published'),
  );
  git(repo, 'add', '.');
  git(repo, 'commit', '-qm', 'seed');
  git(repo, 'push', '-q', 'origin', 'main');
  return { base, repo };
}

function withFixture(run: (repo: string) => void) {
  const { base, repo } = fixture();
  try {
    run(repo);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
}

test('a dep add after an edit of a published record keeps both changes', () => {
  withFixture((repo) => {
    editTask(repo, 't-pub0002', { title: 'Published edited' });
    changeDependency(repo, 't-pub0002', 't-dep0001', 'add');
    const read = readTask(repo, 't-pub0002');
    assert.deepEqual(read?.after, ['t-dep0001']);
    assert.equal(read?.title, 'Published edited');
    assert.equal(locateTask(repo, 't-pub0002').where, 'pending');
  });
});

test('dep add then dep rm on a pending-only record stays on the pending ref', () => {
  withFixture((repo) => {
    addPendingTask(repo, 't-pnd0003', mk('t-pnd0003', 'Pending'));
    const added = changeDependency(repo, 't-pnd0003', 't-dep0001', 'add');
    assert.deepEqual(added.after, ['t-dep0001']);
    assert.equal(existsSync(join(repo, 'tasks', 't-pnd0003.json')), false);
    assert.deepEqual(readTask(repo, 't-pnd0003')?.after, ['t-dep0001']);
    const removed = changeDependency(repo, 't-pnd0003', 't-dep0001', 'rm');
    assert.deepEqual(removed.after, []);
    assert.equal(existsSync(join(repo, 'tasks', 't-pnd0003.json')), false);
    assert.equal(pendingTaskFiles(repo).has('t-pnd0003'), true);
  });
});

test('close and edit of a pending-only record rewrite it on the ref', () => {
  withFixture((repo) => {
    addPendingTask(repo, 't-pnd0003', mk('t-pnd0003', 'Pending'));
    editTask(repo, 't-pnd0003', { title: 'Renamed' });
    closeTask(repo, 't-pnd0003', { kind: 'done' });
    assert.equal(existsSync(join(repo, 'tasks', 't-pnd0003.json')), false);
    const read = readTask(repo, 't-pnd0003');
    assert.equal(read?.title, 'Renamed');
    assert.equal(read?.status, 'closed');
  });
});

test('locateTask orders pending, tree, then absent', () => {
  withFixture((repo) => {
    assert.equal(locateTask(repo, 't-dep0001').where, 'tree');
    assert.equal(locateTask(repo, 't-none004').where, 'absent');
    addPendingTask(repo, 't-pnd0003', mk('t-pnd0003', 'Pending'));
    const found = locateTask(repo, 't-pnd0003');
    assert.equal(found.where, 'pending');
    assert.equal(found.record?.title, 'Pending');
  });
});

test('writeTaskRecord refuses an archived record with exit 65', () => {
  withFixture((repo) => {
    const archive = join(repo, 'tasks', 'archive');
    mkdirSync(archive, { recursive: true });
    const closed = {
      ...JSON.parse(mk('t-arc0005', 'Old')),
      status: 'closed',
      resolution: { kind: 'done', ref: null, note: 'shipped' },
    };
    writeFileSync(
      join(archive, '2026-11.jsonl'),
      `${JSON.stringify(closed)}\n`,
    );
    const found = locateTask(repo, 't-arc0005');
    assert.equal(found.where, 'archived');
    assert.throws(
      () => writeTaskRecord(repo, found.record as TaskRecord),
      (error: { exitCode?: number }) => error.exitCode === 65,
    );
  });
});

test('writeTaskRecord on a published record in a lane worktree writes tasks/', () => {
  withFixture((repo) => {
    const lane = join(repo, '..', 'lane');
    git(repo, 'worktree', 'add', '-q', '-b', 'lane', lane);
    editTask(lane, 't-pub0002', { title: 'Lane edit' });
    assert.match(
      readFileSync(join(lane, 'tasks', 't-pub0002.json'), 'utf8'),
      /Lane edit/,
    );
    assert.equal(locateTask(lane, 't-pub0002').where, 'tree');
  });
});
