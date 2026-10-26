import assert from 'node:assert/strict';
import { test } from 'node:test';
import { systemdEnvironment } from './systemd-environment.ts';

test('derives a D-Bus endpoint from the supplied runtime directory', () => {
  const env = systemdEnvironment({ XDG_RUNTIME_DIR: '/runtime/worker' });

  assert.equal(env.XDG_RUNTIME_DIR, '/runtime/worker');
  assert.equal(env.DBUS_SESSION_BUS_ADDRESS, 'unix:path=/runtime/worker/bus');
});

test('keeps an explicitly supplied D-Bus endpoint', () => {
  const env = systemdEnvironment({
    XDG_RUNTIME_DIR: '/runtime/worker',
    DBUS_SESSION_BUS_ADDRESS: 'unix:path=/custom/bus',
  });

  assert.equal(env.DBUS_SESSION_BUS_ADDRESS, 'unix:path=/custom/bus');
});
