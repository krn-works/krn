import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { decide } from '../../src/hook/unpushed-delete.ts';
import { serializeTask, type TaskRecord } from '../../src/task/record.ts';
import { archiveClosedTasks } from '../../src/task/storage.ts';

const script = fileURLToPath(
  new URL('../../src/dispatch/main.ts', import.meta.url),
);
const settings = fileURLToPath(
  new URL('../../.claude/settings.json', import.meta.url),
);
const env = {
  ...process.env,
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_AUTHOR_NAME: 'Fixture',
  GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
  GIT_COMMITTER_NAME: 'Fixture',
  GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
};
const git = (cwd: string, args: string[]) => {
  const result = spawnSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    env,
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
};
const hook = (cwd: string, command: string) =>
  spawnSync(process.execPath, [script, 'pre-tool'], {
    encoding: 'utf8',
    input: JSON.stringify({
      session_id: 's',
      hook_event_name: 'PreToolUse',
      cwd,
      tool_name: 'Bash',
      tool_input: { command },
    }),
  });

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'krn-unpushed-delete-'));
  const remote = join(directory, 'remote.git');
  const repo = join(directory, 'repo');
  spawnSync('git', ['init', '--quiet', '--bare', remote], { env });
  await mkdir(join(repo, 'tasks'), { recursive: true });
  git(repo, ['init', '--quiet', '--initial-branch=main']);
  const task = (status: string, body: string[] = []) =>
    writeFile(
      join(repo, 'tasks', 't-abc1234.json'),
      JSON.stringify({ id: 't-abc1234', status, body }),
    );
  await task('open');
  git(repo, ['add', '.']);
  git(repo, ['commit', '--quiet', '-m', 'Base']);
  git(repo, ['remote', 'add', 'origin', remote]);
  git(repo, ['push', '--quiet', 'origin', 'main']);
  git(repo, [
    'worktree',
    'add',
    '--quiet',
    '-b',
    'lane',
    join(directory, 'lane'),
  ]);
  await writeFile(join(directory, 'lane', 'work.txt'), 'work\n');
  git(join(directory, 'lane'), ['add', '.']);
  git(join(directory, 'lane'), [
    'commit',
    '--quiet',
    '-m',
    'Lane work (t-abc1234)\n\nTicket: t-abc1234',
  ]);
  const tip = git(repo, ['rev-parse', 'lane']);
  return {
    repo,
    tip,
    task,
    remote,
    directory,
    lane: join(directory, 'lane'),
    cleanup: () => rm(directory, { recursive: true, force: true }),
  };
}

test('unpushed delete hook refuses deleting the only copy of an open task', async () => {
  const f = await fixture();
  try {
    for (const command of [
      'git branch -D lane',
      `git -C ${f.repo} branch --delete --force lane`,
      `git worktree remove --force ${f.lane}`,
      'git worktree remove ../lane',
    ]) {
      const result = hook(f.repo, command);
      assert.equal(result.status, 2, command);
      assert.match(result.stderr, /open task t-abc1234/u);
      assert.match(result.stderr, new RegExp(f.tip.slice(0, 12), 'u'));
    }
  } finally {
    await f.cleanup();
  }
});

test('unpushed delete hook allows recorded, closed, pushed or unforced deletes', async () => {
  const f = await fixture();
  try {
    const allowed = (command: string) => {
      const result = hook(f.repo, command);
      assert.equal(result.status, 0, `${command}: ${result.stderr}`);
      assert.equal(result.stderr, '');
    };
    allowed('git branch -d lane');
    allowed('git branch -D missing-branch');
    allowed('git status');
    await f.task('open', [`Unpushed work: ${f.tip}`]);
    allowed('git branch -D lane');
    await f.task('closed');
    allowed('git branch -D lane');
    await f.task('open');
    git(f.repo, ['push', '--quiet', 'origin', 'lane']);
    allowed('git branch -D lane');
  } finally {
    await f.cleanup();
  }
});

