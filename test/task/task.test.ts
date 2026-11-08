import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import {
  parseTaskDocument,
  serializeTask,
  type TaskRecord,
} from '../../src/task/record.ts';
import { checkTaskDirectory } from '../../src/task/store.ts';
import {
  cleanGitEnvironment,
  compareStrings,
  git,
  initRepo,
  runCli,
  tempDirectory,
  tempRepo,
  useScratch,
  validTask,
  writeTask,
} from './task-fixture.ts';

useScratch();

test('task data follows the repository clone and task commands are Product-owned', async () => {
  const directory = await tempDirectory('clone-travels-');
  try {
    const repo = join(directory, 'repo');
    await initRepo(repo);
    const legacy = join(directory, 'legacy.mjs');
    await writeFile(
      legacy,
      "process.stderr.write('legacy called\\n'); process.exitCode = 99;\n",
    );

    const first = runCli(repo, ['create', '--title', 'First task'], legacy);
    assert.equal(first.status, 0, first.stderr);
    const firstId = first.stdout.trim();
    assert.match(firstId, /^t-[0-9abcdefghjkmnpqrstvwxyz]{7}$/u);

    const second = runCli(
      repo,
      ['create', '--title', 'Second task', '--after', firstId],
      legacy,
    );
    assert.equal(second.status, 0, second.stderr);
    const secondId = second.stdout.trim();

    const third = runCli(repo, ['create', '--title', 'Third task'], legacy);
    assert.equal(third.status, 0, third.stderr);
    const thirdId = third.stdout.trim();

    const closed = runCli(repo, ['close', secondId, '--as', 'done'], legacy);
    assert.equal(closed.status, 0, closed.stderr);

    git(repo, 'add', 'tasks');
    git(repo, 'commit', '-qm', 'save repository task records');
    const clone = join(directory, 'clone');
    const cloned = spawnSync('git', ['clone', '--quiet', repo, clone], {
      encoding: 'utf8',
      env: cleanGitEnvironment(),
    });
    assert.equal(cloned.status, 0, cloned.stderr);

    const originalList = runCli(
      repo,
      ['list', '--status', 'all', '--json'],
      legacy,
    );
    const cloneList = runCli(
      clone,
      ['list', '--status', 'all', '--json'],
      legacy,
    );
    assert.equal(originalList.status, 0, originalList.stderr);
    assert.equal(cloneList.status, 0, cloneList.stderr);
    assert.equal(cloneList.stdout, originalList.stdout);
    for (const id of [firstId, secondId, thirdId]) {
      const originalShow = runCli(repo, ['show', id, '--json'], legacy);
      const cloneShow = runCli(clone, ['show', id, '--json'], legacy);
      assert.equal(originalShow.status, 0, originalShow.stderr);
      assert.equal(cloneShow.status, 0, cloneShow.stderr);
      assert.equal(cloneShow.stdout, originalShow.stdout);
    }
    assert.equal(cloneList.stderr, '');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('task list returns empty when the repository has no tasks directory', async () => {
  const repo = await tempRepo('missing-tasks-');
  try {
    const result = runCli(repo, ['list', '--json']);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), {
      ok: true,
      tasks: [],
    });
    assert.deepEqual(checkTaskDirectory(repo), []);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test('task list filters statuses and orders by priority, created date, then id', async () => {
  const repo = await tempRepo('list-order-');
  try {
    const lowFirst = runCli(repo, [
      'create',
      '--title',
      'Low priority one',
      '--priority',
      '0',
    ]);
    const high = runCli(repo, [
      'create',
      '--title',
      'High priority',
      '--priority',
      '2',
    ]);
    const lowSecond = runCli(repo, [
      'create',
      '--title',
      'Low priority two',
      '--priority',
      '0',
    ]);
    assert.equal(lowFirst.status, 0, lowFirst.stderr);
    assert.equal(high.status, 0, high.stderr);
    assert.equal(lowSecond.status, 0, lowSecond.stderr);
    const closedId = lowFirst.stdout.trim();
    const closeResult = runCli(repo, ['close', closedId, '--as', 'dropped']);
    assert.equal(closeResult.status, 0, closeResult.stderr);

    const allResult = runCli(repo, ['list', '--status', 'all', '--json']);
    assert.equal(allResult.status, 0, allResult.stderr);
    const all = JSON.parse(allResult.stdout).tasks as TaskRecord[];
    assert.deepEqual(
      all.map((record) => record.id),
      [...all]
        .sort(
          (left, right) =>
            left.priority - right.priority ||
            compareStrings(left.created, right.created) ||
            compareStrings(left.id, right.id),
        )
        .map((record) => record.id),
    );
    assert.equal(all[0]?.priority, 0);
    assert.equal(all.at(-1)?.priority, 2);

    const openResult = runCli(repo, ['list', '--status', 'open', '--json']);
    const closedResult = runCli(repo, ['list', '--status', 'closed', '--json']);
    assert.equal(openResult.status, 0, openResult.stderr);
    assert.equal(closedResult.status, 0, closedResult.stderr);
    assert.equal(
      (JSON.parse(openResult.stdout).tasks as TaskRecord[]).length,
      2,
    );
    assert.equal(
      (JSON.parse(closedResult.stdout).tasks as TaskRecord[]).length,
      1,
    );
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test('task check reports every finding in the directory', async () => {
  const repo = await tempRepo('all-findings-');
  try {
    const tasks = join(repo, 'tasks');
    await mkdir(tasks, { recursive: true });
    await writeFile(join(tasks, 'README.txt'), 'unexpected\n');
    await writeFile(join(tasks, 'broken.json'), '{ not JSON\n');
    await writeFile(
      join(tasks, 'T-1.json'),
      serializeTask(validTask).replace('\n', '\r\n'),
    );
    const result = runCli(repo, ['check']);
    assert.equal(result.status, 65);
    assert.match(result.stderr, /tasks\/README\.txt: non-JSON file/u);
    assert.match(result.stderr, /tasks\/broken\.json: invalid JSON/u);
    assert.match(result.stderr, /tasks\/T-1\.json: contains CR characters/u);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test('task check detects extended Git conflict markers', () => {
  for (const marker of [
    '<<<<<<<< HEAD',
    '||||||| base',
    '=======',
    '>>>>>>> theirs',
  ]) {
    const parsed = parseTaskDocument(`${marker}\n${serializeTask(validTask)}`);
    assert.ok(
      parsed.findings.includes('contains Git conflict markers'),
      `${marker}: ${parsed.findings.join('\n')}`,
    );
  }
  const malformedMarker = parseTaskDocument(
    `<<<<<<<suffix\n${serializeTask(validTask)}`,
  );
  assert.ok(
    !malformedMarker.findings.includes('contains Git conflict markers'),
  );
});

test('task check checks filenames and references in partial records', async () => {
  const repo = await tempRepo('partial-records-');
  try {
    const tasks = join(repo, 'tasks');
    await mkdir(tasks, { recursive: true });

    const partial = {
      ...validTask,
      id: 'T_1',
      status: 'closed',
      resolution: { kind: 'duplicate', ref: 'T-10', note: '' },
      after: ['T-9'],
    };
    const { body: _body, ...withoutBody } = partial;
    await writeFile(
      join(tasks, 'wrong-name.json'),
      `${JSON.stringify(withoutBody, null, 2)}\n`,
    );

    const partialTarget = { ...validTask, id: 'T-8' };
    const { body: _targetBody, ...targetWithoutBody } = partialTarget;
    await writeFile(
      join(tasks, 'T-8.json'),
      `${JSON.stringify(targetWithoutBody, null, 2)}\n`,
    );
    await writeTask(repo, { ...validTask, id: 'T-2', after: ['T-8'] });
    await writeTask(repo, {
      ...validTask,
      id: 'T-3',
      status: 'closed',
      resolution: { kind: 'duplicate', ref: 'T-8', note: '' },
    });

    const findings = checkTaskDirectory(repo).join('\n');
    assert.match(findings, /missing key "body"/u);
    assert.match(findings, /filename does not match id "T_1"/u);
    assert.match(findings, /unknown after task "T-9"/u);
    assert.match(findings, /unknown resolution ref "T-10"/u);
    assert.doesNotMatch(
      findings,
      /unknown (?:after task|resolution ref) "T-8"/u,
    );

    const list = runCli(repo, ['list', '--json']);
    const show = runCli(repo, ['show', 'T-8', '--json']);
    assert.equal(list.status, 65, list.stderr);
    assert.equal(show.status, 65, show.stderr);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});
