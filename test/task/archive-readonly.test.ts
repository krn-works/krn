import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import type { TaskRecord } from '../../src/task/record.ts';
import {
  git,
  runCli,
  tempRepo,
  useScratch,
  validTask,
  writeTask,
} from './task-fixture.ts';

useScratch();

const old: TaskRecord = {
  ...validTask,
  id: 't-old',
  status: 'closed',
  resolution: { kind: 'done', ref: null, note: 'shipped' },
  created: '2026-01-05',
};

test('read-only task verbs leave tasks/ untouched and only an explicit archive moves closed tasks', async () => {
  const repo = await tempRepo('archive-readonly-');
  await writeTask(repo, old);
  git(repo, 'add', 'tasks');
  git(repo, 'commit', '-qm', 'add tasks');
  const verbs = [
    ['--help'],
    ['list'],
    ['list', '--json'],
    ['show', 't-old'],
    ['check'],
    ['ready'],
  ];
  for (const verb of verbs) {
    runCli(repo, verb);
    assert.equal(
      git(repo, 'status', '--porcelain', 'tasks').trim(),
      '',
      `krn task ${verb.join(' ')} changed tasks/`,
    );
  }
  assert.ok(existsSync(join(repo, 'tasks', 't-old.json')));
  assert.equal(runCli(repo, ['archive']).status, 0);
  assert.ok(!existsSync(join(repo, 'tasks', 't-old.json')));
});
