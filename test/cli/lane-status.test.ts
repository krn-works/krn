import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

delete process.env.KRN_SESSION_CLASS;
// KRN-12: real git repositories, the real `krn lane start`, `krn pr ship --detach` and
// `krn lane status`; only gh is replaced by a script that answers like gh or blocks.
const cli = fileURLToPath(new URL('../../src/cli/main.ts', import.meta.url));

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function fixture() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'krn-status-')));
  const origin = join(base, 'origin.git');
  const repo = join(base, 'repo');
  git(base, 'init', '-q', '--bare', '-b', 'main', origin);
  git(base, 'clone', '-q', origin, repo);
  git(repo, 'config', 'user.name', 'lane test');
  git(repo, 'config', 'user.email', 'lane@example.invalid');
  git(repo, 'checkout', '-q', '-b', 'main');
  writeFileSync(join(repo, '.gitignore'), '.krn/\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-qm', 'seed');
  git(repo, 'push', '-q', 'origin', 'main');
  const bin = join(base, 'bin');
  mkdirSync(bin);
  return { base, bin, repo };
}

function lane(repo: string, slug: string, commit: boolean): string {
  const started = spawnSync(process.execPath, [cli, 'lane', 'start', slug], {
    cwd: repo,
    encoding: 'utf8',
  });
  assert.equal(started.status, 0, started.stderr);
  const worktree = join(repo, '.krn', 'worktrees', slug);
  if (commit) {
    writeFileSync(join(worktree, 'out.txt'), slug);
    git(worktree, 'add', 'out.txt');
    git(worktree, 'commit', '-qm', `feat(lane): ${slug} (t-abc1234)`);
  }
  return worktree;
}

/** A gh that runs `script` (a shell fragment) for every call. */
function gh(bin: string, script: string): NodeJS.ProcessEnv {
  const file = join(bin, 'gh');
  writeFileSync(file, `#!/bin/sh\n${script}\n`);
  chmodSync(file, 0o755);
  return { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH}` };
}

function status(repo: string, env: NodeJS.ProcessEnv): string {
  const out = spawnSync(process.execPath, [cli, 'lane', 'status'], {
    cwd: repo,
    env,
    encoding: 'utf8',
  });
  assert.equal(out.status, 0, out.stderr);
  return out.stdout;
}

function detach(repo: string, worktree: string, env: NodeJS.ProcessEnv) {
  const body = join(repo, '..', 'body.md');
  writeFileSync(body, 'Outcome: x\n');
  return spawnSync(
    process.execPath,
    [
      cli,
      'pr',
      'ship',
      '--detach',
      '--worktree',
      worktree,
      '--title',
      'feat(lane): detached ship (t-abc1234)',
      '--body-file',
      body,
    ],
    { cwd: repo, env, encoding: 'utf8' },
  );
}

const pidFile = (worktree: string) => join(worktree, '.krn', 'tmp', 'ship.pid');
const waitFor = async (done: () => boolean) => {
  for (let i = 0; i < 100 && !done(); i += 1)
    await new Promise((r) => setTimeout(r, 100));
  assert.ok(done(), 'condition not reached in 10 s');
};

test('a committed lane with no pull request and no live ship is orphaned, one with a pull request is not', () => {
  const { repo, bin } = fixture();
  lane(repo, 'lost', true);
  lane(repo, 'idle', false);
  lane(repo, 'open', true);
  const env = gh(
    bin,
    `case "$*" in *"--head open"*) echo '[{"number":9,"state":"OPEN"}]';; *"--head lost"*) echo '[]';; *) echo '[]';; esac`,
  );
  const lines = status(repo, env).trim().split('\n');
  assert.ok(
    lines.includes('idle empty no commit past the base'),
    lines.join('\n'),
  );
  assert.match(
    lines.find((l) => l.startsWith('lost ')) ?? '',
    /^lost orphaned 1 commit/u,
  );
  assert.equal(
    lines.find((l) => l.startsWith('open ')),
    'open pr-open #9 open',
  );
});

test('a lane whose pull request merged is merged', () => {
  const { repo, bin } = fixture();
  lane(repo, 'done', true);
  const env = gh(bin, `echo '[{"number":4,"state":"MERGED"}]'`);
  assert.equal(status(repo, env).trim(), 'done merged #4');
});

test('a ship started with --detach outlives the process that started it and shows live, then orphaned once it dies', async () => {
  const { repo, bin } = fixture();
  const worktree = lane(repo, 'stalled', true);
  const env = gh(bin, '[ -n "$FAKE_GH_BLOCK" ] && exec sleep 300; echo "[]"');
  const started = detach(repo, worktree, { ...env, FAKE_GH_BLOCK: '1' });
  assert.equal(started.status, 0, started.stderr);
  const pid = Number(readFileSync(pidFile(worktree), 'utf8'));
  assert.match(started.stdout, new RegExp(`pid ${pid}`, 'u'));
  let group = 0;
  try {
    await new Promise((r) => setTimeout(r, 500));
    group = Number(
      spawnSync('ps', ['-o', 'pgid=', '-p', String(pid)], {
        encoding: 'utf8',
      }).stdout,
    );
    process.kill(pid, 0);
    assert.match(status(repo, env), /^stalled live pid \d+$/mu);
  } finally {
    process.kill(-group, 'SIGKILL');
  }
  await waitFor(() => {
    try {
      process.kill(pid, 0);
      return false;
    } catch {
      return true;
    }
  });
  assert.match(status(repo, env), /^stalled orphaned 1 commit/mu);
});

test('a detached ship that ends removes its pid file and keeps its log', async () => {
  const { repo, bin } = fixture();
  const worktree = lane(repo, 'failed', true);
  const env = gh(bin, 'echo gh-down >&2; exit 1');
  const started = detach(repo, worktree, env);
  assert.equal(started.status, 0, started.stderr);
  await waitFor(() => !existsSync(pidFile(worktree)));
  assert.ok(existsSync(join(worktree, '.krn', 'tmp', 'ship.log')));
});
