import { type SpawnOptions, spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  readSync,
} from 'node:fs';
import { basename, join, resolve } from 'node:path';
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

export type SystemdScopeRegistration = {
  readonly unit: string;
  readonly controlGroup: string;
  readonly pid: number;
  readonly startTicks: string;
};

const registrationSchema = z.object({
  unit: z.string(),
  controlGroup: z.string(),
  pid: z.number().int().positive().safe(),
  startTicks: z.string().regex(/^\d+$/u),
});
const registrationTimeoutMs = 5000;
const registrationDrainQuietMs = 1000;
const cgroupPidByteLimit = 8 * 1024;
const cgroupPidCountLimit = 256;

type SystemdScopeProperties = {
  readonly activeState: string;
  readonly controlGroup: string;
};

function parseSystemdScopeProperties(
  output: string,
): SystemdScopeProperties | undefined {
  const lines = output.split(/\r?\n/u);
  if (lines.at(-1) === '') lines.pop();
  const properties = new Map<string, string>();
  for (const line of lines) {
    const separator = line.indexOf('=');
    if (separator <= 0) return undefined;
    const name = line.slice(0, separator);
    if (
      (name !== 'ActiveState' && name !== 'ControlGroup') ||
      properties.has(name)
    )
      return undefined;
    properties.set(name, line.slice(separator + 1));
  }
  const activeState = properties.get('ActiveState');
  const controlGroup = properties.get('ControlGroup');
  if (
    activeState === undefined ||
    activeState.length === 0 ||
    controlGroup === undefined
  )
    return undefined;
  return { activeState, controlGroup };
}

export function codexScopeUnit(jobId: string, sessionId: string): string {
  const job = jobId.replace(/[^A-Za-z0-9:_.-]/g, '-').slice(0, 80) || 'session';
  if (!/^[A-Za-z0-9-]{1,128}$/u.test(sessionId))
    throw new Error('invalid Codex session id');
  return `krn-${job}-${sessionId}.scope`;
}

export function validateSystemdScopeRegistration(
  value: unknown,
  expectedUnit: string,
): SystemdScopeRegistration | undefined {
  const parsed = registrationSchema.safeParse(value);
  if (!parsed.success || parsed.data.unit !== expectedUnit) return undefined;
  if (!registrationCgroupPath(parsed.data.controlGroup, expectedUnit))
    return undefined;
  return parsed.data;
}

function registrationCgroupPath(
  controlGroup: string,
  expectedUnit: string,
): string | undefined {
  const components = controlGroup.split('/');
  if (
    !controlGroup.startsWith('/') ||
    controlGroup.startsWith('//') ||
    components.length <= 1 ||
    components
      .slice(1)
      .some(
        (component) =>
          component === '.' ||
          component === '..' ||
          !/^[A-Za-z0-9_.:@-]+$/u.test(component),
      ) ||
    basename(controlGroup) !== expectedUnit
  )
    return undefined;
  const cgroupRoot = '/sys/fs/cgroup';
  const path = resolve(cgroupRoot, controlGroup.slice(1));
  return path.startsWith(`${cgroupRoot}/`) ? path : undefined;
}

export async function waitForSystemdScopeRegistration(
  unit: string,
  shouldStop: () => boolean,
): Promise<SystemdScopeRegistration> {
  const deadline = Date.now() + registrationTimeoutMs;
  const env = userManagerEnvironment();
  while (Date.now() < deadline) {
    if (shouldStop())
      throw new Error('Codex startup cancelled before registration');
    const registration = observeSystemdScopeRegistration(unit, env);
    if (registration) return registration;
    await new Promise((done) => setTimeout(done, 20));
  }
  throw new Error(`systemd scope ${unit} did not register a live process`);
}

