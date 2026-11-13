import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('../src/cli/main.ts', import.meta.url));

test('krn --version reports the package version', () => {
  const result = spawnSync(process.execPath, [cli, '--version'], {
    encoding: 'utf8',
  });
  assert.equal(result.status, 0);
  assert.equal(result.stdout, 'krn 0.1.0\n');
});

test('unknown and retired commands exit 64 with a clear stderr message and print nothing to stdout', () => {
  for (const command of [
    'ship',
    'gate',
    'verify',
    'start',
    'delegate',
    'review',
    'worker',
    'eval',
    'brain',
  ]) {
    const result = spawnSync(process.execPath, [cli, command], {
      encoding: 'utf8',
    });
    assert.equal(result.status, 64, command);
    assert.equal(result.stdout, '', command);
    assert.match(result.stderr, new RegExp(`unknown command "${command}"`));
  }
});

test('krn --help lists only the owned commands and exits 0', () => {
  const result = spawnSync(process.execPath, [cli, '--help'], {
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /krn task /);
  assert.doesNotMatch(result.stdout, /legacy|krn ship|krn gate/);
});
