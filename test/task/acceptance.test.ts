import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { parseTaskDocument, serializeTask } from '../../src/task/record.ts';
import { closeTask, createTask } from '../../src/task/store.ts';
import { runCli, tempRepo, useScratch, validTask } from './task-fixture.ts';

useScratch();

function stored(repo: string, id: string) {
  const parsed = parseTaskDocument(
    readFileSync(join(repo, 'tasks', `${id}.json`), 'utf8'),
  );
  assert.deepEqual(parsed.findings, []);
  assert.ok(parsed.record);
  return parsed.record;
}

const done = { kind: 'done', ref: null, note: '' } as const;

test('closing a task whose verify exits nonzero is refused and records the exit', async () => {
  const repo = await tempRepo('accept-fail-');
  try {
    const created = runCli(repo, [
      'create',
      '--title',
      'Needs proof',
      '--verify',
      'exit 3',
    ]);
    assert.equal(created.status, 0, created.stderr);
    const id = created.stdout.trim();
    const closed = runCli(repo, ['close', id, '--as', 'done']);
    assert.equal(closed.status, 66);
    assert.match(closed.stderr, /acceptance failed.*exit 3: exit 3/su);
    const record = stored(repo, id);
    assert.equal(record.status, 'open');
    assert.deepEqual(record.acceptance, [
      { verify: 'exit 3', passes: false, exit: 3 },
    ]);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test('a passing verify records the flag and the exit when the task closes', async () => {
  const repo = await tempRepo('accept-pass-');
  try {
    const created = runCli(repo, [
      'create',
      '--title',
      'Proven',
      '--verify',
      'true',
    ]);
    const id = created.stdout.trim();
    assert.deepEqual(stored(repo, id).acceptance, [
      { verify: 'true', passes: false, exit: null },
    ]);
    const closed = runCli(repo, ['close', id, '--as', 'done']);
    assert.equal(closed.status, 0, closed.stderr);
    const record = stored(repo, id);
    assert.equal(record.status, 'closed');
    assert.deepEqual(record.acceptance, [
      { verify: 'true', passes: true, exit: 0 },
    ]);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test('close runs verify through the injected verifier, once per entry', async () => {
  const repo = await tempRepo('accept-injected-');
  try {
    const record = createTask(repo, {
      title: 'Two checks',
      verify: ['one', 'two'],
    });
    const seen: string[] = [];
    const closed = closeTask(repo, record.id, done, (_root, command) => {
      seen.push(command);
      return 0;
    });
    assert.deepEqual(seen, ['one', 'two']);
    assert.equal(
      closed.acceptance?.every((entry) => entry.passes),
      true,
    );
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test('tasks without acceptance and non-done closures skip verification', async () => {
  const repo = await tempRepo('accept-skip-');
  try {
    const plain = runCli(repo, ['create', '--title', 'Plain']).stdout.trim();
    assert.equal(runCli(repo, ['close', plain, '--as', 'done']).status, 0);
    assert.equal(stored(repo, plain).acceptance, undefined);
    const guarded = runCli(repo, [
      'create',
      '--title',
      'Dropped',
      '--verify',
      'false',
    ]).stdout.trim();
    assert.equal(runCli(repo, ['close', guarded, '--as', 'dropped']).status, 0);
    assert.equal(stored(repo, guarded).acceptance?.[0]?.passes, false);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test('reopening resets acceptance and edit --verify adds an entry', async () => {
  const repo = await tempRepo('accept-reopen-');
  try {
    const id = runCli(repo, [
      'create',
      '--title',
      'Again',
      '--verify',
      'true',
    ]).stdout.trim();
    runCli(repo, ['close', id, '--as', 'done']);
    const reopened = runCli(repo, ['edit', id, '--reopen', '--verify', 'true']);
    assert.equal(reopened.status, 0, reopened.stderr);
    assert.deepEqual(stored(repo, id).acceptance, [
      { verify: 'true', passes: false, exit: null },
    ]);
    runCli(repo, ['edit', id, '--verify', 'echo extra']);
    assert.equal(stored(repo, id).acceptance?.length, 2);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test('records that claim done with a failing acceptance entry fail check', () => {
  const forged = {
    ...validTask,
    status: 'closed' as const,
    resolution: { kind: 'done' as const, ref: null, note: '' },
    acceptance: [{ verify: 'false', passes: false, exit: 1 }],
  };
  const findings = parseTaskDocument(serializeTask(forged)).findings;
  assert.match(findings.join('\n'), /require passing acceptance/u);
  const lying = {
    ...validTask,
    acceptance: [{ verify: 'true', passes: true, exit: null }],
  };
  assert.match(
    parseTaskDocument(serializeTask(lying)).findings.join('\n'),
    /passes only with a recorded exit 0/u,
  );
});
