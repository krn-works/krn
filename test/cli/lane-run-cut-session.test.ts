import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  reapCutSession,
  recordSessionGroup,
  sessionGroupFile,
} from '../../src/cli/lane-run/cut-session.ts';

const killGroup = (pid: number): void => {
  try {
    if (pid > 1) process.kill(-pid, 'SIGKILL');
  } catch {
    /* gone */
  }
};

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** A detached process (its own group) whose cwd is the worktree, as a cut session's worker is. */
function orphan(worktree: string) {
  const child = spawn('sleep', ['60'], {
    cwd: worktree,
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
  assert.ok(child.pid);
  return child.pid;
}

function scratch() {
  const main = realpathSync(mkdtempSync(join(tmpdir(), 'cut-session-')));
  const worktree = join(main, '.krn', 'worktrees', 'lane-x');
  mkdirSync(worktree, { recursive: true });
  return { main, worktree };
}

test('a resumed lane kills the cut session group working in its worktree before reuse', async () => {
  const { main, worktree } = scratch();
  const pid = orphan(worktree);
  recordSessionGroup(sessionGroupFile(main, 'lane-x'), pid);
  try {
    const killed = await reapCutSession(main, 'lane-x', worktree);
    assert.deepEqual(killed, [pid]);
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(alive(pid) && !existsSync(`/proc/${pid}/exe`), false);
    assert.equal(existsSync(sessionGroupFile(main, 'lane-x')), false);
  } finally {
    killGroup(pid);
  }
});

test('a recorded group with no process in the worktree is left alone', async () => {
  const { main, worktree } = scratch();
  const elsewhere = realpathSync(mkdtempSync(join(tmpdir(), 'cut-other-')));
  const pid = orphan(elsewhere);
  recordSessionGroup(sessionGroupFile(main, 'lane-x'), pid);
  try {
    assert.deepEqual(await reapCutSession(main, 'lane-x', worktree), []);
    assert.equal(alive(pid), true);
  } finally {
    killGroup(pid);
  }
});

test('a lane that recorded no group needs no reaping', async () => {
  const { main, worktree } = scratch();
  assert.deepEqual(await reapCutSession(main, 'lane-x', worktree), []);
});

test('a running session records its process group and a finished one forgets it', async () => {
  const { driveSession } = await import('../../evals/replay/session.ts');
  const { main, worktree } = scratch();
  const file = sessionGroupFile(main, 'lane-x');
  const done = driveSession({
    command: 'sh',
    argv: ['-c', `cat ${file}; echo`],
    cwd: worktree,
    env: process.env,
    timeoutMs: 10_000,
    claude: 'sh',
    groupFile: file,
  });
  const session = await done;
  assert.match(session.stdout, /^\d+\n/u);
  assert.equal(existsSync(file), false);
});
