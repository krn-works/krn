import assert from 'node:assert/strict';
import test from 'node:test';
import { branchMisses } from '../../src/task/branch-evidence.ts';
import {
  git,
  runCli,
  tempRepo,
  useScratch,
  validTask,
  writeTask,
} from './task-fixture.ts';

useScratch();

test('evidence check lists open-task branches missing locally and on origin', async () => {
  const repo = await tempRepo('branch-evidence-');
  git(repo, 'branch', 'feat/kept');
  git(repo, 'update-ref', 'refs/remotes/origin/fix/remote', 'HEAD');
  const open = {
    ...validTask,
    id: 'T-1',
    body: [
      'Work waits on branch chore/gone-work, see feat/kept and fix/remote.',
      'Templates feat/... and paths src/fix/x.ts are not branches.',
    ],
  };
  const closed = {
    ...validTask,
    id: 'T-2',
    status: 'closed' as const,
    resolution: { kind: 'done' as const, ref: null, note: '' },
    body: ['Shipped from feat/deleted.'],
  };
  const exists = (branch: string): boolean =>
    branch === 'feat/kept' || branch === 'fix/remote';
  assert.deepEqual(branchMisses([open, closed], exists), [
    { branch: 'chore/gone-work', task: 'T-1' },
  ]);

  await writeTask(repo, open);
  await writeTask(repo, closed);
  const failing = runCli(repo, ['check', '--evidence']);
  assert.equal(failing.status, 65, failing.stderr);
  assert.match(
    failing.stderr,
    /tasks\/T-1\.json: missing branch chore\/gone-work \(neither local nor origin\)/u,
  );
  assert.doesNotMatch(failing.stderr, /feat\/kept|fix\/remote|feat\/deleted/u);
  assert.equal(runCli(repo, ['check']).status, 0, 'evidence stays opt-in');

  git(repo, 'branch', 'chore/gone-work');
  const passing = runCli(repo, ['check', '--evidence']);
  assert.equal(passing.status, 0, passing.stderr);
});
