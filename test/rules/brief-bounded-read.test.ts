import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const api = await import('../../src/brief/index.ts').catch(() => undefined);
const root = fileURLToPath(new URL('../..', import.meta.url));
const cli = join(root, 'src/cli/krn.mjs');
const checklist = join(root, 'docs/program/hardening-checklist.md');

function setup(t: { after(fn: () => void): void }) {
  assert.equal(typeof api?.readRegularFile, 'function');
  const dir = mkdtempSync(join(tmpdir(), 'krn-brief-bounded-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, 'real'));
  copyFileSync(checklist, join(dir, 'real', 'checklist.md'));
  writeFileSync(join(dir, 'real', 'brief.md'), '# Brief\n');
  symlinkSync('real', join(dir, 'link'));
  const run = (args: string[]) =>
    spawnSync(process.execPath, [cli, ...args], {
      cwd: dir,
      encoding: 'utf8',
    });
  return { dir, run };
}

function review(dir: string, checklistPath: string): string[] {
  const head = spawnSync('git', ['rev-parse', 'HEAD'], {
    cwd: root,
    encoding: 'utf8',
  }).stdout.trim();
  writeFileSync(join(dir, 'lens.md'), 'Check the change.\n');
  return [
    'review',
    '--repo',
    root,
    '--base',
    'main',
    '--head',
    head,
    '--lens',
    join(dir, 'lens.md'),
    '--prepass',
    '--checklist',
    checklistPath,
  ];
}

test('brief check refuses a brief or checklist reached through a symlinked directory', (t) => {
  const f = setup(t);
  const brief = f.run([
    'brief',
    'check',
    join(f.dir, 'link', 'brief.md'),
    '--checklist',
    join(f.dir, 'real', 'checklist.md'),
  ]);
  assert.equal(brief.status, 65);
  assert.match(brief.stderr, /brief path must not pass through a symlink/u);
  const list = f.run([
    'brief',
    'check',
    join(f.dir, 'real', 'brief.md'),
    '--checklist',
    join(f.dir, 'link', 'checklist.md'),
  ]);
  assert.equal(list.status, 65);
  assert.match(list.stderr, /checklist path must not pass through a symlink/u);
});

test('review refuses an oversize or symlink-reached checklist before reading it', (t) => {
  const f = setup(t);
  const big = join(f.dir, 'big.md');
  writeFileSync(big, '');
  truncateSync(big, 3 * 1024 ** 3);
  const oversize = f.run(review(f.dir, big));
  assert.equal(oversize.status, 64);
  assert.match(oversize.stderr, /--checklist exceeds 32768 bytes/u);
  const linked = f.run(review(f.dir, join(f.dir, 'link', 'checklist.md')));
  assert.equal(linked.status, 64);
  assert.match(
    linked.stderr,
    /--checklist path must not pass through a symlink/u,
  );
});
