import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { main } from '../../src/hook/stop.ts';

test('stop --check reports the path of the full output it saved', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'stop-check-log-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const git = (...args: string[]) => {
    const result = spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
  };
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'review@example.test');
  git('config', 'user.name', 'Review');
  writeFileSync(
    join(dir, 'krn.json'),
    JSON.stringify({
      base: 'main',
      test: "if grep -q 'x = 2' a.py; then echo FAIL test_a.py; exit 1; fi",
    }),
  );
  writeFileSync(join(dir, 'a.py'), 'x = 1\n');
  git('add', '.');
  git('commit', '-qm', 'base');
  git('switch', '-qc', 'work');
  writeFileSync(join(dir, 'a.py'), 'x = 2\n');
  git('commit', '-qam', 'change');

  const originalArg = process.argv[2];
  const originalEnv = process.env;
  const originalExitCode = process.exitCode;
  process.argv[2] = '--check';
  process.env = {
    ...originalEnv,
    CLAUDE_PROJECT_DIR: dir,
    KRN_TEST_FIRST: '0',
    KRN_ACCEPTANCE_CLAUSES: '0',
    KRN_TEST_SLOT_HELD: '1',
  };
  let output = '';
  const write = (chunk: string) => {
    output += chunk;
    return true;
  };
  const stdout = t.mock.method(process.stdout, 'write', write);
  const stderr = t.mock.method(process.stderr, 'write', write);
  try {
    main();
    assert.equal(process.exitCode, 1, output);
  } finally {
    stdout.mock.restore();
    stderr.mock.restore();
    if (originalArg === undefined) process.argv.length = 2;
    else process.argv[2] = originalArg;
    process.env = originalEnv;
    process.exitCode = originalExitCode;
  }
  assert.match(output, /stop FAIL:.*related test\(s\) fail/u);
  const logDir = join(dir, '.krn', 'runs', 'stop-check');
  const logs = readdirSync(logDir).filter((file) =>
    /^\d+-\d+\.log$/u.test(file),
  );
  assert.equal(logs.length, 1);
  assert.ok(output.includes(join(logDir, logs[0] ?? '')), output);
});
