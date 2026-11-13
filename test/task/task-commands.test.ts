import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import {
  parseTaskDocument,
  serializeTask,
  type TaskRecord,
} from '../../src/task/record.ts';
import { checkTaskDirectory, createTask } from '../../src/task/store.ts';
import {
  dirname,
  git,
  idSequence,
  runCli,
  runCliAsync,
  tempDirectory,
  tempRepo,
  useScratch,
  validTask,
  writeTask,
} from './task-fixture.ts';

useScratch();

test('concurrent task creates use unique ids and leave no check findings', async () => {
  const repo = await tempRepo('concurrent-create-');
  try {
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        runCliAsync(repo, ['create', '--title', `Concurrent ${index}`]),
      ),
    );
    for (const result of results) assert.equal(result.status, 0, result.stderr);
    const ids = results.map((result) => result.stdout.trim());
    assert.equal(new Set(ids).size, 20);
    assert.ok(existsSync(join(repo, '.krn', 'tmp', 'task-write')));
    const check = runCli(repo, ['check']);
    assert.equal(check.status, 0, check.stderr);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test('task create and claim run whatever the run directory holds', async () => {
  const repo = await tempRepo('large-runs-');
  try {
    const results = join(repo, '.krn', 'runs', 'eval', 'results');
    await mkdir(results, { recursive: true });
    await Promise.all(
      Array.from({ length: 5000 }, (_, index) =>
        writeFile(join(results, `${index}.meas`), ''),
      ),
    );
    const created = runCli(repo, ['create', '--title', 'Large run state']);
    assert.equal(created.status, 0, created.stderr);
    const claim = runCli(repo, [
      'claim',
      created.stdout.trim(),
      '--actor',
      'lead',
    ]);
    assert.equal(claim.status, 0, claim.stderr);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test('task filenames and resolution refs are checked against their records', async () => {
  const repo = await tempRepo('filename-ref-');
  try {
    const tasks = join(repo, 'tasks');
    await mkdir(tasks, { recursive: true });
    await writeFile(join(tasks, 'wrong-name.json'), serializeTask(validTask));
    const findings = checkTaskDirectory(repo).join('\n');
    assert.match(findings, /filename does not match id "T-1"/u);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test('canonical task fixtures round-trip byte for byte', () => {
  const fixtures: TaskRecord[] = [
    validTask,
    {
      ...validTask,
      id: 'LON-123',
      priority: 0,
      title: 'Imported task',
      body: ['first paragraph', 'second paragraph'],
    },
    {
      ...validTask,
      id: 'T-2',
      status: 'closed',
      resolution: { kind: 'done', ref: null, note: 'shipped' },
    },
    {
      ...validTask,
      id: 'T-3',
      status: 'closed',
      resolution: { kind: 'dropped', ref: null, note: 'not needed' },
    },
    {
      ...validTask,
      id: 'T-4',
      status: 'closed',
      resolution: { kind: 'duplicate', ref: 'T-1', note: '' },
    },
    {
      ...validTask,
      id: 'T-5',
      status: 'closed',
      resolution: { kind: 'superseded', ref: 'T-1', note: '' },
    },
  ];
  for (const fixture of fixtures) {
    const bytes = serializeTask(fixture);
    const parsed = parseTaskDocument(bytes);
    assert.deepEqual(parsed.findings, []);
    assert.ok(parsed.record);
    assert.equal(serializeTask(parsed.record), bytes);
  }
});

test('task create checks working tree and origin/main id collisions', async () => {
  const worktreeRepo = await tempRepo('worktree-collision-');
  try {
    const collisionId = 't-abc1234';
    await writeTask(worktreeRepo, { ...validTask, id: collisionId });
    const created = createTask(
      worktreeRepo,
      { title: 'created after local collision' },
      { makeId: idSequence(collisionId, 't-def5678') },
    );
    assert.equal(created.id, 't-def5678');
  } finally {
    await rm(worktreeRepo, { recursive: true, force: true });
  }

  const remoteRepo = await tempRepo('origin-collision-');
  try {
    const collisionId = 't-abc1234';
    await writeTask(remoteRepo, { ...validTask, id: collisionId });
    git(remoteRepo, 'add', 'tasks');
    git(remoteRepo, 'commit', '-qm', 'add origin task');
    const originCommit = git(remoteRepo, 'rev-parse', 'HEAD');
    git(remoteRepo, 'update-ref', 'refs/remotes/origin/main', originCommit);
    const baseCommit = git(remoteRepo, 'rev-parse', 'HEAD^');
    git(remoteRepo, 'switch', '--quiet', '-c', 'feature', baseCommit);

    const created = createTask(
      remoteRepo,
      { title: 'created after origin collision' },
      { makeId: idSequence(collisionId, 't-fed5678') },
    );
    assert.equal(created.id, 't-fed5678');
  } finally {
    await rm(remoteRepo, { recursive: true, force: true });
  }
});

test('task create checks id collisions against the contract base, not main', async () => {
  const repo = await tempRepo('origin-contract-base-');
  try {
    const collisionId = 't-abc1234';
    await writeFile(
      join(repo, 'krn.json'),
      '{"base":"trunk","test":"true","tracker":"krn"}\n',
    );
    await writeTask(repo, { ...validTask, id: collisionId });
    git(repo, 'add', 'tasks', 'krn.json');
    git(repo, 'commit', '-qm', 'add trunk task');
    git(repo, 'update-ref', 'refs/remotes/origin/trunk', 'HEAD');
    git(repo, 'switch', '--quiet', '-c', 'feature', 'HEAD^');
    await writeFile(
      join(repo, 'krn.json'),
      '{"base":"trunk","test":"true","tracker":"krn"}\n',
    );
    const created = createTask(
      repo,
      { title: 'created after trunk collision' },
      { makeId: idSequence(collisionId, 't-fed5678') },
    );
    assert.equal(created.id, 't-fed5678');
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test('task close refuses a second close and dep add refuses a cycle', async () => {
  const repo = await tempRepo('mutation-refusals-');
  try {
    const first = runCli(repo, ['create', '--title', 'First']);
    const second = runCli(repo, ['create', '--title', 'Second']);
    assert.equal(first.status, 0, first.stderr);
    assert.equal(second.status, 0, second.stderr);
    const firstId = first.stdout.trim();
    const secondId = second.stdout.trim();
    const edge = runCli(repo, ['dep', 'add', firstId, '--after', secondId]);
    assert.equal(edge.status, 0, edge.stderr);
    const cycle = runCli(repo, ['dep', 'add', secondId, '--after', firstId]);
    assert.equal(cycle.status, 65);
    assert.match(cycle.stderr, /would create a cycle/u);

    const closed = runCli(repo, ['close', firstId, '--as', 'done']);
    assert.equal(closed.status, 0, closed.stderr);
    const closedAgain = runCli(repo, ['close', firstId, '--as', 'done']);
    assert.equal(closedAgain.status, 65);
    assert.match(closedAgain.stderr, /already closed/u);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test('task commands resolve the current repository from subdirectories and linked worktrees', async () => {
  const repo = await tempRepo('root-resolution-');
  try {
    const subdirectory = join(repo, 'nested', 'directory');
    await mkdir(subdirectory, { recursive: true });
    const fromSubdirectory = runCli(subdirectory, [
      'create',
      '--title',
      'From subdirectory',
    ]);
    assert.equal(fromSubdirectory.status, 0, fromSubdirectory.stderr);
    assert.ok(
      existsSync(join(repo, 'tasks', `${fromSubdirectory.stdout.trim()}.json`)),
    );
    assert.equal(existsSync(join(subdirectory, 'tasks')), false);

    const linked = join(dirname(repo), 'linked-worktree');
    git(
      repo,
      'worktree',
      'add',
      '--quiet',
      '-b',
      'task-records-linked',
      linked,
      'HEAD',
    );
    const fromLinked = runCli(linked, [
      'create',
      '--title',
      'From linked worktree',
    ]);
    assert.equal(fromLinked.status, 0, fromLinked.stderr);
    assert.ok(
      existsSync(join(linked, 'tasks', `${fromLinked.stdout.trim()}.json`)),
    );
    assert.equal(
      existsSync(join(repo, 'tasks', `${fromLinked.stdout.trim()}.json`)),
      false,
    );
    git(repo, 'worktree', 'remove', '--force', linked);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test('task commands outside a Git repository use exit code 64', async () => {
  const directory = await tempDirectory('outside-git-');
  try {
    const result = runCli(directory, ['list'], undefined, undefined, {
      GIT_CEILING_DIRECTORIES: dirname(directory),
    });
    assert.equal(result.status, 64, JSON.stringify(result));
    assert.match(result.stderr, /inside a git repository/u);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('task create reads body paragraphs from a file and stdin', async () => {
  const repo = await tempRepo('body-file-');
  try {
    const bodyFile = join(repo, 'body.txt');
    await writeFile(bodyFile, 'First paragraph\n\nSecond paragraph\n');
    const fromFile = runCli(repo, [
      'create',
      '--title',
      'Body from file',
      '--body-file',
      bodyFile,
    ]);
    assert.equal(fromFile.status, 0, fromFile.stderr);
    const fileRecord = JSON.parse(
      readFileSync(
        join(repo, 'tasks', `${fromFile.stdout.trim()}.json`),
        'utf8',
      ),
    ) as TaskRecord;
    assert.deepEqual(fileRecord.body, ['First paragraph', 'Second paragraph']);

    const fromStdin = runCli(
      repo,
      ['create', '--title', 'Body from stdin', '--body-file', '-'],
      undefined,
      'Input paragraph\n',
    );
    assert.equal(fromStdin.status, 0, fromStdin.stderr);
    const stdinRecord = JSON.parse(
      readFileSync(
        join(repo, 'tasks', `${fromStdin.stdout.trim()}.json`),
        'utf8',
      ),
    ) as TaskRecord;
    assert.deepEqual(stdinRecord.body, ['Input paragraph']);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});
