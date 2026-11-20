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
import { pendingTaskFiles } from '../../src/task/pending.ts';
import { serializeTask, type TaskRecord } from '../../src/task/record.ts';
import { editTask, readTask } from '../../src/task/store.ts';

function git(cwd: string, ...args: string[]): string {
  const r = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim();
}

test('reopening a closed published task in main checkout is visible on pending ref and readTask', (t) => {
  const repo = realpathSync(mkdtempSync(join(tmpdir(), 'krn-d7-')));
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.email', 'a@b.c');
  git(repo, 'config', 'user.name', 'a');
  mkdirSync(join(repo, 'tasks'));
  const open: TaskRecord = {
    id: 't-reop001',
    status: 'open',
    resolution: null,
    created: '2026-11-10',
    priority: 2,
    title: 'Reopenable task',
    after: [],
    body: ['Outcome: exit 0'],
  };
  writeFileSync(join(repo, 'tasks', 't-reop001.json'), serializeTask(open));
  git(repo, 'add', '.');
  git(repo, 'commit', '-qm', 'create open task');

  const closed: TaskRecord = {
    ...open,
    status: 'closed',
    resolution: { kind: 'done', ref: null, note: 'merged PR #1' },
  };
  writeFileSync(join(repo, 'tasks', 't-reop001.json'), serializeTask(closed));
  git(repo, 'add', '.');
  git(repo, 'commit', '-qm', 'close task');
  git(repo, 'update-ref', 'refs/remotes/origin/main', 'HEAD');

  const edited = editTask(repo, 't-reop001', { reopen: true });
  assert.equal(edited.status, 'open');
  assert.equal(
    pendingTaskFiles(repo).has('t-reop001'),
    true,
    'expected reopened task to stay pending for krn task publish',
  );
  assert.equal(
    readTask(repo, 't-reop001')?.status,
    'open',
    'expected readTask to reflect the reopened status instead of silently dropping it',
  );
});
