import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../..', import.meta.url));
const char = (code: number) => String.fromCodePoint(code);

async function scanner(): Promise<(text: string) => string[]> {
  const brief: Record<string, unknown> = await import(
    '../../src/brief/index.ts'
  );
  assert.equal(typeof brief.findInvisibleFormat, 'function');
  return brief.findInvisibleFormat as (text: string) => string[];
}

test('invisible format scanner names each raw character by line', async () => {
  const find = await scanner();
  assert.deepEqual(find(`${char(0xfeff)}plain\nclean`), []);
  for (const code of [0x200b, 0x200f, 0x2028, 0x202e, 0x2066, 0x2069, 0xfeff])
    assert.deepEqual(find(`one\ntwo${char(code)}`), [
      `line 2: raw invisible character U+${code.toString(16).toUpperCase()}; write its escape text`,
    ]);
  assert.deepEqual(find(`a${char(0x200a)}b${char(0x2030)}c`), []);
  assert.equal(find(char(0x200b).repeat(100)).length, 64);
});

test('tracked source holds no raw invisible format character', async () => {
  const find = await scanner();
  const listed = spawnSync(
    'git',
    ['ls-files', '-z', '--', 'src/', 'test/', 'scripts/'],
    { cwd: root, encoding: 'utf8' },
  );
  assert.equal(listed.status, 0, listed.stderr);
  const findings: string[] = [];
  for (const path of listed.stdout.split('\0').filter(Boolean)) {
    let text: string;
    try {
      text = readFileSync(join(root, path), 'utf8');
    } catch {
      continue;
    }
    if (text.includes('\0')) continue;
    for (const finding of find(text)) findings.push(`${path}:${finding}`);
  }
  assert.deepEqual(findings, []);
});
