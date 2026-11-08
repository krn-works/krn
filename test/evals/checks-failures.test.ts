import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { requiresIsolation } from '../helpers/isolation.ts';
import { digest, fixture, output } from './checks-fixture.ts';

test('eval check refuses empty selections and failing assertions', async (t) => {
  if (!requiresIsolation(t, t.name, ['bwrap'])) return;
  const f = await fixture();
  try {
    f.task.scripts.test = 'node --test';
    f.task.focusedCheck = [
      'npm',
      'run',
      'test',
      '--',
      '--test-name-pattern=absent',
      'behavior.test.cjs',
    ];
    await f.save();
    const empty = output(f.run());
    assert.equal(empty.status, 'FAIL');
    assert.equal(empty.reason, 'no tests executed');
    f.task.focusedCheck = ['npm', 't'];
    await f.testFile(
      "require('node:test')('failure', () => require('node:assert/strict').equal(1, 2));\n",
    );
    await f.save();
    const failing = output(f.run());
    assert.equal(failing.status, 'FAIL');
    assert.equal(failing.exitCode, 1);
    assert.equal(failing.fail, 1);
  } finally {
    await f.cleanup();
  }
});

test('eval check timeout kills detached descendants and remains a failure after passing TAP', async (t) => {
  if (!requiresIsolation(t, t.name, ['bwrap'])) return;
  const f = await fixture();
  try {
    const marker = `eval-child-${digest(f.directory).slice(0, 20)}`;
    f.task.focusedCheck = [
      'node',
      '-e',
      `require('node:child_process').spawn(process.execPath, ['-e', "require('node:fs').writeFileSync('child-started', 'ready'); setInterval(()=>{},1000)", '${marker}'], {detached:true,stdio:'ignore'}); console.log('# tests 1\\n# pass 1\\n# fail 0'); setInterval(()=>{},1000);`,
    ];
    await f.save();
    const child = spawn(process.execPath, f.args(['--timeout', '2']), {
      env: f.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '',
      stderr = '';
    child.stdout.on('data', (bytes) => {
      stdout += bytes;
    });
    child.stderr.on('data', (bytes) => {
      stderr += bytes;
    });
    const code = await new Promise((resolve, reject) => {
      child.on('error', reject);
      child.on('close', resolve);
    });
    assert.equal(code, 0, stderr);
    const result = JSON.parse(stdout);
    assert.equal(result.status, 'FAIL');
    assert.equal(result.reason, 'timeout');
    assert.equal(result.exitCode, 137);
    assert.equal(await readFile(join(f.cwd, 'child-started'), 'utf8'), 'ready');
    const deadline = Date.now() + 5000;
    for (;;) {
      const ps = spawnSync('ps', ['-eo', 'args='], { encoding: 'utf8' });
      assert.equal(ps.status, 0, ps.stderr);
      if (!ps.stdout.includes(marker)) break;
      assert.ok(Date.now() < deadline, 'no descendant may survive the timeout');
      await new Promise((resolve) => setImmediate(resolve));
    }
  } finally {
    await f.cleanup();
  }
});
