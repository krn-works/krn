import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  serializeTask,
  TASK_ID_MAX_LENGTH,
  type TaskRecord,
} from '../../src/task/record.ts';

const cli = fileURLToPath(new URL('../../src/cli/main.ts', import.meta.url));
const scratch =
  process.env.KRN_TASK_TEST_TMPDIR ?? join(tmpdir(), 'krn-task-ergonomics');

test('task quickstart and each verb help print usage and exit zero', async () => {
  const repo = await tempRepo('help-');
  try {
    for (const args of [[], ['help'], ['--help', '--json']]) {
      const result = runCli(repo, args);
      assert.equal(result.status, 0, result.stderr);
      assert.ok(result.stdout.trimEnd().split('\n').length <= 30);
      for (const verb of verbs)
        assert.ok(result.stdout.includes(`krn task ${verb}`), verb);
    }
    for (const verb of verbs) {
      const result = runCli(repo, [verb, '--help']);
      assert.equal(result.status, 0, `${verb}: ${result.stderr}`);
      assert.match(result.stdout, new RegExp(`krn task ${verb} `, 'u'));
    }
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test('invalid option values exit 64 and overlong ids are refused', async () => {
  const long = `T-${'a'.repeat(TASK_ID_MAX_LENGTH)}`;
  const repo = await fixtureRepo('input-', [task('T-1')]);
  try {
    for (const args of [
      ['create', '--title', 'x', '--priority', '9', '--json'],
      ['create', '--title', 'x', '--priority', '-1', '--json'],
      ['create', '--title', '', '--json'],
      ['create', '--title', 'a\nb', '--json'],
      ['edit', 'T-1', '--priority', 'one', '--json'],
      ['edit', 'T-1', '--append-body', ' ', '--json'],
      ['show', long, '--json'],
      ['claim', long, '--actor', 'lead', '--json'],
    ]) {
      const result = runCli(repo, args);
      assertError(result, 64);
    }
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
  const stored = await fixtureRepo('long-id-', [task(long)]);
  try {
    const check = runCli(stored, ['check']);
    assert.equal(check.status, 65, check.stderr);
  } finally {
    await rm(stored, { recursive: true, force: true });
  }
});

test('edit validates changes, appends paragraphs, refuses closed tasks, and reopens them', async () => {
  const repo = await fixtureRepo('edit-', [task('T-1')]);
  try {
    const bodyFile = join(repo, 'body.txt');
    await writeFile(bodyFile, 'Replacement one\n\nReplacement two\n');
    const edited = runCli(repo, [
      'edit',
      'T-1',
      '--title',
      'Updated title',
      '--priority',
      '1',
      '--body-file',
      bodyFile,
      '--append-body',
      'Last paragraph',
      '--json',
    ]);
    assert.equal(edited.status, 0, edited.stderr);
    assert.deepEqual(parseJson(edited.stdout), {
      ok: true,
      task: {
        ...task('T-1'),
        title: 'Updated title',
        priority: 1,
        body: ['Replacement one', 'Replacement two', 'Last paragraph'],
      },
    });

    const noChange = runCli(repo, ['edit', 'T-1', '--json']);
    assertError(noChange, 64);
    const invalid = runCli(repo, ['edit', 'T-1', '--priority', '4', '--json']);
    assertError(invalid, 64);
    const invalidTitle = runCli(repo, [
      'edit',
      'T-1',
      '--title',
      'Two\nlines',
      '--json',
    ]);
    assertError(invalidTitle, 64);

    const closed = runCli(repo, ['close', 'T-1', '--as', 'done', '--json']);
    assert.equal(closed.status, 0, closed.stderr);
    assert.ok('task' in successJson(closed, 'task'));
    const refused = runCli(repo, [
      'edit',
      'T-1',
      '--title',
      'No reopen',
      '--json',
    ]);
    assertError(refused, 65);
    assert.match(refused.stderr, /closed.*--reopen/u);

    const reopened = runCli(repo, [
      'edit',
      'T-1',
      '--reopen',
      '--title',
      'Reopened',
      '--json',
    ]);
    assert.equal(reopened.status, 0, reopened.stderr);
    const reopenedTask = successJson(reopened, 'task').task as TaskRecord;
    assert.equal(reopenedTask.status, 'open');
    assert.equal(reopenedTask.resolution, null);
    assert.equal(reopenedTask.title, 'Reopened');
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test('JSON mode has stable success shapes for all task verbs', async () => {
  const repo = await fixtureRepo('json-verbs-', [
    task('T-1'),
    task('T-2', { after: ['T-1'] }),
    task('T-3'),
  ]);
  try {
    const check = runCli(repo, ['check', '--json']);
    assert.equal(check.status, 0, check.stderr);
    assert.deepEqual(parseJson(check.stdout), { ok: true, findings: [] });

    const created = runCli(repo, ['create', '--title', 'Created', '--json']);
    assert.equal(created.status, 0, created.stderr);
    const newTask = successJson(created, 'task').task as TaskRecord;
    assert.equal(newTask.title, 'Created');

    const shown = runCli(repo, ['show', 'T-2', '--json']);
    assert.equal(shown.status, 0, shown.stderr);
    assert.equal((successJson(shown, 'task').task as TaskRecord).id, 'T-2');

    const listed = runCli(repo, ['list', '--status', 'all', '--json']);
    assert.equal(listed.status, 0, listed.stderr);
    assert.ok(Array.isArray(successJson(listed, 'tasks').tasks));

    const ready = runCli(repo, ['ready', '--json']);
    assert.equal(ready.status, 0, ready.stderr);
    assert.ok(Array.isArray(successJson(ready, 'tasks').tasks));

    const dependency = runCli(repo, [
      'dep',
      'add',
      'T-3',
      '--after',
      'T-1',
      '--json',
    ]);
    assert.equal(dependency.status, 0, dependency.stderr);
    assert.deepEqual(
      (successJson(dependency, 'task').task as TaskRecord).after,
      ['T-1'],
    );
    const removedDependency = runCli(repo, [
      'dep',
      'rm',
      'T-3',
      '--after',
      'T-1',
      '--json',
    ]);
    assert.ok(successJson(removedDependency, 'task').task);

    const edited = runCli(repo, [
      'edit',
      'T-3',
      '--append-body',
      'Added',
      '--json',
    ]);
    assert.ok(successJson(edited, 'task').task);

    const claimed = runCli(repo, [
      'claim',
      'T-1',
      '--actor',
      'worker',
      '--json',
    ]);
    assert.equal(
      (successJson(claimed, 'claim').claim as { id: string }).id,
      'T-1',
    );

    const released = runCli(repo, ['release', 'T-1', '--json']);
    assert.deepEqual(successJson(released, 'claim'), { ok: true, claim: null });

    const closed = runCli(repo, ['close', 'T-1', '--as', 'done', '--json']);
    const closedTask = successJson(closed, 'task').task as TaskRecord;
    assert.equal(closedTask.status, 'closed');
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test('JSON errors retain human stderr and matching exit codes', async () => {
  const repo = await fixtureRepo('json-errors-', [
    task('T-1'),
    task('T-2', { after: ['T-1'] }),
  ]);
  try {
    const usage = runCli(repo, ['edit', 'T-1', '--json']);
    assertError(usage, 64);
    const usageJson = parseJson(usage.stdout);
    assert.equal(usageJson.ok, false);
    assert.equal(usageJson.code, 64);
    assert.equal(usageJson.error, usage.stderr.trim());

    const data = runCli(repo, [
      'dep',
      'add',
      'T-1',
      '--after',
      'T-2',
      '--json',
    ]);
    assertError(data, 65);
    const dataJson = parseJson(data.stdout);
    assert.equal(dataJson.ok, false);
    assert.equal(dataJson.code, 65);
    assert.equal(dataJson.error, data.stderr.trim());
    assert.ok(Array.isArray(dataJson.findings));

    const corrupt = join(repo, 'tasks', 'broken.json');
    await writeFile(corrupt, '{ invalid JSON\n');
    const check = runCli(repo, ['check', '--json']);
    assertError(check, 65);
    assert.ok(Array.isArray(parseJson(check.stdout).findings));
    await rm(corrupt);

    const held = runCli(repo, ['claim', 'T-1', '--actor', 'worker', '--json']);
    assert.equal(held.status, 0, held.stderr);
    const contention = runCli(repo, [
      'claim',
      'T-1',
      '--actor',
      'another',
      '--json',
    ]);
    assertError(contention, 75);
    assert.equal(parseJson(contention.stdout).code, 75);

    const noneReady = runCli(repo, [
      'claim',
      '--next',
      '--actor',
      'worker',
      '--json',
    ]);
    assertError(noneReady, 75);
    assert.equal(parseJson(noneReady.stdout).code, 75);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test('text show explains blockers and dependents, while list uses one line per task', async () => {
  const repo = await fixtureRepo('text-output-', [
    task('T-1'),
    task('T-2', { after: ['T-1'] }),
    task('T-3', { after: ['T-2'] }),
  ]);
  try {
    const shown = runCli(repo, ['show', 'T-2']);
    assert.equal(shown.status, 0, shown.stderr);
    assert.equal(
      shown.stdout,
      'T-2 Task T-2\nStatus: open\nPriority: 2\nCreated: 2026-10-26\nAfter: T-1\nBlockers: T-1 (open)\nDependents: T-3\nClaim: none\n',
    );
    assert.match(shown.stdout, /Blockers: T-1 \(open\)/u);
    assert.match(shown.stdout, /Dependents: T-3/u);

    const shownJson = runCli(repo, ['show', 'T-2', '--json']);
    const summary = successJson(shownJson, 'task');
    assert.deepEqual(summary.blockers, [
      { id: 'T-1', status: 'open', resolution: null, blocking: true },
    ]);
    assert.deepEqual(summary.dependents, ['T-3']);
    assert.equal((summary.claim as { state: string }).state, 'none');

    const listed = runCli(repo, ['list', '--status', 'all']);
    assert.equal(listed.status, 0, listed.stderr);
    const lines = listed.stdout.trimEnd().split('\n');
    assert.equal(lines.length, 3);
    assert.match(
      lines[0] ?? '',
      /^T-1 {2}P2 {2}open {2}Task T-1 {2}\[after: —\]$/u,
    );
    assert.match(
      lines[1] ?? '',
      /^T-2 {2}P2 {2}open {2}Task T-2 {2}\[after: T-1\]$/u,
    );
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test('show JSON sorts dependents and marks completed dependencies nonblocking', async () => {
  const repo = await fixtureRepo('show-dependency-summary-', [
    task('T-1'),
    task('T-2', { after: ['T-1'] }),
    task('T-3', { after: ['T-2'], priority: 3 }),
    task('T-4', { after: ['T-2'], priority: 0 }),
    task('T-5', {
      status: 'closed',
      resolution: { kind: 'done', ref: null, note: '' },
    }),
    task('T-6', { after: ['T-5'] }),
  ]);
  try {
    const shown = runCli(repo, ['show', 'T-2', '--json']);
    const summary = successJson(shown, 'task');
    assert.deepEqual(summary.dependents, ['T-3', 'T-4']);

    const completedDependency = runCli(repo, ['show', 'T-6', '--json']);
    assert.deepEqual(successJson(completedDependency, 'task').blockers, [
      { id: 'T-5', status: 'closed', resolution: 'done', blocking: false },
    ]);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test('value flags consume a next argument that begins with --', async () => {
  const repo = await fixtureRepo('flag-dash-value-', [task('T-1')]);
  try {
    const closed = runCli(repo, [
      'close',
      'T-1',
      '--as',
      'done',
      '--note',
      '--x (#1) keeps dashes',
      '--json',
    ]);
    assert.deepEqual(successJson(closed, 'task').task, {
      ...task('T-1'),
      status: 'closed',
      resolution: { kind: 'done', ref: null, note: '--x (#1) keeps dashes' },
    });
    const missing = runCli(repo, ['close', 'T-1', '--as', 'done', '--note']);
    assert.equal(missing.status, 64, missing.stderr);
    assert.match(missing.stderr, /missing value for --note/u);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test('ready text lists one line per task without the body', async () => {
  const record = task('T-1', {
    created: '2026-10-25',
    body: ['Detailed task body.'],
  });
  const repo = await fixtureRepo('ready-text-', [record]);
  try {
    const ready = runCli(repo, ['ready']);
    assert.equal(ready.status, 0, ready.stderr);
    assert.equal(ready.stdout, 'T-1  P2  open  Task T-1  [after: —]\n');
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test('ready --explain reports blockers and live claim holder with exit code zero', async () => {
  const repo = await fixtureRepo('ready-explain-', [
    task('T-1'),
    task('T-2', { after: ['T-1'] }),
  ]);
  try {
    const blocked = runCli(repo, ['ready', '--explain', 'T-2']);
    assert.equal(blocked.status, 0, blocked.stderr);
    assert.match(blocked.stdout, /T-1.*open/u);

    const claim = runCli(repo, ['claim', 'T-1', '--actor', 'worker']);
    assert.equal(claim.status, 0, claim.stderr);
    const held = runCli(repo, ['ready', '--explain', 'T-1', '--json']);
    assert.equal(held.status, 0, held.stderr);
    const explanation = successJson(held, 'task');
    assert.match(JSON.stringify(explanation), /worker/u);
    assert.ok(Array.isArray(explanation.findings));
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

const verbs = [
  'create',
  'show',
  'list',
  'ready',
  'claim',
  'release',
  'close',
  'dep',
  'edit',
  'check',
];

function task(id: string, overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    id,
    status: 'open',
    resolution: null,
    created: '2026-10-26',
    priority: 2,
    title: `Task ${id}`,
    after: [],
    body: [],
    ...overrides,
  };
}

async function fixtureRepo(
  prefix: string,
  records: TaskRecord[],
): Promise<string> {
  const repo = await tempRepo(prefix);
  try {
    const tasks = join(repo, 'tasks');
    await mkdir(tasks, { recursive: true });
    for (const record of records)
      await writeFile(join(tasks, `${record.id}.json`), serializeTask(record));
    git(repo, 'add', 'tasks');
    git(repo, 'commit', '-qm', 'add task fixtures');
    git(repo, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
    return repo;
  } catch (error) {
    await rm(repo, { recursive: true, force: true });
    throw error;
  }
}

async function tempRepo(prefix: string): Promise<string> {
  await mkdir(scratch, { recursive: true });
  const repo = await mkdtemp(join(scratch, prefix));
  git(repo, 'init', '--quiet', '--initial-branch=main');
  git(repo, 'config', 'user.name', 'KRN task ergonomics test');
  git(repo, 'config', 'user.email', 'krn-task-ergonomics@example.invalid');
  await writeFile(join(repo, 'README.md'), 'Fixture\n');
  git(repo, 'add', 'README.md');
  git(repo, 'commit', '-qm', 'initialize fixture');
  return repo;
}

function runCli(repo: string, args: string[]) {
  const result = spawnSync(process.execPath, [cli, 'task', ...args], {
    cwd: repo,
    encoding: 'utf8',
    env: {
      ...cleanGitEnvironment(),
      KRN_HOOK_NOGIT_TMPDIR: process.env.KRN_HOOK_NOGIT_TMPDIR ?? scratch,
    },
    timeout: 10_000,
  });
  return {
    status: result.status,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  };
}

function git(repo: string, ...args: string[]): string {
  const result = spawnSync('git', ['-C', repo, ...args], {
    encoding: 'utf8',
    env: cleanGitEnvironment(),
    timeout: 10_000,
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function parseJson(value: string): Record<string, unknown> {
  return JSON.parse(value) as Record<string, unknown>;
}

function successJson(
  result: ReturnType<typeof runCli>,
  key: 'task' | 'tasks' | 'claim' | 'findings',
): Record<string, unknown> {
  assert.equal(result.status, 0, result.stderr);
  const value = parseJson(result.stdout);
  assert.equal(value.ok, true);
  assert.ok(key in value);
  return value;
}

function assertError(result: ReturnType<typeof runCli>, code: number): void {
  assert.equal(result.status, code, result.stderr);
  assert.notEqual(result.stderr, '');
  assert.equal(parseJson(result.stdout).ok, false);
}

function cleanGitEnvironment(): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')),
  );
}
