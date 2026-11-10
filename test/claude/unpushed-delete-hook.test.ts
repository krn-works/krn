import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(
  new URL('../../scripts/claude/unpushed-delete.ts', import.meta.url),
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
  spawnSync(process.execPath, [script], {
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

test('settings run the unpushed delete hook before every Bash call', async () => {
  const text = await readFile(settings, 'utf8');
  assert.match(text, /scripts\/claude\/bash-guards\.ts/u);
});
