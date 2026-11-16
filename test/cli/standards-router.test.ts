import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { standardsVerbs } from '../../src/brain/standards-verbs.ts';

const krn = fileURLToPath(new URL('../../bin/krn', import.meta.url));

test('krn standards --help lists every verb of the verb table with its synopsis', () => {
  const done = spawnSync(krn, ['standards', '--help'], { encoding: 'utf8' });
  assert.equal(done.status, 0);
  for (const [verb, entry] of Object.entries(standardsVerbs)) {
    assert.match(done.stdout, new RegExp(`\\b${verb}\\b`, 'u'), verb);
    assert.ok(done.stdout.includes(entry.help), verb);
  }
});

test('an unknown standards verb exits 64 with the usage naming every verb', () => {
  const done = spawnSync(krn, ['standards', 'frobnicate'], {
    encoding: 'utf8',
  });
  assert.equal(done.status, 64);
  for (const entry of Object.values(standardsVerbs))
    for (const line of entry.synopsis)
      assert.ok(done.stderr.includes(line), line);
});