export async function drainSystemdScope(
  unit: string,
  env: NodeJS.ProcessEnv = userManagerEnvironment(),
  registration?: SystemdScopeRegistration,
): Promise<void> {
  const original = registration ?? observeSystemdScopeRegistration(unit, env);
  const deadline = Date.now() + 7000;
  let quietSince: number | undefined;
  while (Date.now() < deadline) {
    const active = systemdScopeActive(unit, env, original);
    if (active === null) {
      // A failed readback cannot establish that the owned scope is empty.
      // Still request termination of its exact unit before refusing cleanup;
      // the caller must continue to treat the drain as unverified.
      if (/^krn-[A-Za-z0-9:_.@-]+\.scope$/u.test(unit)) {
        spawnSync(
          'systemctl',
          ['--user', 'kill', '--kill-who=all', '--signal=SIGKILL', unit],
          { encoding: 'utf8', env, timeout: 5000 },
        );
      }
      throw new Error(`cannot verify systemd scope ${unit} drain state`);
    }
    if (active) {
      quietSince = undefined;
      await killAndVerifyScope(unit, env, original);
    } else {
      quietSince ??= Date.now();
      if (Date.now() - quietSince >= registrationDrainQuietMs) return;
    }
    await new Promise((done) => setTimeout(done, 20));
  }
  throw new Error(`systemd scope ${unit} did not remain drained`);
}

export function processStartTicks(pid: number): string | undefined {
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

export function processHasIdentity(pid: number, startTicks: string): boolean {
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

type CgroupProcesses =
  | { readonly kind: 'observed'; readonly pids: readonly number[] }
  | { readonly kind: 'limit' };

function readCgroupProcesses(path: string): CgroupProcesses | undefined {
  let fd: number | undefined;
  let result: CgroupProcesses | undefined;
  let failed = false;
  let vanished = false;
  try {
    fd = openSync(path, 'r');
    const buffer = Buffer.alloc(cgroupPidByteLimit + 1);
    let offset = 0;
    let readAttempts = 0;
    while (offset < buffer.length) {
      if (readAttempts >= buffer.length + 1) {
        failed = true;
        break;
      }
      readAttempts += 1;
      let count: number;
      try {
        count = readSync(fd, buffer, offset, buffer.length - offset, null);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === 'EINTR') continue;
        // A cgroup removed between open and read reports ENODEV: it is gone.
        if (code === 'ENODEV' || code === 'ENOENT') {
          vanished = true;
          break;
        }
        failed = true;
        break;
      }
      if (count === 0) break;
      offset += count;
    }
    if (vanished) result = { kind: 'observed', pids: [] };
    else if (!failed) {
      if (offset > cgroupPidByteLimit) result = { kind: 'limit' };
      else {
        const fields = buffer
          .toString('utf8', 0, offset)
          .trim()
          .split(/\s+/u)
          .filter(Boolean);
        if (fields.length > cgroupPidCountLimit) result = { kind: 'limit' };
        else {
          const pids: number[] = [];
          for (const field of fields) {
            const pid = Number(field);
            if (
              !/^\d+$/u.test(field) ||
              !Number.isSafeInteger(pid) ||
              pid <= 0
            ) {
              failed = true;
              break;
            }
            pids.push(pid);
          }
          if (!failed) result = { kind: 'observed', pids };
        }
      }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT')
      result = { kind: 'observed', pids: [] };
    else failed = true;
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        failed = true;
      }
    }
  }
  return failed ? undefined : result;
}

function observeSystemdScopeRegistration(
  unit: string,
  env: NodeJS.ProcessEnv,
): SystemdScopeRegistration | undefined {
  const shown = spawnSync(
    'systemctl',
    [
      '--user',
      'show',
      '--property=ActiveState',
      '--property=ControlGroup',
      '--no-pager',
      unit,
    ],
    { encoding: 'utf8', env, timeout: 1000 },
  );
  if (shown.error || shown.status !== 0) return undefined;
  const properties = parseSystemdScopeProperties(shown.stdout);
  if (!properties) return undefined;
  const { activeState: state, controlGroup } = properties;
  if (state !== 'active' && state !== 'activating' && state !== 'reloading')
    return undefined;
  const cgroupPath = registrationCgroupPath(controlGroup, unit);
  if (!cgroupPath) return undefined;
  const cgroupProcs = join(cgroupPath, 'cgroup.procs');
  const membership = readCgroupProcesses(cgroupProcs);
  if (!membership || membership.kind !== 'observed') return undefined;
  for (const pid of membership.pids) {
    const startTicks = processStartTicks(pid);
    if (!startTicks || !processHasIdentity(pid, startTicks)) continue;
    const stillPresent = readCgroupProcesses(cgroupProcs);
    if (
      !stillPresent ||
      stillPresent.kind !== 'observed' ||
      !stillPresent.pids.includes(pid) ||
      !processHasIdentity(pid, startTicks)
    )
      continue;
    return { unit, controlGroup, pid, startTicks };
  }
  return undefined;
}

