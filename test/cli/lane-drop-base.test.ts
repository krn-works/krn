import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { dropLane } from '../../src/cli/lane.ts';

function git(cwd: string, ...args: string[]): string {
  const r = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim();
}

test('dropLane refuses to delete the repository base branch main', async (t) => {
  const repo = realpathSync(mkdtempSync(join(tmpdir(), 'krn-d13-')));
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.email', 'a@b.c');
  git(repo, 'config', 'user.name', 'a');
  writeFileSync(join(repo, 'a.txt'), 'hi\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-qm', 'base');
  // Detach HEAD (or switch branch) in main checkout so git branch -D main can execute.
  git(repo, 'checkout', '-q', '--detach', 'HEAD');

  await assert.rejects(
    dropLane(['main', '--root', repo]),
    /base|not a lane|main/u,
    'expected dropLane to refuse deleting the base branch main',
  );
});
