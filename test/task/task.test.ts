import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  parseTaskDocument,
  serializeTask,
  type TaskRecord,
} from '../../src/task/record.ts';
import { checkTaskDirectory, createTask } from '../../src/task/store.ts';

const cli = fileURLToPath(new URL('../../src/cli/main.ts', import.meta.url));
const scratch = resolve(
  process.cwd(),
  '.krn/runs/claude-task-records-fix2/scratch',
);

const validTask: TaskRecord = {
  id: 'T-1',
  status: 'open',
  resolution: null,
  created: '2026-10-25',
  priority: 2,
  title: 'Valid task',
  after: [],
  body: [],
};

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
    assert.equal(result.stdout, '[]\n');
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
    const all = JSON.parse(allResult.stdout) as TaskRecord[];
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
    assert.equal((JSON.parse(openResult.stdout) as TaskRecord[]).length, 2);
    assert.equal((JSON.parse(closedResult.stdout) as TaskRecord[]).length, 1);
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

test('task check and parser identify malformed files, records, references, and cycles', async (t) => {
  const variants: Array<[string, string, string]> = [];
  variants.push(['invalid JSON', '{ nope\n', 'invalid JSON']);
  variants.push([
    'Git conflict markers',
    `<<<<<<< HEAD\n${serializeTask(validTask)}`,
    'Git conflict markers',
  ]);
  variants.push([
    'CRLF',
    serializeTask(validTask).replace(/\n/gu, '\r\n'),
    'contains CR characters',
  ]);
  variants.push([
    'missing trailing newline',
    serializeTask(validTask).trimEnd(),
    'missing trailing newline',
  ]);

  const reversed = Object.fromEntries(Object.entries(validTask).reverse());
  variants.push([
    'wrong key order',
    `${JSON.stringify(reversed, null, 2)}\n`,
    'wrong top-level key order',
  ]);

  const withExtra = { ...validTask, extra: true };
  variants.push([
    'extra key',
    `${JSON.stringify(withExtra, null, 2)}\n`,
    'extra key "extra"',
  ]);

  const { body: _body, ...withoutBody } = validTask;
  variants.push([
    'missing key',
    `${JSON.stringify(withoutBody, null, 2)}\n`,
    'missing key "body"',
  ]);

  const variantsByRecord: Array<[string, Partial<TaskRecord>, string]> = [
    ['bad status', { status: 'blocked' as TaskRecord['status'] }, 'status'],
    [
      'open with resolution',
      { resolution: { kind: 'done', ref: null, note: '' } },
      'open tasks must have a null resolution',
    ],
    [
      'closed without resolution',
      { status: 'closed' },
      'closed tasks require a resolution',
    ],
    [
      'duplicate without ref',
      {
        status: 'closed',
        resolution: { kind: 'duplicate', ref: null, note: '' },
      },
      'duplicate resolutions require a ref',
    ],
    [
      'superseded without ref',
      {
        status: 'closed',
        resolution: { kind: 'superseded', ref: null, note: '' },
      },
      'superseded resolutions require a ref',
    ],
    ['priority out of range', { priority: 4 }, 'must be between 0 and 3'],
    ['priority non-integer', { priority: 1.5 }, 'priority" must be an integer'],
    ['empty title', { title: '  ' }, 'title" must not be empty'],
    ['multi-line title', { title: 'one\ntwo' }, 'title" must be a single line'],
    ['bad created date', { created: '2026-02-30' }, 'real YYYY-MM-DD date'],
    ['invalid id', { id: 'bad_id' }, 'not a valid task id'],
  ];
  for (const [name, override, finding] of variantsByRecord) {
    const record = { ...validTask, ...override } as TaskRecord;
    variants.push([name, `${JSON.stringify(record, null, 2)}\n`, finding]);
  }
  variants.push([
    'unsorted after',
    rawTask({ after: ['T-2', 'T-1'] }),
    '"after" must be sorted',
  ]);
  variants.push([
    'duplicate after',
    rawTask({ after: ['T-1', 'T-1'] }),
    '"after" must not contain duplicates',
  ]);

  for (const [name, contents, expected] of variants) {
    await t.test(name, () => {
      const parsed = parseTaskDocument(contents);
      assert.ok(
        parsed.findings.some((finding) => finding.includes(expected)),
        parsed.findings.join('\n'),
      );
    });
  }

  const repo = await tempRepo('reference-findings-');
  try {
    await writeTask(repo, { ...validTask, id: 'T-1', after: ['T-9'] });
    await writeTask(repo, { ...validTask, id: 'T-2', after: ['T-2'] });
    await writeTask(repo, {
      ...validTask,
      id: 'T-3',
      status: 'closed',
      resolution: { kind: 'duplicate', ref: 'T-9', note: '' },
    });
    await writeTask(repo, {
      ...validTask,
      id: 'T-4',
      status: 'closed',
      resolution: { kind: 'superseded', ref: 'T-9', note: '' },
    });
    const findings = checkTaskDirectory(repo).join('\n');
    assert.match(findings, /unknown after task "T-9"/u);
    assert.match(findings, /cannot depend on itself/u);
    assert.match(findings, /unknown resolution ref "T-9"/u);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test('task check detects dependency cycles of length two and three', async () => {
  const repo = await tempRepo('cycles-');
  try {
    await writeTask(repo, { ...validTask, id: 'T-1', after: ['T-2'] });
    await writeTask(repo, { ...validTask, id: 'T-2', after: ['T-1'] });
    await writeTask(repo, { ...validTask, id: 'T-3', after: ['T-4'] });
    await writeTask(repo, { ...validTask, id: 'T-4', after: ['T-5'] });
    await writeTask(repo, { ...validTask, id: 'T-5', after: ['T-3'] });
    const findings = checkTaskDirectory(repo).filter((finding) =>
      finding.includes('dependency cycle'),
    );
    assert.equal(findings.length, 2, findings.join('\n'));
    assert.match(findings.join('\n'), /T-1 -> T-2 -> T-1/u);
    assert.match(findings.join('\n'), /T-3 -> T-4 -> T-5 -> T-3/u);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test('task check reports a UTF-8 BOM while preserving canonical byte checks', async () => {
  const repo = await tempRepo('bom-');
  try {
    const tasks = join(repo, 'tasks');
    await mkdir(tasks, { recursive: true });
    await writeFile(
      join(tasks, 'T-1.json'),
      Buffer.concat([
        Buffer.from([0xef, 0xbb, 0xbf]),
        Buffer.from(serializeTask(validTask)),
      ]),
    );
    const findings = checkTaskDirectory(repo).join('\n');
    assert.match(findings, /file starts with a byte order mark/u);
    assert.match(findings, /file does not use canonical task serialization/u);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test('task check finds cycles through records with other validation errors', async () => {
  const repo = await tempRepo('partial-cycle-');
  try {
    await writeTask(repo, { ...validTask, id: 'T-1' });
    const partial = {
      ...validTask,
      id: 'T-1',
      after: ['T-2'],
    };
    const { body: _body, ...partialWithoutBody } = partial;
    await writeFile(
      join(repo, 'tasks', 'A-alias.json'),
      `${JSON.stringify(partialWithoutBody, null, 2)}\n`,
    );
    await writeTask(repo, { ...validTask, id: 'T-2', after: ['T-1'] });
    const findings = checkTaskDirectory(repo).join('\n');
    assert.match(findings, /missing key "body"/u);
    assert.match(findings, /filename does not match id "T-1"/u);
    assert.match(findings, /dependency cycle T-1 -> T-2 -> T-1/u);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test('task check handles a 20,000 task dependency chain iteratively', async () => {
  const repo = await tempRepo('long-chain-');
  try {
    const tasks = join(repo, 'tasks');
    await mkdir(tasks, { recursive: true });
    for (let index = 0; index < 20_000; index += 1) {
      const id = `T-${String(index).padStart(5, '0')}`;
      const after =
        index === 19_999 ? [] : [`T-${String(index + 1).padStart(5, '0')}`];
      await writeFile(
        join(tasks, `${id}.json`),
        serializeTask({ ...validTask, id, after }),
      );
    }
    const result = runCli(repo, ['check']);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, 'Task data is valid.\n');
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

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

function rawTask(overrides: Partial<TaskRecord>): string {
  return `${JSON.stringify({ ...validTask, ...overrides }, null, 2)}\n`;
}

async function tempRepo(prefix: string): Promise<string> {
  const directory = await tempDirectory(prefix);
  await initRepo(directory);
  return directory;
}

async function tempDirectory(prefix: string): Promise<string> {
  await mkdir(scratch, { recursive: true });
  return mkdtemp(join(scratch, prefix));
}

async function initRepo(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true });
  git(directory, 'init', '--quiet', '--initial-branch=main');
  git(directory, 'config', 'user.name', 'KRN task test');
  git(directory, 'config', 'user.email', 'krn-task-test@example.invalid');
  await writeFile(join(directory, 'README.md'), 'Task fixture\n');
  git(directory, 'add', 'README.md');
  git(directory, 'commit', '-qm', 'initialize task fixture');
}

async function writeTask(root: string, record: TaskRecord): Promise<void> {
  const directory = join(root, 'tasks');
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, `${record.id}.json`), serializeTask(record));
}

function runCli(
  cwd: string,
  args: string[],
  legacy?: string,
  input?: string,
  childEnvironment: NodeJS.ProcessEnv = {},
): { status: number | null; stdout: string; stderr: string } {
  const environment = {
    ...cleanGitEnvironment(),
    KRN_HOOK_NOGIT_TMPDIR: process.env.KRN_HOOK_NOGIT_TMPDIR ?? scratch,
    ...(legacy === undefined ? {} : { KRN_LEGACY_ENTRY: legacy }),
    ...childEnvironment,
  };
  const result = spawnSync(process.execPath, [cli, 'task', ...args], {
    cwd,
    encoding: 'utf8',
    env: environment,
    input,
    timeout: 10_000,
  });
  return {
    status: result.status,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  };
}

function runCliAsync(
  cwd: string,
  args: string[],
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  const environment = {
    ...cleanGitEnvironment(),
    KRN_HOOK_NOGIT_TMPDIR: process.env.KRN_HOOK_NOGIT_TMPDIR ?? scratch,
  };
  return new Promise((resolveResult) => {
    const child = spawn(process.execPath, [cli, 'task', ...args], {
      cwd,
      env: environment,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.on('close', (status) => {
      resolveResult({ status, stdout, stderr });
    });
  });
}

function git(root: string, ...args: string[]): string {
  const result = spawnSync('git', ['-C', root, ...args], {
    encoding: 'utf8',
    env: cleanGitEnvironment(),
    timeout: 10_000,
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function cleanGitEnvironment(): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')),
  );
}

function idSequence(...ids: string[]): () => string {
  let index = 0;
  return () => ids[index++] ?? ids.at(-1) ?? 't-1234567';
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function dirname(path: string): string {
  const lastSlash = path.lastIndexOf('/');
  return lastSlash < 0 ? '.' : path.slice(0, lastSlash);
}
