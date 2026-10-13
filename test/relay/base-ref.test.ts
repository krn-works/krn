import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { repoFacts } from '../../src/relay/index.ts';

const cli = fileURLToPath(new URL('../../src/cli/main.ts', import.meta.url));

function git(root: string, args: string[]): string {
  const result = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

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
    const started = spawnSync(
      process.execPath,
      [cli, 'start', '--job', 'j1', '--issue', 'X'],
      { cwd: root, encoding: 'utf8' },
    );
    assert.equal(started.status, 0, started.stderr);
    const job = JSON.parse(started.stdout.trim()) as {
      id: string;
      issue: string;
      worktree: string;
      repoRoot: string;
    };
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
    const started = spawnSync(
      process.execPath,
      [cli, 'start', '--job', 'j2', '--issue', 'X'],
      { cwd: root, encoding: 'utf8' },
    );
    assert.equal(started.status, 0, started.stderr);
    const job = JSON.parse(started.stdout.trim()) as {
      id: string;
      issue: string;
      worktree: string;
      repoRoot: string;
    };

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
