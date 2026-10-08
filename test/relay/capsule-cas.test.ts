import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import * as relay from '../../src/relay/index.ts';
import * as trace from '../../src/trace/index.ts';

const validator =
  '/mnt/storage/coding/krn/active/krn-codex-skills/scripts/krn.mjs';

function git(root: string, args: string[]): string {
  const result = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

test('a capsule write from a stale epoch is rejected', async () => {
  const writeCapsule = Reflect.get(relay, 'writeCapsule') as
    | ((
        job: unknown,
        capsule: unknown,
        expectedEpoch: number | null,
      ) => Promise<unknown>)
    | undefined;
  if (typeof writeCapsule !== 'function')
    assert.fail('relay exposes capsule CAS writes');

  const worktree = await mkdtemp(join(tmpdir(), 'krn-relay-'));
  const job = { id: 'E1-04', issue: 'issue-1', worktree, repoRoot: worktree };
  const capsule = {
    jobId: job.id,
    issue: job.issue,
    contractRevision: 'rev-1',
    epoch: 0,
    base: 'a'.repeat(40),
    head: 'b'.repeat(40),
    branch: 'feat/s3-relay',
    worktree,
    nextAction: 'resume implementation',
    lease: 'ended' as const,
    blockers: [],
    decisions: [],
    rejectedApproaches: [],
    references: [],
  };

  try {
    git(worktree, ['init', '-q', '--initial-branch=main']);
    await writeFile(join(worktree, '.gitignore'), '.krn/\n');
    git(worktree, ['add', '.gitignore']);
    git(worktree, [
      '-c',
      'user.name=Relay Test',
      '-c',
      'user.email=relay@example.invalid',
      'commit',
      '-qm',
      'fixture',
    ]);
    assert.deepEqual(await writeCapsule(job, capsule, null), {
      applied: true,
      value: capsule,
    });
    const statePath = join(
      worktree,
      '.krn',
      'runs',
      'delivery-loop',
      job.id,
      'state.md',
    );
    const state = await readFile(statePath, 'utf8');
    assert.match(state, /^Outcome and observable acceptance:/m);
    assert.deepEqual(await relay.load(job, { revision: 'rev-1' }), capsule);
    assert.ok(
      relay.project(capsule, {
        base: capsule.base,
        head: capsule.head,
        branch: capsule.branch,
        worktree,
      }).length <= 2000,
    );
    assert.deepEqual(await writeCapsule(job, { ...capsule, epoch: 1 }, -1), {
      applied: false,
    });
  } finally {
    await rm(worktree, { recursive: true, force: true });
  }
});

test('the existing state checker accepts a capsule session id as evidence', async () => {
  assert.ok(
    existsSync(validator),
    `capsule ABI validator is available at ${validator}`,
  );
  const worktree = await mkdtemp(join(tmpdir(), 'krn-relay-validator-'));
  const job = { id: 'E1-04', issue: 'issue-1', worktree, repoRoot: worktree };
  try {
    git(worktree, ['init', '-q', '--initial-branch=main']);
    await Promise.all([
      writeFile(join(worktree, '.gitignore'), '.krn/runs/\n'),
      writeFile(join(worktree, 'README.md'), 'validator fixture\n'),
    ]);
    git(worktree, ['add', '.gitignore', 'README.md']);
    git(worktree, [
      '-c',
      'user.name=Relay Test',
      '-c',
      'user.email=relay@example.invalid',
      'commit',
      '-qm',
      'fixture',
    ]);
    const capsule = await relay.load(job, { revision: 'rev-1' });
    await trace.intent(job, capsule.epoch);
    const resumed = { ...capsule, epoch: 1, sessionId: 'session-opaque-42' };
    assert.deepEqual(await relay.writeCapsule(job, resumed, 0), {
      applied: true,
      value: resumed,
    });
    assert.deepEqual(await relay.load(job, { revision: 'rev-1' }), resumed);
    const state = await readFile(
      join(worktree, '.krn', 'runs', 'delivery-loop', job.id, 'state.md'),
      'utf8',
    );
    assert.match(state, /^Restart state: ABSENT$/m);
    assert.match(
      state,
      /^Evidence observed: session="session-opaque-42"; lease=ended$/m,
    );

    const checked = spawnSync(
      process.execPath,
      [validator, 'state', 'check', '--root', worktree, '--json'],
      {
        encoding: 'utf8',
      },
    );
    assert.equal(checked.status, 0, `${checked.stdout}\n${checked.stderr}`);
    assert.equal(JSON.parse(checked.stdout).status, 'clean');
  } finally {
    await rm(worktree, { recursive: true, force: true });
  }
});
