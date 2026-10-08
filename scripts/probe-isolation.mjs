import { spawnSync } from 'node:child_process';

function check(command, args, label) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    timeout: 5000,
    env: {
      ...process.env,
      XDG_RUNTIME_DIR:
        process.env.XDG_RUNTIME_DIR ??
        `/run/user/${process.getuid?.() ?? 1000}`,
      DBUS_SESSION_BUS_ADDRESS:
        process.env.DBUS_SESSION_BUS_ADDRESS ??
        `unix:path=/run/user/${process.getuid?.() ?? 1000}/bus`,
    },
  });
  if (result.status === 0) return { available: true, reason: '' };
  const detail = result.error?.message ?? result.stderr?.trim();
  return {
    available: false,
    reason: `${label}: ${String(detail || `exit code ${result.status}`).slice(0, 180)}`,
  };
}

export function probeIsolationCapabilities() {
  const bwrap = check(
    'bwrap',
    [
      '--die-with-parent',
      '--ro-bind',
      '/',
      '/',
      '--clearenv',
      '--unshare-net',
      '--unshare-pid',
      '--as-pid-1',
      '--tmpfs',
      '/tmp',
      '--setenv',
      'HOME',
      '/tmp',
      '--setenv',
      'TMPDIR',
      '/tmp',
      '--setenv',
      'PATH',
      '/usr/bin:/bin',
      '--proc',
      '/proc',
      '--dev',
      '/dev',
      '--',
      '/usr/bin/true',
    ],
    'bwrap probe',
  );
  const systemdManager = check(
    'systemctl',
    ['--user', 'show-environment'],
    'systemd user manager probe',
  );
  const systemdScope = check(
    'systemd-run',
    ['--user', '--scope', '--wait', '--quiet', '/usr/bin/true'],
    'systemd transient user scope probe',
  );
  const systemdUserScope =
    systemdManager.available && systemdScope.available
      ? { available: true, reason: '' }
      : {
          available: false,
          reason: [systemdManager.reason, systemdScope.reason]
            .filter(Boolean)
            .join('; '),
        };
  return { bwrap, systemdUserScope };
}

export function formatIsolationProbe(capabilities) {
  const describe = ({ available, reason }) =>
    available ? 'available' : `unavailable (${reason})`;
  return `Isolation capability probe: bwrap=${describe(capabilities.bwrap)}; systemd user scope=${describe(capabilities.systemdUserScope)}`;
}
