// Third-party install and test commands run inside bubblewrap: the host is
// read-only, /run and /tmp are empty (no Wayland or X11 socket, no session
// bus), HOME is an empty tmpfs that shows only the toolchains back (no gh,
// Claude, SSH or .netrc credentials, even while the install has network), the
// environment holds only what the grader passes, and only the named
// directories are writable. Every command gets a network namespace of its own:
// the install reaches the internet only through the filtering proxy in
// egress.ts, never a host loopback or private address. Stub URL openers on PATH (no-browser.ts) do not
// stop a real browser binary from starting; the sandbox does.

import { spawnSync } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
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
    '--ro-bind',
    '/',
    '/',
    '--dev',
    '/dev',
    '--proc',
    '/proc',
    '--tmpfs',
    '/tmp',
    '--tmpfs',
    '/run',
  ];
  a.push(...hiddenHome(o.env));
  // Binds come after the tmpfs mounts, so a directory under /tmp or HOME stays visible.
  for (const r of o.readable ?? []) a.push('--ro-bind', resolve(r), resolve(r));
  for (const w of o.writable) a.push('--bind', resolve(w), resolve(w));
  const env = o.egress ? { ...o.env, ...proxyEnv() } : o.env;
  if (o.egress) a.push('--bind', dirname(o.egress), dirname(o.egress));
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
