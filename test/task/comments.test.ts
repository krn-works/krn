import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { beforeEach } from 'node:test';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('../../src/cli/main.ts', import.meta.url));
const gitAttributes = fileURLToPath(
  new URL('../../.gitattributes', import.meta.url),
);
let scratch: string;
beforeEach(async (t) => {
  assert.ok('after' in t, 'task fixtures require a test context');
  const owned = await mkdtemp(join(tmpdir(), 'krn-task-comments-'));
  scratch = owned;
  t.after(() => rm(owned, { recursive: true, force: true }));
});

interface CliResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: cleanEnv(),
  });
  assert.equal(result.status, 0, `git ${args.join(' ')}: ${result.stderr}`);
  return result.stdout;
}

function cleanEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of Object.keys(env))
    if (key.startsWith('GIT_')) delete env[key];
  return { ...env, KRN_HOOK_NOGIT_TMPDIR: scratch };
}

async function runCliInProcess(
  cwd: string,
  args: string[],
  stdin?: string,
): Promise<CliResult> {
  if (stdin !== undefined) return runCliSpawn(cwd, args, stdin);
  const { taskCommand } = await import('../../src/task/cli.ts');
  const originalCwd = process.cwd();
  const originalEnv = { ...process.env };
  const stdoutWrite = process.stdout.write;
  const stderrWrite = process.stderr.write;
  const originalExitCode = process.exitCode;
  let stdout = '';
  let stderr = '';
  Object.assign(process.env, cleanEnv());
  for (const key of Object.keys(process.env))
    if (key.startsWith('GIT_')) delete process.env[key];
  process.exitCode = undefined;
  process.chdir(cwd);
  process.stdout.write = ((chunk: string | Uint8Array) => {
    stdout += chunk.toString();
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string | Uint8Array) => {
    stderr += chunk.toString();
    return true;
  }) as typeof process.stderr.write;
  try {
    await taskCommand(args);
    return { status: Number(process.exitCode ?? 0), stdout, stderr };
  } finally {
    process.stdout.write = stdoutWrite;
    process.stderr.write = stderrWrite;
    process.exitCode = originalExitCode;
    process.chdir(originalCwd);
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, originalEnv);
  }
}

function runCliSpawn(cwd: string, args: string[], input?: string): CliResult {
  const result = spawnSync(process.execPath, [cli, 'task', ...args], {
    cwd,
    encoding: 'utf8',
    env: cleanEnv(),
    timeout: 10_000,
    ...(input === undefined ? {} : { input }),
  });
  return {
    status: result.status,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  };
}

async function repoWithTask(): Promise<{ repo: string; id: string }> {
  const repo = await mkdtemp(join(scratch, 'repo-'));
  git(repo, 'init', '--quiet', '--initial-branch=main');
  git(repo, 'config', 'user.name', 'Fixture Author');
  git(repo, 'config', 'user.email', 'fixture@example.invalid');
  await writeFile(join(repo, '.gitignore'), '.krn/\n');
  await writeFile(join(repo, '.gitattributes'), readFileSync(gitAttributes));
  git(repo, 'add', '.');
  git(repo, 'commit', '-qm', 'init');
  const created = await runCliInProcess(repo, [
    'create',
    '--title',
    'Commented',
  ]);
  assert.equal(created.status, 0, created.stderr);
  const id = created.stdout.trim();
  git(repo, 'add', 'tasks');
  git(repo, 'commit', '-qm', 'task');
  return { repo, id };
}

async function comment(
  repo: string,
  id: string,
  text: string,
  actor?: string,
): Promise<CliResult> {
  const file = join(
    repo,
    '..',
    `body-${Math.random().toString(36).slice(2)}.md`,
  );
  await writeFile(file, text);
  return runCliInProcess(repo, [
    'comment',
    id,
    '--body-file',
    file,
    ...(actor === undefined ? [] : ['--actor', actor]),
  ]);
}

