import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { parseTaskDocument, serializeTask } from '../../src/task/record.ts';
import {
  cli,
  runCli,
  tempRepo,
  useScratch,
  validTask,
} from './task-fixture.ts';

useScratch();

// Runs the real CLI without the fixture's default categories.
function rawCreate(cwd: string, ...args: string[]) {
  return spawnSync(process.execPath, [cli, 'task', 'create', ...args], {
    cwd,
    encoding: 'utf8',
  });
}

test('task create refuses a missing kind or area and a kind outside the list', async () => {
  const repo = await tempRepo('categories-required-');
  const noKind = rawCreate(repo, '--title', 'T', '--area', 'task');
  assert.equal(noKind.status, 64);
  assert.match(noKind.stderr, /requires --kind/u);
  const noArea = rawCreate(repo, '--title', 'T', '--kind', 'gate');
  assert.equal(noArea.status, 64);
  assert.match(noArea.stderr, /requires --area/u);
  const badKind = rawCreate(
    repo,
    '--title',
    'T',
    '--kind',
    'epic',
    '--area',
    'task',
  );
  assert.equal(badKind.status, 64);
});

test('task create stores kind, area, stack and from, and list filters by kind', async () => {
  const repo = await tempRepo('categories-store-');
  const gate = rawCreate(
    repo,
    '--title',
    'A gate',
    '--kind',
    'gate',
    '--area',
    'task',
    '--stack',
    'typescript',
    '--stack',
    'node',
    '--from',
    'finding:judge-J4',
    '--json',
  );
  assert.equal(gate.status, 0, gate.stderr);
  const id = (JSON.parse(gate.stdout) as { task: { id: string } }).task.id;
  const defect = rawCreate(
    repo,
    '--title',
    'A defect',
    '--kind',
    'defect',
    '--area',
    'cli',
  );
  assert.equal(defect.status, 0, defect.stderr);
  const parsed = parseTaskDocument(
    readFileSync(join(repo, 'tasks', `${id}.json`), 'utf8'),
  );
  assert.deepEqual(parsed.findings, []);
  assert.equal(parsed.record?.kind, 'gate');
  assert.equal(parsed.record?.area, 'task');
  assert.deepEqual(parsed.record?.stack, ['node', 'typescript']);
  assert.deepEqual(parsed.record?.from, {
    kind: 'finding',
    ref: 'judge-J4',
  });
  const listed = runCli(repo, ['list', '--kind', 'gate', '--json']);
  assert.equal(listed.status, 0, listed.stderr);
  const tasks = (JSON.parse(listed.stdout) as { tasks: { id: string }[] })
    .tasks;
  assert.deepEqual(
    tasks.map((task) => task.id),
    [id],
  );
  assert.equal(runCli(repo, ['check']).status, 0);
});

test('records without categories keep their bytes and category fields are validated', () => {
  const plain = serializeTask(validTask);
  assert.ok(!plain.includes('"kind"'));
  assert.deepEqual(parseTaskDocument(plain).findings, []);
  const full = serializeTask({
    ...validTask,
    kind: 'debt',
    area: 'brain',
    stack: ['node'],
    from: { kind: 'task', ref: 't-abc1234' },
  });
  assert.deepEqual(parseTaskDocument(full).findings, []);
  const bad = full.replace('"debt"', '"epic"');
  assert.match(parseTaskDocument(bad).findings.join('\n'), /"kind" must be/u);
  const badFrom = full.replace('"task"', '"rumor"');
  assert.match(parseTaskDocument(badFrom).findings.join('\n'), /from\.kind/u);
});
