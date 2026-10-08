import { type SpawnOptions, spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { z } from 'zod';

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

export type ReapedSystemdScope = {
  readonly unit: string;
  readonly ownerPid: number;
  readonly ownerStartTicks: string;
};

const ownerDescription = /^krn-codex-owner-v1:(\d+):(\d+):(\d+)$/u;
const scopeListSchema = z.array(
  z.object({
    unit: z.string(),
    active: z.string(),
    description: z.string(),
  }),
);
export const codexScopeRuntimeGraceMs = 3000;

export function codexScopeOwnerDescription(): string {
  const uid = process.getuid?.();
  if (uid === undefined)
    throw new Error('Codex systemd scope owner requires a process uid');
  const startTicks = processStartTicks(process.pid);
  if (!startTicks)
    throw new Error('cannot establish Codex scope owner identity');
  return `krn-codex-owner-v1:${uid}:${process.pid}:${startTicks}`;
}

export async function reapOrphanedCodexScopes(): Promise<ReapedSystemdScope[]> {
  assertSystemdUserScopesAvailable();
  const uid = process.getuid?.();
  if (uid === undefined) return [];
  const env = userManagerEnvironment();
  const listed = spawnSync(
    'systemctl',
    [
      '--user',
      'list-units',
      '--all',
      '--type=scope',
      '--no-pager',
      '--output=json',
    ],
    { encoding: 'utf8', env, timeout: 5000, maxBuffer: 1024 * 1024 },
  );
  if (listed.error || listed.status !== 0)
    throw (
      listed.error ?? new Error(listed.stderr || 'cannot list Codex scopes')
    );
  const scopes = scopeListSchema.parse(JSON.parse(listed.stdout) as unknown);
  const reaped: ReapedSystemdScope[] = [];
  for (const { unit, active, description } of scopes) {
    if (!unit?.startsWith('krn-') || !unit.endsWith('.scope')) continue;
    if (active !== 'active' && active !== 'activating') continue;
    const match = ownerDescription.exec(description);
    if (!match?.[1] || !match[2] || !match[3] || Number(match[1]) !== uid)
      continue;
    const ownerPid = Number(match[2]);
    const ownerStartTicks = match[3];
    if (ownerProcessIsAlive(ownerPid, ownerStartTicks)) continue;
    await killAndVerifyScope(unit, env);
    reaped.push({ unit, ownerPid, ownerStartTicks });
  }
  return reaped;
}

export function codexScopeRuntimeProperties(
  timeoutMs: number,
): readonly string[] {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0)
    throw new Error('Codex session timeout must be a positive safe integer');
  return [
    `RuntimeMaxSec=${timeoutMs + codexScopeRuntimeGraceMs}ms`,
    'KillMode=control-group',
    'KillSignal=SIGKILL',
    'SendSIGKILL=yes',
    `Description=${codexScopeOwnerDescription()}`,
  ];
}

function processStartTicks(pid: number): string | undefined {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const fields = stat
      .slice(stat.lastIndexOf(')') + 2)
      .trim()
      .split(/\s+/u);
    return fields[19];
  } catch {
    return undefined;
  }
}

function ownerProcessIsAlive(pid: number, startTicks: string): boolean {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const fields = stat
      .slice(stat.lastIndexOf(')') + 2)
      .trim()
      .split(/\s+/u);
    return fields[0] !== 'Z' && fields[0] !== 'X' && fields[19] === startTicks;
  } catch {
    return false;
  }
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
  options: SpawnOptions & {
    readonly systemdProperties?: readonly string[];
  } = {},
) {
  assertSystemdUserScopesAvailable();
  if (!/^[A-Za-z0-9:_.@-]+\.scope$/.test(unit))
    throw new Error('invalid systemd scope unit name');
  const {
    env = process.env,
    systemdProperties = [],
    ...spawnOptions
  } = options;
  return spawn(
    'systemd-run',
    [
      '--user',
      '--scope',
      '--unit',
      unit,
      '--quiet',
      ...systemdProperties.map((property) => `--property=${property}`),
      executable,
      ...args,
    ],
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
