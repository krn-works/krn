// Third-party install and test commands run inside bubblewrap: only the system
// directories, the toolchain and the named directories are mounted (other
// host paths, such as sibling checkouts, do not exist), /run and /tmp are empty (no Wayland or X11 socket, no session
// bus), HOME is an empty tmpfs that shows only the toolchains back (no gh,
// Claude, SSH or .netrc credentials, even while the install has network), the
// environment holds only what the grader passes, and only the named
// directories are writable. Every command gets a network namespace of its own:
// the install reaches the internet only through the filtering proxy in
// egress.ts, never a host loopback or private address. Stub URL openers on PATH (no-browser.ts) do not
// stop a real browser binary from starting; the sandbox does.

import { spawnSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  readlinkSync,
  realpathSync,
  type Stats,
} from 'node:fs';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { FORWARDER, proxyEnv, SANDBOX_PROXY_PORT } from './egress.ts';

export interface SandboxOptions {
  /** Directory the command starts in. */
  cwd: string;
  /** The only host paths the command may write. */
  writable: readonly string[];
  /** Host paths shown read-only that the hidden HOME or the empty /tmp would otherwise hide (a binary's directory). */
  readable?: readonly string[];
  /**
   * Internet for the install phase, through the egress.ts proxy listening on this unix socket; the test phase runs
   * offline. There is no host-network mode: the host namespace would expose every loopback listener.
   */
  egress?: string;
  /** The complete environment the command sees. */
  env: NodeJS.ProcessEnv;
}

/** The refusal when bubblewrap cannot start: grading never falls back to an unsandboxed run. */
export function requireSandbox(): void {
  const r = spawnSync(
    'bwrap',
    sandboxArgv('true', { cwd: '/', writable: [], env: {} }),
    { encoding: 'utf8', timeout: 10_000 },
  );
  if (r.status === 0) return;
  const why = r.error?.message ?? (r.stderr.trim() || `exit ${r.status}`);
  throw new Error(
    `screening refuses to run third-party code without bubblewrap (bwrap): ${why}; install bubblewrap and allow unprivileged user namespaces`,
  );
}

/** The bwrap arguments that run `sh -c cmd` under `o`. */
export function sandboxArgv(cmd: string, o: SandboxOptions): string[] {
  const a = [
    '--unshare-all',
    '--die-with-parent',
    '--new-session',
    '--dev',
    '/dev',
    '--proc',
    '/proc',
    '--tmpfs',
    '/tmp',
    '--tmpfs',
    '/run',
  ];
  a.push(...systemRoots(), ...pathRoots(o.env));
  a.push(...hiddenHome(o.env));
  // Binds come after the tmpfs mounts, so a directory under /tmp or HOME stays visible.
  for (const r of o.readable ?? []) a.push('--ro-bind', resolve(r), resolve(r));
  for (const w of o.writable) a.push('--bind', resolve(w), resolve(w));
  const env = o.egress ? { ...o.env, ...proxyEnv() } : o.env;
  if (o.egress) {
    a.push('--bind', dirname(o.egress), dirname(o.egress));
    // The forwarder script is the one repository file the sandbox runs; the rest of the checkout stays unmounted.
    a.push('--ro-bind', FORWARDER, FORWARDER);
  }
  a.push('--chdir', resolve(o.cwd), '--clearenv');
  for (const [k, v] of Object.entries(env))
    if (v !== undefined) a.push('--setenv', k, v);
  if (o.egress)
    a.push(
      '--',
      process.execPath,
      FORWARDER,
      o.egress,
      String(SANDBOX_PROXY_PORT),
      cmd,
    );
  else a.push('--', 'sh', '-c', cmd);
  return a;
}

/** The system directories a toolchain needs; every other host path stays unmounted unless named. */
const SYSTEM_DIRS = [
  '/usr',
  '/bin',
  '/sbin',
  '/lib',
  '/lib32',
  '/lib64',
  '/etc',
  '/opt',
];

/** Read-only binds (or symlinks, as on merged-usr hosts) for the system directories; nothing else of the host root. */
function systemRoots(): string[] {
  const a: string[] = [];
  for (const d of SYSTEM_DIRS) {
    let st: Stats;
    try {
      st = lstatSync(d);
    } catch {
      continue;
    }
    if (st.isSymbolicLink()) a.push('--symlink', readlinkSync(d), d);
    else if (st.isDirectory()) a.push('--ro-bind', d, d);
  }
  return a;
}

/** PATH entries and the running node's directory outside the system directories and HOME (HOME is handled apart). */
function pathRoots(env: NodeJS.ProcessEnv): string[] {
  const home = env.HOME ? realOr(env.HOME) : undefined;
  const a: string[] = [];
  const seen: string[] = [];
  const dirs = [...(env.PATH ?? '').split(':'), dirname(process.execPath)];
  for (const w of dirs) {
    if (!w || !isAbsolute(w) || !existsSync(w)) continue;
    const p = realOr(resolve(w));
    if (home && under(p, home)) continue;
    if (SYSTEM_DIRS.some((d) => under(p, d) || under(w, d))) continue;
    if (seen.some((k) => under(p, k))) continue;
    seen.push(p);
    a.push('--ro-bind', p, p);
  }
  return a;
}

const under = (p: string, dir: string) => p === dir || p.startsWith(dir + sep);

/**
 * The directories under HOME a command still sees, read-only: the mise data and config directories and every PATH
 * entry inside HOME, so toolchains and their shims run while credential files stay hidden.
 */
export function homeToolchains(env: NodeJS.ProcessEnv): string[] {
  const home = env.HOME;
  if (!home) return [];
  const wanted = [
    env.MISE_DATA_DIR ?? join(home, '.local', 'share', 'mise'),
    env.MISE_CONFIG_DIR ?? join(home, '.config', 'mise'),
    ...(env.PATH ?? '').split(':').filter(Boolean),
  ];
  const real = realOr(home);
  const keep: string[] = [];
  for (const w of wanted) {
    if (!existsSync(w)) continue;
    const p = realOr(resolve(w));
    if (p === real || !under(p, real) || keep.some((k) => under(p, k)))
      continue;
    for (let i = keep.length - 1; i >= 0; i--)
      if (under(keep[i] as string, p)) keep.splice(i, 1);
    keep.push(p);
  }
  return keep;
}

/** Hides the host HOME behind an empty tmpfs and binds the toolchains back read-only. */
function hiddenHome(env: NodeJS.ProcessEnv): string[] {
  if (!env.HOME || !existsSync(env.HOME)) return [];
  const home = realOr(env.HOME);
  const a = ['--tmpfs', home];
  for (const k of homeToolchains(env)) a.push('--ro-bind', k, k);
  return a;
}

function realOr(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}
