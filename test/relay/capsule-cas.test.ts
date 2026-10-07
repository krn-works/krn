import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import * as relay from '../../src/relay/index.ts';

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
  const job = { id: 'E1-04', issue: 'issue-1', worktree };
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
    blockers: [],
    decisions: [],
    rejectedApproaches: [],
    references: [],
  };

  try {
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
