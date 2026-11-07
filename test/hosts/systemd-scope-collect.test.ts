import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import {
  spawnSystemdScope,
  systemdScopeUnit,
} from '../../src/hosts/systemd-scope.ts';
import { requiresIsolation } from '../helpers/isolation.ts';
import { systemdEnvironment } from '../helpers/systemd-environment.ts';

function unitState(unit: string, env: NodeJS.ProcessEnv) {
  const shown = spawnSync(
    'systemctl',
    ['--user', 'show', unit, '-p', 'LoadState', '-p', 'ActiveState'],
    { encoding: 'utf8', env, timeout: 5000 },
  );
  assert.equal(shown.status, 0, shown.stderr);
  return shown.stdout.trim().split('\n').sort().join(' ');
}

test('a launched scope that ends failed leaves no failed unit behind', {
  timeout: 20_000,
}, async (t) => {
  if (!requiresIsolation(t, 'failed scope collection', ['systemdUserScope']))
    return;
  // Regression: scopes that ended failed stayed 'loaded failed' on the user
  // manager (371 krn-* units accumulated) until launches passed --collect.
  const env = systemdEnvironment();
  const unit = systemdScopeUnit('collect-failed');
  // RuntimeMaxSec makes the manager stop the scope with result 'timeout',
  // which without --collect leaves it 'loaded failed'.
  const child = spawnSystemdScope(unit, '/bin/sleep', ['30'], {
    stdio: 'ignore',
    env,
    systemdProperties: ['RuntimeMaxSec=1'],
  });
  try {
    await new Promise((done) => child.once('close', done));
    assert.equal(
      unitState(unit, env),
      'ActiveState=inactive LoadState=not-found',
    );
  } finally {
    spawnSync('systemctl', ['--user', 'reset-failed', unit], {
      env,
      stdio: 'ignore',
    });
  }
});
