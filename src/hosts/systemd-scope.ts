import { type SpawnOptions, spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

let scopesAvailableFor: string | undefined;

export function userManagerEnvironment(
  source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const env = { ...source };
  const uid = process.getuid?.();
  if (uid === undefined) return env;
  const runtime = env.XDG_RUNTIME_DIR ?? `/run/user/${uid}`;
  const bus = join(runtime, 'bus');
  if (!env.XDG_RUNTIME_DIR && existsSync(runtime))
    env.XDG_RUNTIME_DIR = runtime;
  if (!env.DBUS_SESSION_BUS_ADDRESS && existsSync(bus))
    env.DBUS_SESSION_BUS_ADDRESS = `unix:path=${bus}`;
  return env;
}

export function systemdScopeUnit(prefix: string): string {
  const safePrefix = prefix.replace(/[^A-Za-z0-9:_.-]/g, '-').slice(0, 64);
  return `krn-${safePrefix || 'scope'}-${randomUUID()}.scope`;
}

export function assertSystemdUserScopesAvailable(
  refusalMessage = 'systemd user scopes are unavailable; refusing to launch',
): void {
  const availabilityKey = [
    process.env.PATH ?? '',
    process.env.XDG_RUNTIME_DIR ?? '',
    process.env.DBUS_SESSION_BUS_ADDRESS ?? '',
  ].join('\0');
  if (scopesAvailableFor === availabilityKey) return;
  if (process.platform !== 'linux')
    throw new Error('systemd scope isolation requires Linux');
  const unit = systemdScopeUnit('probe');
  const result = spawnSync(
    'systemd-run',
    ['--user', '--scope', '--unit', unit, '--quiet', '/bin/true'],
    { stdio: 'ignore', timeout: 5000, env: userManagerEnvironment() },
  );
  if (result.error || result.status !== 0) throw new Error(refusalMessage);
  scopesAvailableFor = availabilityKey;
}

export function spawnSystemdScope(
  unit: string,
  executable: string,
  args: readonly string[],
  options: SpawnOptions = {},
) {
  assertSystemdUserScopesAvailable();
  if (!/^[A-Za-z0-9:_.@-]+\.scope$/.test(unit))
    throw new Error('invalid systemd scope unit name');
  const { env = process.env, ...spawnOptions } = options;
  return spawn(
    'systemd-run',
    ['--user', '--scope', '--unit', unit, '--quiet', executable, ...args],
    {
      ...spawnOptions,
      shell: false,
      env: userManagerEnvironment(env),
    },
  );
}

export async function killAndVerifyScope(
  unit: string,
  env: NodeJS.ProcessEnv = userManagerEnvironment(),
): Promise<void> {
  const killed = spawnSync(
    'systemctl',
    ['--user', 'kill', '--kill-whom=all', '--signal=SIGKILL', unit],
    { encoding: 'utf8', env, timeout: 5000 },
  );
  const deadline = Date.now() + 5000;
  let lastError = killed.error?.message ?? killed.stderr.trim();
  while (Date.now() < deadline) {
    const shown = spawnSync(
      'systemctl',
      ['--user', 'show', '--property=ControlGroup', '--value', unit],
      { encoding: 'utf8', env, timeout: 3000 },
    );
    if (shown.status !== 0) {
      const detail = `${shown.stderr}\n${shown.stdout}`;
      if (/not loaded|not found|could not be found/i.test(detail)) return;
      throw new Error(`cannot verify systemd scope ${unit}: ${detail.trim()}`);
    }
    const controlGroup = shown.stdout.trim();
    if (!controlGroup) return;
    if (!controlGroup.startsWith('/') || controlGroup.split('/').includes('..'))
      throw new Error(`systemd returned an invalid cgroup path for ${unit}`);
    const cgroup = resolve('/sys/fs/cgroup', controlGroup.slice(1));
    try {
      const events = readFileSync(join(cgroup, 'cgroup.events'), 'utf8');
      if (/^populated 0$/m.test(events)) return;
      lastError = `cgroup ${controlGroup} remains populated`;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    await new Promise((done) => setTimeout(done, 20));
  }
  if (killed.status !== 0 && !lastError)
    lastError = killed.stderr || 'systemd kill command failed';
  throw new Error(`systemd scope ${unit} did not become empty: ${lastError}`);
}
