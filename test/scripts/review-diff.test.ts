import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { chunks, prompt } from '../../scripts/review-diff.ts';

const row = (lines: number, path: string) => `${lines}\t0\t${path}`;

test('chunks group files by changed lines, skip task records and keep binary files', () => {
  const numstat = [
    row(300, 'src/a.ts'),
    row(90, 'src/b.ts'),
    row(50, 'src/c.ts'),
    '-\t-\tassets/logo.png',
    row(10, 'tasks/t-abc1234.json'),
    '',
  ].join('\n');
  assert.deepEqual(chunks(numstat), [
    ['src/a.ts', 'src/b.ts'],
    ['src/c.ts', 'assets/logo.png'],
  ]);
});

test('a file larger than a chunk gets its own chunk', () => {
  assert.deepEqual(chunks([row(900, 'a.ts'), row(10, 'b.ts')].join('\n')), [
    ['a.ts'],
    ['b.ts'],
  ]);
});

test('past six chunks the tail merges into the last one, so every file is still read', () => {
  const files = Array.from({ length: 9 }, (_, i) => `f${i}.ts`);
  const groups = chunks(files.map((f) => row(400, f)).join('\n'));
  assert.equal(groups.length, 6);
  assert.deepEqual(groups.flat(), files);
  assert.deepEqual(groups.at(-1), ['f5.ts', 'f6.ts', 'f7.ts', 'f8.ts']);
});

test('the prompt names the range and the share, and asks for a reproduce command under .krn/tmp/review', () => {
  const text = prompt('abc', 'def', ['src/a.ts', 'src/b.ts']);
  assert.match(text, /git diff abc\.\.\.def/u);
  assert.match(text, /src\/a\.ts, src\/b\.ts/u);
  assert.match(text, /\.krn\/tmp\/review\//u);
  assert.doesNotMatch(text, /intent of the author|the author wants/iu);
});

test('the reviewer krn.json takes from the base is a tracked script: a broken path would stop every tier 2 ship with exit 85', () => {
  const root = join(import.meta.dirname, '..', '..');
  const contract: unknown = JSON.parse(
    readFileSync(join(root, 'krn.json'), 'utf8'),
  );
  const command =
    typeof contract === 'object' && contract !== null && 'review' in contract
      ? String(contract.review)
      : '';
  const script = /git show origin\/main:(scripts\/[\w-]+\.ts) /u.exec(
    command,
  )?.[1];
  assert.ok(script, `krn.json review names no script of the base: ${command}`);
  assert.ok(existsSync(join(root, script)), `${script} is missing`);
});
