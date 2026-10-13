import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { dispatch } from '../../src/cli/index.ts';
import { recordRepo } from '../../src/foreman/state.ts';
import { repoFacts } from '../../src/relay/index.ts';

function git(root: string, args: string[]): string {
  const result = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

async function startJob(
  root: string,
  id: string,
  options: string[] = [],
): Promise<{ id: string; issue: string; worktree: string; repoRoot: string }> {
  const originalCwd = process.cwd();
  const originalWrite = process.stdout.write;
  let output = '';
  process.stdout.write = ((chunk: string | Uint8Array) => {
    output += chunk.toString();
    return true;
  }) as typeof process.stdout.write;
  try {
    process.chdir(root);
    await dispatch(['start', '--job', id, '--issue', 'X', ...options]);
  } finally {
    process.stdout.write = originalWrite;
    process.chdir(originalCwd);
  }
  return JSON.parse(output.trim()) as {
    id: string;
    issue: string;
    worktree: string;
    repoRoot: string;
  };
}

test('recordRepo persists the base SHA captured before its ref moves', async () => {
  const root = await mkdtemp(join(tmpdir(), 'krn-base-ref-pin-'));
  try {
    git(root, ['init', '-q', '--initial-branch=master']);
    git(root, ['config', 'gc.auto', '0']);
    git(root, ['config', 'maintenance.auto', 'false']);
    await writeFile(join(root, '.gitignore'), '.krn/\n');
    await writeFile(join(root, 'README.md'), 'initial commit\n');
    git(root, ['add', '.gitignore', 'README.md']);
    git(root, [
      '-c',
      'user.name=Base Ref Test',
      '-c',
      'user.email=base-ref@example.invalid',
      'commit',
      '-qm',
      'initial commit',
    ]);
    const capturedBaseSha = git(root, ['rev-parse', 'master']);
    const worktree = join(root, '.krn', 'worktrees', 'j-pinned');
    await mkdir(join(root, '.krn', 'worktrees'), { recursive: true });
    git(root, ['worktree', 'add', '-b', 'krn/j-pinned', worktree, 'HEAD']);

    await writeFile(join(root, 'advanced.txt'), 'advance master\n');
    git(root, ['add', 'advanced.txt']);
    git(root, [
      '-c',
      'user.name=Base Ref Test',
      '-c',
      'user.email=base-ref@example.invalid',
      'commit',
      '-qm',
      'advance master',
    ]);
    assert.notEqual(git(root, ['rev-parse', 'master']), capturedBaseSha);

    const record = recordRepo(
      {
        id: 'j-pinned',
        issue: 'X',
        worktree,
        repoRoot: root,
      },
      root,
      'master',
      capturedBaseSha,
    );
    assert.equal(record.baseRef, 'master');
    assert.equal(record.baseSha, capturedBaseSha);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('repo facts use the recorded base SHA after the base ref changes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'krn-base-ref-'));
  try {
    git(root, ['init', '-q', '--initial-branch=master']);
    git(root, ['config', 'gc.auto', '0']);
    git(root, ['config', 'maintenance.auto', 'false']);
    await writeFile(join(root, '.gitignore'), '.krn/\n');
    await writeFile(join(root, 'README.md'), 'initial commit\n');
    git(root, ['add', '.gitignore', 'README.md']);
    git(root, [
      '-c',
      'user.name=Base Ref Test',
      '-c',
      'user.email=base-ref@example.invalid',
      'commit',
      '-qm',
      'initial commit',
    ]);
    const master = git(root, ['rev-parse', 'master']);
    const job = await startJob(root, 'j1');
    await writeFile(join(job.worktree, 'job-change.txt'), 'job commit\n');
    git(job.worktree, ['add', 'job-change.txt']);
    git(job.worktree, [
      '-c',
      'user.name=Base Ref Test',
      '-c',
      'user.email=base-ref@example.invalid',
      'commit',
      '-qm',
      'job commit',
    ]);

    const recordPath = join(
      root,
      '.krn',
      'runs',
      'foreman',
      job.id,
      'repo.json',
    );
    const record = JSON.parse(await readFile(recordPath, 'utf8')) as {
      baseRef: string;
      baseSha: string;
    };
    assert.equal(record.baseRef, 'master');
    assert.equal(record.baseSha, master);
    git(root, [
      'branch',
      'moved-base',
      git(job.worktree, ['rev-parse', 'HEAD']),
    ]);
    await writeFile(
      recordPath,
      JSON.stringify({ ...record, baseRef: 'moved-base' }),
    );

    assert.equal(
      repoFacts(job).base,
      record.baseSha,
      'repo facts should compare the job worktree to the base SHA recorded at start',
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('repo facts reject a recorded base SHA that is not an ancestor of HEAD', async () => {
  const root = await mkdtemp(join(tmpdir(), 'krn-base-sha-ancestor-'));
  try {
    git(root, ['init', '-q', '--initial-branch=master']);
    git(root, ['config', 'gc.auto', '0']);
    git(root, ['config', 'maintenance.auto', 'false']);
    await writeFile(join(root, '.gitignore'), '.krn/\n');
    await writeFile(join(root, 'README.md'), 'initial commit\n');
    git(root, ['add', '.gitignore', 'README.md']);
    git(root, [
      '-c',
      'user.name=Base Ref Test',
      '-c',
      'user.email=base-ref@example.invalid',
      'commit',
      '-qm',
      'initial commit',
    ]);
    const job = await startJob(root, 'j2');

    git(root, ['checkout', '-q', '-b', 'side-base']);
    await writeFile(join(root, 'side.txt'), 'side commit\n');
    git(root, ['add', 'side.txt']);
    git(root, [
      '-c',
      'user.name=Base Ref Test',
      '-c',
      'user.email=base-ref@example.invalid',
      'commit',
      '-qm',
      'side commit',
    ]);
    const sideBase = git(root, ['rev-parse', 'HEAD']);
    git(root, ['checkout', '-q', 'master']);

    const recordPath = join(
      root,
      '.krn',
      'runs',
      'foreman',
      job.id,
      'repo.json',
    );
    const record = JSON.parse(await readFile(recordPath, 'utf8')) as {
      baseRef: string;
      baseSha: string;
    };
    await writeFile(
      recordPath,
      JSON.stringify({ ...record, baseSha: sideBase }),
    );

    assert.throws(
      () => repoFacts(job),
      /recorded base SHA .* is not an ancestor of HEAD/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('start records the merge-base when the selected base ref has diverged from checkout HEAD', async () => {
  const root = await mkdtemp(join(tmpdir(), 'krn-base-ref-diverged-'));
  try {
    git(root, ['init', '-q', '--initial-branch=master']);
    git(root, ['config', 'gc.auto', '0']);
    git(root, ['config', 'maintenance.auto', 'false']);
    await writeFile(join(root, '.gitignore'), '.krn/\n');
    await writeFile(join(root, 'README.md'), 'initial commit\n');
    git(root, ['add', '.gitignore', 'README.md']);
    git(root, [
      '-c',
      'user.name=Base Ref Test',
      '-c',
      'user.email=base-ref@example.invalid',
      'commit',
      '-qm',
      'initial commit',
    ]);
    const commonAncestor = git(root, ['rev-parse', 'HEAD']);

    git(root, ['checkout', '-q', '-b', 'selected-base']);
    await writeFile(join(root, 'base.txt'), 'base branch commit\n');
    git(root, ['add', 'base.txt']);
    git(root, [
      '-c',
      'user.name=Base Ref Test',
      '-c',
      'user.email=base-ref@example.invalid',
      'commit',
      '-qm',
      'base branch commit',
    ]);
    const baseTip = git(root, ['rev-parse', 'HEAD']);

    git(root, ['checkout', '-q', 'master']);
    await writeFile(join(root, 'checkout.txt'), 'checkout branch commit\n');
    git(root, ['add', 'checkout.txt']);
    git(root, [
      '-c',
      'user.name=Base Ref Test',
      '-c',
      'user.email=base-ref@example.invalid',
      'commit',
      '-qm',
      'checkout branch commit',
    ]);

    const job = await startJob(root, 'j-diverged', ['--base', 'selected-base']);
    const recordPath = join(
      root,
      '.krn',
      'runs',
      'foreman',
      job.id,
      'repo.json',
    );
    const record = JSON.parse(await readFile(recordPath, 'utf8')) as {
      baseRef: string;
      baseSha: string;
    };

    assert.equal(record.baseRef, 'selected-base');
    assert.equal(record.baseSha, commonAncestor);
    assert.notEqual(record.baseSha, baseTip);
    assert.equal(
      git(job.worktree, ['merge-base', 'HEAD', baseTip]),
      commonAncestor,
    );
    assert.equal(repoFacts(job).base, commonAncestor);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
