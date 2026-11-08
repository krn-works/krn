import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { evidenceMisses } from '../../src/task/evidence.ts';
import {
  runCli,
  tempDirectory,
  tempRepo,
  useScratch,
  validTask,
  writeTask,
} from './task-fixture.ts';

useScratch();

test('evidence check lists missing open-task .krn/runs pointers with their recovery copy', async () => {
  const repo = await tempRepo('evidence-');
  const recovery = await tempDirectory('recovery-');
  await mkdir(join(repo, '.krn/runs/kept'), { recursive: true });
  await writeFile(join(repo, '.krn/runs/kept/report.md'), 'kept\n');
  await mkdir(join(recovery, '.krn/runs/moved'), { recursive: true });
  await writeFile(join(recovery, '.krn/runs/moved/report.md'), 'moved\n');
  const open = {
    ...validTask,
    id: 'T-1',
    body: [
      'Kept `.krn/runs/kept/report.md`, moved .krn/runs/moved/report.md.',
      'Gone: .krn/runs/gone/ and a template .krn/runs/<run>/x.md',
    ],
  };
  const closed = {
    ...validTask,
    id: 'T-2',
    status: 'closed' as const,
    resolution: { kind: 'done' as const, ref: null, note: '' },
    body: ['.krn/runs/closed.md'],
  };
  assert.deepEqual(evidenceMisses([open, closed], repo, recovery), [
    { path: '.krn/runs/gone', task: 'T-1', recovery: null },
    {
      path: '.krn/runs/moved/report.md',
      task: 'T-1',
      recovery: join(recovery, '.krn/runs/moved/report.md'),
    },
  ]);

  await writeTask(repo, open);
  const failing = runCli(repo, ['check', '--evidence', '--recovery', recovery]);
  assert.equal(failing.status, 65, failing.stderr);
  assert.match(
    failing.stderr,
    /tasks\/T-1\.json: missing evidence \.krn\/runs\/gone \(no recovery copy\)/u,
  );
  assert.match(
    failing.stderr,
    /missing evidence \.krn\/runs\/moved\/report\.md \(recovery .*moved\/report\.md\)/u,
  );
  assert.equal(runCli(repo, ['check']).status, 0, 'evidence stays opt-in');
  assert.equal(runCli(repo, ['check', '--recovery', recovery]).status, 64);

  await writeTask(repo, { ...open, body: ['Kept .krn/runs/kept/report.md.'] });
  const passing = runCli(repo, ['check', '--evidence']);
  assert.equal(passing.status, 0, passing.stderr);
});
