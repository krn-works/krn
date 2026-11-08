import assert from 'node:assert/strict';
import { chmod, readdir } from 'node:fs/promises';
import test from 'node:test';
import { requiresIsolation } from '../helpers/isolation.ts';
import { fixture, output, refusal } from './checks-fixture.ts';

test('eval check accepts non-test checks and explicit drafts', async (t) => {
  if (!requiresIsolation(t, t.name, ['bwrap'])) return;
  const f = await fixture();
  try {
    f.value.frozen = false;
    await f.save();
    refusal(f.run(), 65, /frozen/u);
    const args = f.args(['--draft']);
    args[args.indexOf('focused')] = 'suite:0';
    const result = output(f.invoke(args));
    assert.equal(result.status, 'PASS');
    assert.deepEqual([result.tests, result.pass, result.fail], [0, 0, 0]);
    const text = f.invoke(args.filter((arg) => arg !== '--json'));
    assert.equal(text.status, 0, text.stderr);
    assert.match(text.stdout, /PASS/u);
    f.task.suiteChecks[0] = {
      argv: ['node', '-e', 'console.log("# tests 1\\n# pass 0\\n# fail 1")'],
      tests: true,
    };
    await f.save();
    const failed = output(f.invoke(args));
    assert.equal(failed.reason, '1 failed');
  } finally {
    await f.cleanup();
  }
});

test('eval check maps inaccessible directories to data refusals', async () => {
  const f = await fixture();
  try {
    for (const path of [f.cwd, f.evaluator]) {
      await chmod(path, 0);
      try {
        refusal(f.run(), 65, /EACCES/u);
      } finally {
        await chmod(path, 0o755);
      }
    }
    assert.deepEqual(await readdir(f.evaluator), []);
  } finally {
    await f.cleanup();
  }
});
