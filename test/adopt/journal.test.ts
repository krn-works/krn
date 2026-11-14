import assert from 'node:assert/strict';
import {
  existsSync,
  lstatSync,
  mkdtempSync,
  writeFileSync as plainWrite,
  readFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  appendFileSync,
  Journal,
  mkdirSync,
  recording,
  symlinkSync,
  writeFileSync,
} from '../../src/adopt/journal.ts';
import { hasGithubHost } from '../../src/adopt/verify.ts';

test('a rollback removes new files and directories and restores changed files and keeps what was never written', () => {
  const root = mkdtempSync(join(tmpdir(), 'krn-journal-'));
  plainWrite(join(root, 'AGENTS.md'), '# Mine\n');
  plainWrite(join(root, 'other.txt'), 'untouched\n');
  const journal = new Journal();
  recording(journal, () => {
    appendFileSync(join(root, 'AGENTS.md'), 'block\n');
    mkdirSync(join(root, '.krn/deep'));
    writeFileSync(join(root, '.krn/deep/conventions.json'), '[]\n');
    symlinkSync('AGENTS.md', join(root, 'CLAUDE.md'));
  });
  assert.equal(
    readFileSync(join(root, 'AGENTS.md'), 'utf8'),
    '# Mine\nblock\n',
  );
  journal.rollback();
  assert.equal(readFileSync(join(root, 'AGENTS.md'), 'utf8'), '# Mine\n');
  assert.equal(readFileSync(join(root, 'other.txt'), 'utf8'), 'untouched\n');
  assert.equal(existsSync(join(root, '.krn')), false);
  assert.throws(() => lstatSync(join(root, 'CLAUDE.md')));
});

test('only a GitHub origin has a GitHub host', () => {
  for (const url of [
    'https://github.com/krn-works/krn.git',
    'git@github.com:krn-works/krn.git',
    'ssh://git@github.com/krn-works/krn.git',
  ])
    assert.equal(hasGithubHost(url), true, url);
  for (const url of [
    undefined,
    'git@gitlab.com:team/app.git',
    'https://git.example.org/team/app.git',
    '../srv/app.git',
    'https://notgithub.com/a/b',
  ])
    assert.equal(hasGithubHost(url), false, String(url));
});
