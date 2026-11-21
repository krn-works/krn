import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { startLane } from '../../src/cli/lane.ts';
import {
  addPendingTask,
  publishableTaskFiles,
} from '../../src/task/pending.ts';
import { serializeTask, type TaskRecord } from '../../src/task/record.ts';
import { locateTask, writeTaskRecord } from '../../src/task/storage.ts';
import { admitLanesOnAnyHost } from '../helpers/lane-host.ts';

admitLanesOnAnyHost();
delete process.env.KRN_SESSION_CLASS;

const cli = fileURLToPath(new URL('../../src/cli/main.ts', import.meta.url));

function git(cwd: string, ...args: string[]): string {
  const r = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim();
}

const record = (id: string, after: string[]): TaskRecord => ({
  id,
  status: 'open',
  resolution: null,
  created: '2026-11-21',
  priority: 2,
  title: `Task ${id}`,
  after,
  body: ['Outcome: exit 0'],
});

function fixture(t: { after(fn: () => void): void }) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'krn-held-')));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const origin = join(base, 'origin.git');
  const repo = join(base, 'repo');
  git(base, 'init', '-q', '--bare', '-b', 'main', origin);
  git(base, 'clone', '-q', origin, repo);
  git(repo, 'config', 'user.email', 'a@b.c');
  git(repo, 'config', 'user.name', 'a');
  git(repo, 'checkout', '-q', '-b', 'main');
  mkdirSync(join(repo, 'tasks'));
  writeFileSync(join(repo, '.gitignore'), '.krn/\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-qm', 'seed');
  git(repo, 'push', '-q', 'origin', 'main');
  addPendingTask(repo, 't-heldaa1', serializeTask(record('t-heldaa1', [])));
  addPendingTask(
    repo,
    't-heldbb2',
    serializeTask(record('t-heldbb2', ['t-heldaa1'])),
  );
  return { base, repo };
}

function list(cwd: string) {
  return spawnSync(process.execPath, [cli, 'task', 'list'], {
    cwd,
    encoding: 'utf8',
  });
}

test('a pending record a lane carries stays visible to main readers and publish never ships it', async (t) => {
  const { repo } = fixture(t);
  await startLane(['held-lane', '--task', 't-heldaa1', '--root', repo]);

  const laneCopy = join(repo, '.krn', 'worktrees', 'held-lane', 'tasks');
  assert.ok(
    existsSync(join(laneCopy, 't-heldaa1.json')),
    'the lane carries it',
  );
  assert.equal(
    existsSync(join(repo, 'tasks', 't-heldaa1.json')),
    false,
    'the checkout holds no copy',
  );
  const listed = list(repo);
  assert.equal(listed.status, 0, listed.stderr);
  assert.match(listed.stdout, /t-heldaa1/u);
  assert.match(listed.stdout, /t-heldbb2/u);
  const located = locateTask(repo, 't-heldaa1');
  assert.equal(located.where, 'pending');
  assert.equal(located.heldBy?.branch, 'held-lane');
  assert.deepEqual([...publishableTaskFiles(repo).keys()], ['t-heldbb2']);
  assert.throws(
    () => writeTaskRecord(repo, located.record as TaskRecord),
    /carried by lane held-lane/u,
  );
});

test('the hold ends once origin base carries a changed record, and the next write drops the pending copy', async (t) => {
  const { repo } = fixture(t);
  await startLane(['held-lane', '--task', 't-heldaa1', '--root', repo]);
  const lane = join(repo, '.krn', 'worktrees', 'held-lane');
  git(lane, 'add', 'tasks/t-heldaa1.json');
  git(lane, 'commit', '-qm', 'publish record');
  git(lane, 'push', '-q', 'origin', 'held-lane:main');
  git(repo, 'fetch', '-q', 'origin');
  git(repo, 'merge', '-q', '--ff-only', 'origin/main');
  addPendingTask(repo, 't-heldcc3', serializeTask(record('t-heldcc3', [])));
  assert.equal(locateTask(repo, 't-heldaa1').where, 'tree');
  assert.equal(
    git(repo, 'ls-tree', 'refs/krn/pending-tasks', 'tasks/').includes(
      't-heldaa1',
    ),
    false,
  );
});

test('a hold whose lane branch vanished leaves a plain pending record that publish ships', async (t) => {
  const { repo } = fixture(t);
  await startLane(['held-lane', '--task', 't-heldaa1', '--root', repo]);
  git(
    repo,
    'worktree',
    'remove',
    '--force',
    join(repo, '.krn', 'worktrees', 'held-lane'),
  );
  git(repo, 'branch', '-D', 'held-lane');
  assert.equal(locateTask(repo, 't-heldaa1').heldBy, undefined);
  assert.deepEqual(
    [...publishableTaskFiles(repo).keys()],
    ['t-heldaa1', 't-heldbb2'],
  );
});

test('a rejected pending-ref write fails the start without leaving a lane, and a retry succeeds', async (t) => {
  const { repo } = fixture(t);
  const lock = join(repo, '.git', 'refs', 'krn', 'pending-tasks.lock');
  writeFileSync(lock, '');
  await assert.rejects(
    startLane(['held-lane', '--task', 't-heldaa1', '--root', repo]),
  );
  assert.equal(git(repo, 'branch', '--list', 'held-lane'), '');
  assert.equal(existsSync(join(repo, '.krn', 'worktrees', 'held-lane')), false);
  assert.equal(git(repo, 'status', '--porcelain'), '');
  rmSync(lock);
  await startLane(['held-lane', '--task', 't-heldaa1', '--root', repo]);
  assert.equal(locateTask(repo, 't-heldaa1').heldBy?.branch, 'held-lane');
});

test('a second lane for a held task does not take the hold from the first', async (t) => {
  const { repo } = fixture(t);
  await startLane(['held-lane', '--task', 't-heldaa1', '--root', repo]);
  await startLane(['second-lane', '--task', 't-heldaa1', '--root', repo]).catch(
    () => undefined,
  );
  assert.equal(locateTask(repo, 't-heldaa1').heldBy?.branch, 'held-lane');
});
