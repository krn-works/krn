import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { startLane } from '../../src/cli/lane.ts';
import { addPendingTask, pendingTaskFiles } from '../../src/task/pending.ts';
import { serializeTask, type TaskRecord } from '../../src/task/record.ts';
import { admitLanesOnAnyHost } from '../helpers/lane-host.ts';

admitLanesOnAnyHost();
delete process.env.KRN_SESSION_CLASS;

function git(cwd: string, ...args: string[]): string {
  const r = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim();
}

test('failed startLane rolls back a pending task instead of losing it from pending ref and dirtying main', async (t) => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'krn-d6-')));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const origin = join(base, 'origin.git');
  const repo = join(base, 'repo');
  git(base, 'init', '-q', '--bare', '-b', 'main', origin);
  git(base, 'clone', '-q', origin, repo);
  git(repo, 'config', 'user.email', 'a@b.c');
  git(repo, 'config', 'user.name', 'a');
  git(repo, 'checkout', '-q', '-b', 'main');
  mkdirSync(join(repo, 'tasks'));
  const blocker: TaskRecord = {
    id: 't-block01',
    status: 'open',
    resolution: null,
    created: '2026-11-10',
    priority: 2,
    title: 'Blocker',
    after: [],
    body: ['Outcome: exit 0'],
  };
  writeFileSync(join(repo, 'tasks', 't-block01.json'), serializeTask(blocker));
  writeFileSync(join(repo, '.gitignore'), '.krn/\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-qm', 'seed');
  git(repo, 'push', '-q', 'origin', 'main');

  const blocked: TaskRecord = {
    id: 't-pend001',
    status: 'open',
    resolution: null,
    created: '2026-11-20',
    priority: 2,
    title: 'Blocked pending task',
    after: ['t-block01'],
    body: ['Outcome: exit 0'],
  };
  addPendingTask(repo, 't-pend001', serializeTask(blocked));
  assert.equal(pendingTaskFiles(repo).has('t-pend001'), true);

  await assert.rejects(
    startLane(['my-lane', '--task', 't-pend001', '--root', repo]),
    /blocked by open after task t-block01/u,
  );
  assert.equal(
    pendingTaskFiles(repo).has('t-pend001'),
    true,
    'expected rollback to restore t-pend001 to refs/krn/pending-tasks',
  );
  assert.equal(
    git(repo, 'status', '--porcelain'),
    '',
    'expected main checkout to remain clean after failed startLane',
  );
});
