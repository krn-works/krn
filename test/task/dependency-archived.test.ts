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
import { archiveClosedTasks } from '../../src/task/archive.ts';
import { serializeTask, type TaskRecord } from '../../src/task/record.ts';
import {
  changeDependency,
  checkTaskDirectory,
  loadTaskIndex,
} from '../../src/task/store.ts';

function git(cwd: string, ...args: string[]): string {
  const r = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim();
}

test('changeDependency refuses archived tasks instead of creating a duplicate live file', (t) => {
  const repo = realpathSync(mkdtempSync(join(tmpdir(), 'krn-d8-')));
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.email', 'a@b.c');
  git(repo, 'config', 'user.name', 'a');
  mkdirSync(join(repo, 'tasks'));
  const oldTask: TaskRecord = {
    id: 't-old0001',
    status: 'closed',
    resolution: { kind: 'done', ref: null, note: 'done long ago' },
    created: '2026-01-05',
    priority: 2,
    title: 'Archived task',
    after: [],
    body: ['Outcome: exit 0'],
  };
  const newTask: TaskRecord = {
    id: 't-new0001',
    status: 'open',
    resolution: null,
    created: '2026-11-20',
    priority: 2,
    title: 'Open task',
    after: [],
    body: ['Outcome: exit 0'],
  };
  writeFileSync(join(repo, 'tasks', 't-old0001.json'), serializeTask(oldTask));
  writeFileSync(join(repo, 'tasks', 't-new0001.json'), serializeTask(newTask));
  archiveClosedTasks(
    repo,
    loadTaskIndex(repo).values(),
    new Date('2026-11-20'),
    14,
  );
  assert.deepEqual(checkTaskDirectory(repo), []);

  assert.throws(
    () => changeDependency(repo, 't-old0001', 't-new0001', 'add'),
    /archived|closed/u,
    'expected changeDependency to refuse mutating an archived task',
  );
  assert.deepEqual(
    checkTaskDirectory(repo),
    [],
    'expected task directory to stay valid without duplicate archived/live record',
  );
});
