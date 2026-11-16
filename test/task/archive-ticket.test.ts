import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { branchTicketFindings } from '../../src/task/branch-tickets.ts';
import type { TaskRecord } from '../../src/task/record.ts';
import {
  checkTaskDirectory,
  getTask,
  loadTaskIndex,
  readTask,
} from '../../src/task/store.ts';
import {
  git,
  runCli,
  tempRepo,
  useScratch,
  validTask,
  writeTask,
} from './task-fixture.ts';

useScratch();

const done = { kind: 'done', ref: null, note: 'shipped' } as const;
const old: TaskRecord = {
  ...validTask,
  id: 't-old',
  status: 'closed',
  resolution: done,
  created: '2026-01-05',
};
const fresh: TaskRecord = {
  ...old,
  id: 't-fresh',
  created: new Date().toISOString().slice(0, 10),
};
const open: TaskRecord = { ...validTask, id: 't-open', after: ['t-old'] };

async function archivedRepo(): Promise<string> {
  const repo = await tempRepo('archive-');
  for (const record of [old, fresh, open]) await writeTask(repo, record);
  git(repo, 'add', 'tasks');
  git(repo, 'commit', '-qm', 'add tasks');
  return repo;
}

test('archive moves old closed tasks to a monthly jsonl and leaves open and recent ones', async () => {
  const repo = await archivedRepo();
  try {
    const run = runCli(repo, ['archive', '--json']);
    assert.equal(run.status, 0, run.stderr);
    assert.ok(!existsSync(join(repo, 'tasks', 't-old.json')));
    assert.ok(existsSync(join(repo, 'tasks', 't-fresh.json')));
    assert.ok(existsSync(join(repo, 'tasks', 't-open.json')));
    const lines = readFileSync(
      join(repo, 'tasks', 'archive', '2026-01.jsonl'),
      'utf8',
    )
      .trimEnd()
      .split('\n');
    assert.equal(lines.length, 1);
    assert.equal(JSON.parse(lines[0] ?? '').id, 't-old');
    assert.equal(readTask(repo, 't-old')?.status, 'closed');
    assert.equal(getTask(repo, 't-old').resolution?.note, 'shipped');
    assert.deepEqual([...loadTaskIndex(repo).keys()].sort(), [
      't-fresh',
      't-old',
      't-open',
    ]);
    assert.deepEqual(checkTaskDirectory(repo), []);
    const shown = runCli(repo, ['show', 't-old']);
    assert.equal(shown.status, 0, shown.stderr);
    assert.match(shown.stdout, /^t-old /u);
    const dependent = runCli(repo, ['show', 't-old', '--json']);
    assert.deepEqual(JSON.parse(dependent.stdout).dependents, ['t-open']);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test('archiving twice writes identical bytes and the older-than flag moves recent tasks', async () => {
  const repo = await archivedRepo();
  try {
    runCli(repo, ['archive']);
    const file = join(repo, 'tasks', 'archive', '2026-01.jsonl');
    const first = readFileSync(file, 'utf8');
    assert.equal(runCli(repo, ['archive']).status, 0);
    assert.equal(readFileSync(file, 'utf8'), first);
    assert.equal(runCli(repo, ['archive', '--older-than', '0']).status, 0);
    assert.ok(!existsSync(join(repo, 'tasks', 't-fresh.json')));
    assert.equal(readTask(repo, 't-fresh')?.id, 't-fresh');
    assert.notEqual(runCli(repo, ['archive', '--older-than', 'x']).status, 0);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test('a Ticket trailer for an archived task passes the branch check', async () => {
  const repo = await archivedRepo();
  try {
    git(repo, 'switch', '--quiet', '--create', 'work');
    runCli(repo, ['archive']);
    git(repo, 'add', '-A', 'tasks');
    git(repo, 'commit', '-qm', 'archive tasks');
    git(
      repo,
      'commit',
      '--allow-empty',
      '-qm',
      'feat: work (t-old)',
      '-m',
      'Ticket: t-old',
    );
    assert.deepEqual(
      branchTicketFindings(repo, loadTaskIndex(repo), 'main', 'HEAD'),
      [],
    );
    const check = runCli(repo, ['check', '--base', 'main']);
    assert.equal(check.status, 0, check.stderr);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test('close of an archived task is refused as already closed', async () => {
  const repo = await archivedRepo();
  try {
    runCli(repo, ['archive']);
    const run = runCli(repo, ['close', 't-old', '--as', 'done']);
    assert.equal(run.status, 65);
    assert.match(run.stderr, /already closed/u);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});