const ownerDescription = /^krn-codex-owner-v1:(\d+):(\d+):(\d+)$/u;
const scopeListSchema = z.array(
  z.object({
    unit: z.string(),
    active: z.string(),
    description: z.string(),
  }),
);
export const codexScopeRuntimeGraceMs = 3000;

function codexScopeOwnerDescription(): string {
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

function ownerProcessIsAlive(pid: number, startTicks: string): boolean {
  return processHasIdentity(pid, startTicks);
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
  registration?: SystemdScopeRegistration,
): Promise<void> {
  const original = registration ?? observeSystemdScopeRegistration(unit, env);
  const killed = spawnSync(
    'systemctl',
    ['--user', 'kill', '--kill-whom=all', '--signal=SIGKILL', unit],
    { encoding: 'utf8', env, timeout: 5000 },
  );
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const active = systemdScopeActive(unit, env, original);
    if (active === false) return;
    if (active === null)
      throw new Error(`cannot verify systemd scope ${unit} drain state`);
    await new Promise((done) => setTimeout(done, 20));
  }
  const detail = killed.error?.message ?? killed.stderr.trim();
  throw new Error(
    `systemd scope ${unit} did not become empty: ${detail || 'original cgroup or process remains live'}`,
  );
}

function systemdScopeRegistrationActive(
  registration: SystemdScopeRegistration,
): boolean | null {
  const validated = validateSystemdScopeRegistration(
    registration,
    registration.unit,
  );
  if (!validated) return null;
  const path = registrationCgroupPath(validated.controlGroup, validated.unit);
  if (!path) return null;
  let populated: boolean;
  try {
    const events = readFileSync(join(path, 'cgroup.events'), 'utf8');
    const match = /^populated ([01])$/mu.exec(events);
    if (!match) return null;
    populated = match[1] === '1';
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT' && code !== 'ENODEV') return null;
    populated = false;
  }
  // A live original PID outside a removed/empty group is not verified cleanup.
  try {
    const stat = readFileSync(`/proc/${validated.pid}/stat`, 'utf8');
    const fields = stat
      .slice(stat.lastIndexOf(')') + 2)
      .trim()
      .split(/\s+/u);
    if (fields.length < 20 || !/^\d+$/u.test(fields[19] ?? '')) return null;
    if (
      fields[0] !== 'Z' &&
      fields[0] !== 'X' &&
      fields[19] === validated.startTicks
    )
      return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return null;
  }
  return populated;
}

export function systemdScopeActive(
  unit: string,
  env: NodeJS.ProcessEnv = userManagerEnvironment(),
  registration?: SystemdScopeRegistration,
): boolean | null {
  if (registration && !validateSystemdScopeRegistration(registration, unit))
    return null;
  const shown = spawnSync(
    'systemctl',
    [
      '--user',
      'show',
      '-p',
      'ActiveState',
      '-p',
      'ControlGroup',
      '--no-pager',
      unit,
    ],
    { encoding: 'utf8', env, timeout: 3000 },
  );
  const originalActive =
    registration?.unit === unit
      ? systemdScopeRegistrationActive(registration)
      : undefined;
  if (shown.error || shown.status !== 0) {
    const detail = `${shown.stderr}\n${shown.stdout}`;
    if (
      !shown.error &&
      shown.status !== null &&
      shown.stdout.length === 0 &&
      /not loaded|not found|could not be found/i.test(detail)
    )
      return originalActive ?? null;
    return null;
  }
  const properties = parseSystemdScopeProperties(shown.stdout);
  if (!properties) return null;
  if (originalActive === true || originalActive === null) return originalActive;
  const { activeState: state, controlGroup } = properties;
  if (
    controlGroup &&
    (!controlGroup.startsWith('/') || controlGroup.split('/').includes('..'))
  )
    return null;
  const membership = controlGroup
    ? readCgroupProcesses(
        join('/sys/fs/cgroup', controlGroup.slice(1), 'cgroup.procs'),
      )
    : { kind: 'observed' as const, pids: [] };
  if (
    membership?.kind === 'limit' ||
    (membership?.kind === 'observed' && membership.pids.length > 0) ||
    state === 'active' ||
    state === 'activating' ||
    state === 'reloading'
  )
    return true;
  if (!membership) return null;
  return state === 'inactive' || state === 'failed' ? false : null;
}
