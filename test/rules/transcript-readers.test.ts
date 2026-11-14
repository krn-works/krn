import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

// A rule over every src module, so npm run fast runs it on any change (rule tests always run):
// as a harness test it was skipped when a new src module read transcripts.
test('no source outside src/harness reads transcript files', async () => {
  const src = new URL('../../src/', import.meta.url).pathname;
  const walk = async (dir: string): Promise<string[]> => {
    const out: string[] = [];
    for (const e of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, e.name);
      if (e.isDirectory()) out.push(...(await walk(path)));
      else if (e.name.endsWith('.ts')) out.push(path);
    }
    return out;
  };
  const readers: string[] = [];
  for (const file of await walk(src)) {
    if (file.startsWith(join(src, 'harness'))) continue;
    const text = await readFile(file, 'utf8');
    if (/\.claude\/projects|createInterface|['"`]subagents['"`]/u.test(text))
      readers.push(file.slice(src.length));
  }
  assert.deepEqual(readers, []);
});
