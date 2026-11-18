import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import * as prepare from '../../src/cli/lane-run/prepare.ts';

function note(path: string, base: string): string {
  assert.equal(typeof prepare.reusedLaneNote, 'function');
  return prepare.reusedLaneNote(path, base);
}

function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'reused-note-'));
  const git = (...args: string[]) =>
    spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8' });
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'a@b.c');
  git('config', 'user.name', 'a');
  writeFileSync(join(dir, 'a.txt'), 'a\n');
  git('add', '.');
  git('commit', '-q', '-m', 'base');
  git('checkout', '-q', '-b', 'lane');
  return dir;
}

test('a lane branch with no commit past the base needs no reuse note', () => {
  assert.equal(note(repo(), 'main'), '');
});

test('a reused lane branch names the commits a failed attempt left', () => {
  const dir = repo();
  const git = (...args: string[]) =>
    spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8' });
  writeFileSync(join(dir, 'b.txt'), 'b\n');
  git('add', '.');
  git('commit', '-q', '-m', 'docs: earlier attempt');
  const text = note(dir, 'main');
  assert.match(text, /Reused worktree/u);
  assert.match(text, /1 commit/u);
  assert.match(text, /earlier attempt/u);
  assert.match(text, /last-refusal\.txt/u);
});
