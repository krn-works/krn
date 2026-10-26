import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { recordRepo, stateDirectory } from '../../src/foreman/state.ts';
import { reportPassingVerdict } from '../../src/foreman/verdict.ts';
import * as trace from '../../src/trace/index.ts';

async function fixture() {
  const scratch = join(process.cwd(), '.krn', 'tmp');
  await mkdir(scratch, { recursive: true });
  const root = await mkdtemp(join(scratch, 'review-readiness-'));
  const result = spawnSync('git', ['init', '-q', root], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const job = {
    id: 'local-review',
    issue: 't-example',
    worktree: root,
    repoRoot: root,
  };
  recordRepo(job, root);
  return { root, job };
}

const stop = (
  _job: unknown,
  state: 'human_decision',
  reasons: readonly string[],
) => ({ kind: 'stop' as const, state, reasons });

test('passing verdict replays preserve one local readiness event for the SHA', async () => {
  const f = await fixture();
  const sha = 'a'.repeat(40);
  try {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      assert.deepEqual(await reportPassingVerdict(f.job, sha, trace, stop), {
        kind: 'verdict_pass',
        state: 'ready_for_review',
        sha,
      });
    }
    const rows = (
      await readFile(join(stateDirectory(f.job), 'trace.jsonl'), 'utf8')
    )
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    assert.deepEqual(
      rows.map(({ kind, data }) => ({ kind, data })),
      [{ kind: 'ready_for_review', data: { sha } }],
    );
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test('aborted verdict stops before recording local readiness', async () => {
  const controller = new AbortController();
  controller.abort();
  let ready = false;
  const outcome = await reportPassingVerdict(
    { id: 'aborted', issue: 't-example', worktree: process.cwd() },
    'b'.repeat(40),
    {
      readyForReview: async () => {
        ready = true;
      },
    },
    stop,
    controller.signal,
  );
  assert.deepEqual(outcome, {
    kind: 'stop',
    state: 'human_decision',
    reasons: ['stopped'],
  });
  assert.equal(ready, false);
});
