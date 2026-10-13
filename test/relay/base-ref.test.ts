import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
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

test('repo facts use the recorded base of a master-default repository', async () => {
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

    const observed = await (async () => {
      try {
        return { facts: repoFacts(job) };
      } catch (error) {
        return {
          error: error instanceof Error ? error.message : String(error),
        };
      }
    })();
    assert.equal(
      'facts' in observed ? observed.facts.base : undefined,
      master,
      'repo facts should compare the job worktree to the base recorded at start',
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