test('unpushed delete hook allows a squash-merged tip and a record in the claim worktree', async () => {
  const f = await fixture();
  try {
    const status = (command: string) => hook(f.repo, command).status;
    assert.equal(status('git branch -D lane'), 2);
    // The lead's `krn task edit --append-body` lands in the claiming worktree's copy.
    await mkdir(join(f.repo, '.krn', 'task-claims'), { recursive: true });
    await writeFile(
      join(f.repo, '.krn', 'task-claims', 't-abc1234.json'),
      JSON.stringify({ id: 't-abc1234', worktree: f.lane }),
    );
    await writeFile(
      join(f.lane, 'tasks', 't-abc1234.json'),
      JSON.stringify({
        id: 't-abc1234',
        status: 'open',
        body: [`Unpushed work: ${f.tip}`],
      }),
    );
    assert.equal(status('git branch -D lane'), 0);
    await rm(join(f.repo, '.krn'), { recursive: true });
    assert.equal(status(`git worktree remove --force ${f.lane}`), 2);
    // GitHub squash-merges the lane onto main: the tip stays on no remote.
    const other = join(f.directory, 'other');
    git(f.directory, ['clone', '--quiet', '--branch', 'main', f.remote, other]);
    await writeFile(join(other, 'unrelated.txt'), 'main moved\n');
    git(other, ['add', '.']);
    git(other, ['commit', '--quiet', '-m', 'Unrelated']);
    await writeFile(join(other, 'work.txt'), 'work\n');
    git(other, ['add', '.']);
    git(other, ['commit', '--quiet', '-m', 'Lane work (t-abc1234) (#1)']);
    git(other, ['push', '--quiet', 'origin', 'main']);
    git(f.repo, ['fetch', '--quiet', 'origin']);
    assert.equal(status(`git worktree remove --force ${f.lane}`), 0);
    assert.equal(status('git branch -D lane'), 0);
  } finally {
    await f.cleanup();
  }
});

test('settings run the unpushed delete hook before every Bash call', async () => {
  const text = await readFile(settings, 'utf8');
  assert.match(text, /src\/dispatch\/main\.ts\\" pre-tool/u);
});

test('the hook refuses removing a lane that holds the only copy of an open task', async () => {
  const f = await fixture();
  try {
    const lane = join(f.repo, '.krn', 'worktrees', 'only-copy');
    git(f.repo, ['worktree', 'add', '--quiet', '-b', 'only-copy', lane]);
    await mkdir(join(lane, 'tasks'), { recursive: true });
    await writeFile(
      join(lane, 'tasks', 't-def5678.json'),
      JSON.stringify({ id: 't-def5678', status: 'open', body: [] }),
    );
    await writeFile(join(lane, 'impl.ts'), 'export const x = 1;\n');
    git(lane, ['add', '.']);
    git(lane, [
      'commit',
      '--quiet',
      '-m',
      'feat(x): impl (t-def5678)\n\nTicket: t-def5678',
    ]);
    const refused = hook(f.repo, `git worktree remove --force ${lane}`);
    assert.equal(refused.status, 2, refused.stderr);
    assert.match(refused.stderr, /t-def5678/u);
  } finally {
    await f.cleanup();
  }
});

test('a lane tip with a stale open record does not override a closed archive entry', async () => {
  const f = await fixture();
  try {
    const open: TaskRecord = {
      id: 't-abc1234',
      status: 'open',
      resolution: null,
      created: '2020-01-01',
      priority: 2,
      title: 'Fixture task',
      after: [],
      body: [],
    };
    const path = join(f.repo, 'tasks', 't-abc1234.json');
    const closed: TaskRecord = {
      ...open,
      status: 'closed',
      resolution: { kind: 'done', ref: null, note: 'Completed separately' },
    };
    await writeFile(path, serializeTask(closed));
    assert.deepEqual(
      archiveClosedTasks(f.repo, [closed], new Date('2020-02-01')).archived,
      [open.id],
    );
    git(f.repo, ['add', '-A']);
    git(f.repo, ['commit', '--quiet', '-m', 'Archive closed task']);
    git(f.repo, ['push', '--quiet', 'origin', 'main']);
    assert.equal(
      decide({ cwd: f.repo, tool_input: { command: 'git branch -D lane' } }),
      undefined,
    );
  } finally {
    await f.cleanup();
  }
});

test('a branch delete in the repository --git-dir names is judged there', async () => {
  const f = await fixture();
  try {
    git(f.repo, ['switch', '-q', '-c', 'side']);
    await writeFile(
      join(f.repo, 'tasks', 't-fix1234.json'),
      JSON.stringify({ id: 't-fix1234', status: 'open', body: [] }),
    );
    git(f.repo, ['add', '.']);
    git(f.repo, ['commit', '--quiet', '-m', 'feat(x): y\n\nTicket: t-fix1234']);
    git(f.repo, ['switch', '-q', 'main']);
    const other = join(f.repo, '..', 'other.git');
    git(f.repo, ['init', '-q', '--bare', other]);
    git(f.repo, ['push', '-q', other, 'main:refs/heads/side']);
    const check = (command: string) =>
      decide({ cwd: f.repo, tool_input: { command } });
    assert.notEqual(check('git branch -D side'), undefined);
    assert.equal(check(`git --git-dir="${other}" branch -D side`), undefined);
  } finally {
    await f.cleanup();
  }
});
