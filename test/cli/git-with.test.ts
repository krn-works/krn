import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { gitWith } from '../../src/cli/git-with.ts';

function repository(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'krn-git-with-')));
  spawnSync('git', ['-C', dir, 'init', '-q', '-b', 'main']);
  return dir;
}

test('gitWith returns the trimmed stdout of a real git run', () => {
  const dir = repository();
  const git = gitWith((message) => new Error(message));
  assert.equal(git(dir, ['symbolic-ref', '--short', 'HEAD']), 'main');
});

test('gitWith throws what the caller builds when git exits non-zero', () => {
  class Refused extends Error {}
  const git = gitWith((message) => new Refused(message));
  assert.throws(
    () => git(repository(), ['rev-parse', '--verify', 'no-such-ref']),
    (error: Error) =>
      error instanceof Refused && error.message.startsWith('git rev-parse'),
  );
});
