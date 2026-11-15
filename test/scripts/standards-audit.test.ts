import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { adoptedCopy } from '../../scripts/standards-audit.ts';

function row(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'audit-row-'));
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(join(dir, name, '..'), { recursive: true });
    writeFileSync(join(dir, name), text);
  }
  const git = (...args: string[]) =>
    spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], {
      cwd: dir,
      encoding: 'utf8',
    });
  git('init', '-q', '-b', 'main');
  git('add', '-A');
  git('commit', '-qm', 'base');
  return dir;
}

test('an audited row is measured fully adopted: Stop hook and .krn ignore exist in the copy, not in the row', () => {
  const source = row({
    'krn.json': '{"tracker":"krn","test":"node --test t.test.js"}\n',
    't.test.js': "import test from 'node:test';\ntest('x', () => {});\n",
  });
  const copy = adoptedCopy(source, mkdtempSync(join(tmpdir(), 'audit-out-')));
  assert.ok('dir' in copy, JSON.stringify(copy));
  const settings = readFileSync(
    join(copy.dir, '.claude/settings.json'),
    'utf8',
  );
  assert.match(settings, /"Stop"/u);
  assert.match(readFileSync(join(copy.dir, '.gitignore'), 'utf8'), /\.krn/u);
  assert.equal(existsSync(join(source, '.claude')), false);
});

test('a row without a test is reported as refused, never measured half adopted', () => {
  const source = row({ 'krn.json': '{"tracker":"krn"}\n', 'a.txt': 'x\n' });
  const copy = adoptedCopy(source, mkdtempSync(join(tmpdir(), 'audit-out-')));
  assert.ok('error' in copy);
  assert.match(copy.error, /canary/u);
});

test('an audit adoption writes its scratch registry and leaves the host registry untouched', () => {
  const home = mkdtempSync(join(tmpdir(), 'audit-home-'));
  const scratch = mkdtempSync(join(tmpdir(), 'audit-scratch-'));
  const saved = { HOME: process.env.HOME, TMPDIR: process.env.TMPDIR };
  const elsewhere = mkdtempSync(join(tmpdir(), 'audit-tmpdir-'));
  delete process.env.KRN_ADOPTED_REGISTRY;
  process.env.HOME = home;
  process.env.TMPDIR = elsewhere;
  try {
    const copy = adoptedCopy(
      row({ 'package.json': '{"name":"p"}\n' }),
      scratch,
    );
    assert.ok('dir' in copy, JSON.stringify(copy));
    assert.equal(existsSync(join(home, '.krn', 'adopted.json')), false);
    assert.equal(existsSync(join(scratch, 'registry.json')), true);
  } finally {
    process.env.HOME = saved.HOME;
    if (saved.TMPDIR === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = saved.TMPDIR;
  }
});
