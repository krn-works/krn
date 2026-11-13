import assert from 'node:assert/strict';
import { chmodSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { inspectState } from '../../src/state/check.ts';
import { mainCheckoutPlaceholders } from '../../src/state/sandbox-placeholders.ts';
import { buildCaseRepo } from './fixture-repo.ts';

test('an empty read-only .mcp.json and .git/config.lock are named as transient, a non-empty file is not', () => {
  const root = buildCaseRepo('none');
  try {
    for (const path of [
      join(root, '.mcp.json'),
      join(root, '.git', 'config.lock'),
    ]) {
      writeFileSync(path, '');
      chmodSync(path, 0o444);
    }
    writeFileSync(join(root, '.npmrc'), 'registry=x\n');
    assert.deepEqual(mainCheckoutPlaceholders(root).sort(), [
      join(root, '.git', 'config.lock'),
      join(root, '.mcp.json'),
    ]);
    const details = inspectState(root)
      .warnings.filter((w) => w.rule === 'transient-sandbox-placeholder')
      .map((w) => w.detail);
    assert.equal(details.length, 2);
    assert.match(
      details.join('\n'),
      /\.mcp\.json is an empty sandbox placeholder/u,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
