import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { test } from 'node:test';
import { resolveChecks } from '../src/verdict/registry.ts';

const ids = ['typecheck', 'lint', 'rules'];

test('HEAD registry resolves every registered check ID', async () => {
  const root = execFileSync('git', ['rev-parse', '--show-toplevel'], {
    encoding: 'utf8',
  }).trim();

  await assert.doesNotReject(async () => {
    const checks = await resolveChecks(root, 'HEAD', ids);
    assert.deepEqual(
      checks.map((check) => check.id),
      ids,
    );
  });
});
