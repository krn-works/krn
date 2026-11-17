// Third-party install and test commands run inside bubblewrap: the host is
// read-only, /run and /tmp are empty (no Wayland or X11 socket, no session
// bus), the environment holds only what the grader passes, and only the named
// directories are writable. Stub URL openers on PATH (no-browser.ts) do not
// stop a real browser binary from starting; the sandbox does.

import { spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';

export interface SandboxOptions {
  /** Directory the command starts in. */
  cwd: string;
  /** The only host paths the command may write. */
  writable: readonly string[];
  /** Network for the install phase; the test phase runs offline. */
  net: boolean;
  /** The complete environment the command sees. */
  env: NodeJS.ProcessEnv;
}

/** The refusal when bubblewrap cannot start: grading never falls back to an unsandboxed run. */
export function requireSandbox(): void {
  const r = spawnSync(
    'bwrap',
    sandboxArgv('true', { cwd: '/', writable: [], net: false, env: {} }),
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
    ...(o.net ? ['--share-net'] : []),
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
  // /etc/resolv.conf usually links into /run, which the tmpfs above hides: name resolution needs its target back.
  const resolv = resolvTarget();
  if (o.net && resolv.startsWith('/run/')) a.push('--ro-bind', resolv, resolv);
  // Binds come after the tmpfs mounts, so a writable directory under /tmp stays visible.
  for (const w of o.writable) a.push('--bind', resolve(w), resolve(w));
  a.push('--chdir', resolve(o.cwd), '--clearenv');
  for (const [k, v] of Object.entries(o.env))
    if (v !== undefined) a.push('--setenv', k, v);
  a.push('--', 'sh', '-c', cmd);
  return a;
}

function resolvTarget(): string {
  try {
    return realpathSync('/etc/resolv.conf');
  } catch {
    return '';
  }
}
