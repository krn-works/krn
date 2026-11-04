import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

for (const entry of ['../../src/cli/main.ts', '../../src/cli/krn.mjs']) {
  test(`slice usage errors through ${entry}`, () => {
    for (const args of [
      [],
      ['run'],
      ['unknown'],
      ['run', 't-test', '--unknown'],
      ['run', 't-test', '--worker', 'other'],
    ]) {
      const result = spawnSync(
        process.execPath,
        [new URL(entry, import.meta.url).pathname, 'slice', ...args],
        { encoding: 'utf8' },
      );
      assert.equal(result.status, 64, result.stderr);
      assert.match(result.stderr, /^slice base exit=64: [^\r\n]+\n$/u);
      assert.ok(
        result.stderr.trimEnd().length <= 'slice base exit=64: '.length + 200,
      );
    }
  });
}
