import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { requiresIsolation } from '../helpers/isolation.ts';
import { fixture, output } from './checks-fixture.ts';

test('eval check runs frozen scripts despite candidate edits, sums TAP and fixes its environment', async (t) => {
  if (!requiresIsolation(t, t.name, ['bwrap'])) return;
  const f = await fixture();
  try {
    const before = await readFile(join(f.experiment, 'manifest.json'));
    const passing = output(f.run());
    assert.equal(passing.status, 'PASS');
    assert.equal(passing.reason, null);
    assert.equal(passing.exitCode, 0);
    assert.deepEqual([passing.tests, passing.pass, passing.fail], [1, 1, 0]);
    f.task.scripts.nested = 'npm run-script test && npm t';
    f.task.focusedCheck = ['npm', 'run', 'nested'];
    await f.save();
    const multiple = output(f.run());
    assert.deepEqual([multiple.tests, multiple.pass, multiple.fail], [2, 2, 0]);
    f.task.scripts.test = 'node -e "process.exit(0)"';
    f.task.focusedCheck = ['npm', 'test'];
    await f.save();
    const empty = output(f.run());
    assert.equal(empty.status, 'FAIL');
    assert.equal(empty.reason, 'no tests executed');
    assert.equal(empty.exitCode, 0);
    assert.deepEqual([empty.tests, empty.pass, empty.fail], [0, 0, 0]);
    await writeFile(join(f.experiment, 'manifest.json'), before);
    assert.deepEqual(await readdir(f.evaluator), []);
    assert.equal(
      await readFile(join(f.cwd, 'package.json'), 'utf8'),
      '{"scripts":{"test":"true"}}',
    );
    assert.deepEqual(
      await readFile(join(f.experiment, 'manifest.json')),
      before,
    );
  } finally {
    await f.cleanup();
  }
});

test('eval check accepts repository cwd and canonicalizes safe absolute slot spellings', async (t) => {
  if (!requiresIsolation(t, t.name, ['bwrap'])) return;
  const f = await fixture();
  try {
    f.task.workingDirectory = '.';
    f.task.suiteChecks[0] = {
      argv: [
        'node',
        '-e',
        "require('node:assert/strict').equal(process.cwd(), '/w/repo')",
      ],
      tests: false,
    };
    await f.save();
    const args = f.args();
    args[args.indexOf('focused')] = 'suite:0';
    args[args.indexOf(f.slot)] = `${f.slot}//repo/../`;
    args[args.indexOf(f.experiment)] = 'experiment';
    const result = spawnSync(process.execPath, args, {
      cwd: f.directory,
      env: f.env,
      encoding: 'utf8',
      timeout: 20_000,
    });
    assert.equal(output(result).status, 'PASS');
  } finally {
    await f.cleanup();
  }
});
