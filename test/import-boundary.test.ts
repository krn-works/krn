import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import test from 'node:test';

test('core does not import host, ledger, or trace adapters', async () => {
  const root = new URL('../src/core/', import.meta.url);
  const files = await readdir(root);
  const sources = await Promise.all(
    files
      .filter((file) => file.endsWith('.ts'))
      .map((file) => readFile(new URL(file, root), 'utf8')),
  );
  const importsAdapters = sources.some((source) =>
    /from\s+['"].*\/(hosts|ledger|trace)(\/|['"])/u.test(source),
  );
  assert.equal(
    importsAdapters,
    false,
    'core must remain independent of adapters',
  );
});
