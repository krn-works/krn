import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { loadShardWeights } from '../../scripts/lib/shard-weights.mjs';
import { planTestShards } from '../../scripts/lib/test-shards.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const WEIGHTS_JSON = 'scripts/lib/shard-weights.json';
const IMPORT_SPECIFIER =
  /(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\(\s*)['"](\.{1,2}\/[^'"]+)['"]/gu;

// Gate entry points: `npm test` and every repository script the CI workflow
// runs directly or through an npm script.
function gateEntryPoints() {
  const ci = readFileSync(join(root, '.github/workflows/ci.yml'), 'utf8');
  const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const commands = [ci];
  for (const [, name] of ci.matchAll(/npm (?:run )?([\w:-]+)/gu))
    if (manifest.scripts[name]) commands.push(manifest.scripts[name]);
  if (manifest.scripts.test) commands.push(manifest.scripts.test);
  const entries = new Set(['scripts/test-suite.mjs']);
  for (const text of commands)
    for (const [path] of text.matchAll(/scripts\/[\w./-]+\.(?:mjs|ts)/gu))
      if (existsSync(join(root, path))) entries.add(path);
  return [...entries];
}

function importClosure(entries) {
  const seen = new Set();
  const queue = entries.map((entry) => resolve(root, entry));
  while (queue.length > 0) {
    const file = queue.pop();
    if (seen.has(file) || !existsSync(file)) continue;
    seen.add(file);
    if (!/\.(?:mjs|js|ts)$/u.test(file)) continue;
    const source = readFileSync(file, 'utf8');
    for (const [, specifier] of source.matchAll(IMPORT_SPECIFIER))
      queue.push(resolve(dirname(file), specifier));
  }
  return [...seen].map((file) => relative(root, file));
}

test('no gate entry point imports the weights data', () => {
  const entries = gateEntryPoints();
  assert.ok(entries.includes('scripts/test-suite.mjs'));
  assert.ok(entries.length > 1, 'ci.yml entry points were not found');
  const closure = importClosure(entries);
  assert.ok(closure.includes('scripts/lib/test-shards.mjs'));
  assert.ok(closure.includes('scripts/lib/shard-weights.mjs'));
  assert.equal(closure.includes(WEIGHTS_JSON), false);
  for (const file of closure.filter((path) => /\.(?:mjs|ts)$/u.test(path)))
    assert.doesNotMatch(
      readFileSync(join(root, file), 'utf8'),
      /(?:^\s*'test\/[^']+\.test\.[mt]s': [\d.]+,\n){5}/mu,
      `${file} embeds per-file weights`,
    );
});

test('a malformed weights file plans by size, not a crash', () => {
  const dir = mkdtempSync(join(tmpdir(), 'shard-weights-'));
  const files = ['test/a.test.ts', 'test/b.test.ts', 'test/c.test.ts'];
  const bad = [
    '{ not json',
    '[]',
    'null',
    '{"weights":7}',
    '{"weights":{"x":"1"}}',
  ];
  const sized = planTestShards(files, 2, [], [], {});
  for (const [index, text] of bad.entries()) {
    const path = join(dir, `bad-${index}.json`);
    writeFileSync(path, text);
    const weights = loadShardWeights(path);
    assert.deepEqual({ ...weights }, {}, text);
    assert.deepEqual(planTestShards(files, 2, [], [], weights), sized, text);
  }
  assert.deepEqual({ ...loadShardWeights(join(dir, 'absent.json')) }, {});
  assert.ok(Object.keys(loadShardWeights()).length > 0, 'shipped weights load');
});
