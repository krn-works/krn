import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { trackFailures } from '../../src/adopt/failure-tasks.ts';
import { loadTaskIndex } from '../../src/task/store.ts';

function tracked(): string {
  const root = mkdtempSync(join(tmpdir(), 'krn-failure-tasks-'));
  mkdirSync(join(root, 'tasks'));
  writeFileSync(join(root, 'krn.json'), '{"tracker":"krn"}\n');
  return root;
}

test('every tier of a failing standard becomes one task, once, so a re-adopt drains the new records', () => {
  const root = tracked();
  try {
    const failures = [
      { id: 's-a', message: 'exit 1', tier: 'floor' },
      { id: 's-b', message: 'exit 1', tier: 'reflex' },
      { id: 's-c', message: 'exit 1', tier: 'finish' },
    ] as const;
    assert.deepEqual(trackFailures(root, failures), [
      'Make standard s-a pass',
      'Make standard s-b pass',
      'Make standard s-c pass',
    ]);
    const priorities = [...loadTaskIndex(root).values()]
      .map((task) => [task.title, task.priority])
      .sort();
    assert.deepEqual(priorities, [
      ['Make standard s-a pass', 1],
      ['Make standard s-b pass', 2],
      ['Make standard s-c pass', 3],
    ]);
    assert.deepEqual(trackFailures(root, failures), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a structural failure without a tier is not a task', () => {
  const root = tracked();
  try {
    assert.deepEqual(
      trackFailures(root, [{ id: 's-x', message: 'broken file' }]),
      [],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