test('comment appends a signed dated entry shown by show and valid for check', async () => {
  const { repo, id } = await repoWithTask();
  const first = await comment(repo, id, 'first\n\nmultiline decision\n');
  assert.equal(first.status, 0, first.stderr);
  const second = await comment(repo, id, 'second', 'lead');
  assert.equal(second.status, 0, second.stderr);

  const shown = await runCliInProcess(repo, ['show', id]);
  assert.match(shown.stdout, /Comments \(2\):/u);
  assert.match(
    shown.stdout,
    /Z Fixture Author: first\n {2}\n {2}multiline decision/u,
  );
  assert.match(shown.stdout, /Z lead: second/u);

  const json = JSON.parse(
    (await runCliInProcess(repo, ['show', id, '--json'])).stdout,
  );
  assert.deepEqual(
    json.comments.map((entry: { actor: string }) => entry.actor),
    ['Fixture Author', 'lead'],
  );
  assert.match(json.comments[0].at, /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/u);

  const checked = await runCliInProcess(repo, ['check']);
  assert.equal(checked.status, 0, checked.stderr);
  assert.equal((await runCliInProcess(repo, ['show', id])).status, 0);
  assert.equal(
    JSON.parse(readFileSync(join(repo, 'tasks', `${id}.json`), 'utf8')).status,
    'open',
  );
});

test('comment rejects unknown tasks, empty bodies, and corrupt comment files', async () => {
  const { repo, id } = await repoWithTask();
  const unknown = await comment(repo, 't-nope123', 'x');
  assert.equal(unknown.status, 65);
  const empty = await comment(repo, id, '  \n');
  assert.equal(empty.status, 64);

  await writeFile(join(repo, 'tasks', `${id}.comments.jsonl`), 'not json\n');
  const bad = await runCliInProcess(repo, ['check']);
  assert.equal(bad.status, 65);
  assert.match(bad.stderr, /comments\.jsonl: line 1: invalid JSON/u);

  await writeFile(
    join(repo, 'tasks', 't-orphan1.comments.jsonl'),
    '{"actor":"a","at":"2026-01-01T00:00:00.000Z","text":"x"}\n',
  );
  const orphan = await runCliInProcess(repo, ['check']);
  assert.match(orphan.stderr, /comments for unknown task "t-orphan1"/u);
});

test('real process comment via stdin, show, and check', async () => {
  const { repo, id } = await repoWithTask();
  const added = runCliSpawn(
    repo,
    ['comment', id, '--body-file', '-'],
    'from stdin\n',
  );
  assert.equal(added.status, 0, added.stderr);
  assert.match(
    added.stdout,
    new RegExp(`^${id} \\d{4}-.*Z Fixture Author\\n$`, 'u'),
  );
  assert.match(
    runCliSpawn(repo, ['show', id]).stdout,
    /Fixture Author: from stdin/u,
  );
  assert.equal(runCliSpawn(repo, ['check']).status, 0);
});

test('two branches commenting the same task merge without losing either comment', async () => {
  const { repo, id } = await repoWithTask();
  assert.equal((await comment(repo, id, 'base', 'lead')).status, 0);
  git(repo, 'add', 'tasks');
  git(repo, 'commit', '-qm', 'base comment');

  git(repo, 'switch', '-qc', 'left');
  assert.equal((await comment(repo, id, 'from left', 'left')).status, 0);
  git(repo, 'commit', '-qam', 'left comment');
  git(repo, 'switch', '-q', 'main');
  git(repo, 'switch', '-qc', 'right');
  assert.equal((await comment(repo, id, 'from right', 'right')).status, 0);
  git(repo, 'commit', '-qam', 'right comment');

  git(repo, 'merge', '--no-edit', 'left');
  const shown = JSON.parse(
    (await runCliInProcess(repo, ['show', id, '--json'])).stdout,
  );
  assert.deepEqual(
    shown.comments.map((entry: { text: string }) => entry.text).sort(),
    ['base', 'from left', 'from right'],
  );
  assert.equal((await runCliInProcess(repo, ['check'])).status, 0);
});

test('real process comment with an unreadable body file exits 64 naming the file', async () => {
  const { repo, id } = await repoWithTask();
  const failed = runCliSpawn(repo, [
    'comment',
    id,
    '--body-file',
    'missing.txt',
  ]);
  assert.equal(failed.status, 64);
  assert.match(
    failed.stderr,
    /cannot read --body-file missing\.txt \(ENOENT\)/u,
  );
  assert.equal(failed.stdout, '');
  const created = runCliSpawn(repo, [
    'create',
    '--title',
    'x',
    '--body-file',
    'missing.txt',
  ]);
  assert.equal(created.status, 64);
});
