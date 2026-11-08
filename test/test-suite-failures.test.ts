import assert from 'node:assert/strict';
import { rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { fixture, run } from './test-suite-fixture.ts';

test('test wrapper includes failing tests and handles an empty duration summary', async () => {
  const { root, project } = await fixture();
  try {
    const file = 'test/outcome.test.mjs';
    await writeFile(
      join(project, file),
      "import { test } from 'node:test'; test('failed outcome', () => { throw Error('expected failure'); });",
    );
    for (const strict of ['0', '1']) {
      const failed = run(project, [file], {
        KRN_TEST_STRICT: strict,
      });
      assert.equal(failed.status, 1, failed.stderr);
      assert.match(
        failed.stdout,
        /\| failed outcome \| test\/outcome.test.mjs \| \d+\.\d{3} \|/u,
      );
    }
    await rm(join(project, file));
    for (const strict of ['0', '1']) {
      const empty = run(project, [file], {
        KRN_TEST_STRICT: strict,
      });
      assert.equal(empty.status, 1);
      assert.match(empty.stdout, /No test durations recorded\./u);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('test wrapper kills a hung group and names its files', async () => {
  const { root, project } = await fixture();
  try {
    await writeFile(
      join(project, 'test', 'hang.test.mjs'),
      `import { spawn } from 'node:child_process';
import { test } from 'node:test';
test('leaks a child that never exits', () => {
  spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'inherit' });
  return new Promise(() => {});
});`,
    );
    const result = run(project, ['test/hang.test.mjs'], {
      KRN_TEST_SHARDS: '1',
      KRN_TEST_GROUP_TIMEOUT_MS: '3000',
    });
    assert.equal(result.error, undefined);
    assert.notEqual(result.status, 0);
    assert.match(
      result.stderr,
      /Test group hung after 3000 ms; killing it\. Files: .*test\/hang\.test\.mjs/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
