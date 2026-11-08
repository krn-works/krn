import assert from 'node:assert/strict';
import test from 'node:test';
import { requiresIsolation } from '../helpers/isolation.ts';
import { digest, fixture, output } from './checks-fixture.ts';

test('eval check blocks unfrozen scripts, installations and npx including nested calls', async (t) => {
  if (!requiresIsolation(t, t.name, ['bwrap'])) return;
  const f = await fixture();
  try {
    for (const argv of [
      ['npm', 'run', 'missing'],
      ['npm', 'install'],
      ['npx', 'anything'],
      ['npm', 'run', 'nested'],
    ]) {
      f.task.scripts.nested = 'npm install';
      f.task.focusedCheck = argv;
      await f.save();
      const result = output(f.run());
      assert.equal(result.status, 'FAIL');
      assert.equal(result.exitCode, 127);
      assert.equal(result.reason, 'exit 127');
      const message =
        argv[1] === 'run' && argv[2] === 'missing'
          ? 'script not frozen: missing\n'
          : argv[0] === 'npx'
            ? 'npx is disabled for frozen checks\n'
            : 'npm subcommand not allowed: install\n';
      assert.equal(result.stderrSha256, digest(message));
    }
  } finally {
    await f.cleanup();
  }
});
