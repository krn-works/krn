import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  commitPrepared,
  prepareCheckpoint,
  preparedCommitMismatch,
} from '../../src/foreman/commit.ts';

async function repository() {
  const root = realpathSync(
    await mkdtemp(join(tmpdir(), 'krn-checkpoint-commit-')),
  );
  const git = (args: string[]) => {
    const result = spawnSync('git', ['-C', root, ...args], {
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  git(['init', '-q', '--initial-branch=main']);
  git(['config', 'user.name', 'Foreman']);
  git(['config', 'user.email', 'foreman@example.invalid']);
  await writeFile(join(root, '.gitignore'), '.krn/\n');
  git(['add', '.gitignore']);
  git(['commit', '-qm', 'fixture']);
  return {
    root,
    git,
    base: git(['rev-parse', 'HEAD']),
    job: {
      id: 'checkpoint-commit',
      issue: 'checkpoint-commit',
      worktree: root,
    },
  };
}

test('the prepared checkpoint becomes exactly one commit on its recorded parent', async () => {
  const r = await repository();
  try {
    await writeFile(join(r.root, 'step.txt'), 'worker step\n');
    const prepared = prepareCheckpoint(r.job, 'feat: step', 'session-1');
    assert.equal(prepared.parent, r.base);
    const sha = commitPrepared(r.job, prepared);
    assert.equal(r.git(['rev-parse', 'HEAD']), sha);
    assert.equal(r.git(['rev-parse', 'HEAD^']), r.base);
    assert.equal(r.git(['status', '--porcelain']), '');
    assert.equal(
      r.git(['show', '-s', '--format=%(trailers:key=Krn-Session,valueonly)']),
      'session-1',
    );
    assert.equal(preparedCommitMismatch(r.job, prepared, sha), null);
  } finally {
    await rm(r.root, { recursive: true, force: true });
  }
});

test('a prepared checkpoint never moves a HEAD that moved after preparation', async () => {
  const r = await repository();
  try {
    await writeFile(join(r.root, 'step.txt'), 'worker step\n');
    const prepared = prepareCheckpoint(r.job, 'feat: step', 'session-1');
    r.git(['stash', '-q']);
    await writeFile(join(r.root, 'other.txt'), 'concurrent change\n');
    r.git(['add', 'other.txt']);
    r.git(['commit', '-qm', 'chore: concurrent commit']);
    const concurrent = r.git(['rev-parse', 'HEAD']);
    assert.throws(() => commitPrepared(r.job, prepared));
    assert.equal(r.git(['rev-parse', 'HEAD']), concurrent);
    assert.equal(
      preparedCommitMismatch(r.job, prepared, concurrent),
      'HEAD tree differs from the recorded checkpoint tree',
    );
  } finally {
    await rm(r.root, { recursive: true, force: true });
  }
});
