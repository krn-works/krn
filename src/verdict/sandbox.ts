// Disposable worktrees execute base-declared checks under bwrap and a systemd scope. ADR 0001.
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
// biome-ignore format: These filesystem primitives form the sandbox's owned I/O surface.
import { closeSync, constants, existsSync, lstatSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, realpathSync, rmSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { z } from 'zod';
import type { Job } from '../core/index.ts';
import { stateDirectory } from '../foreman/state.ts';
import type { CheckEvidence } from './index.ts';

// biome-ignore format: Share the fixed process limits across sandbox metadata commands.
function run(file: string, args: string[], cwd: string, timeout = 15000, env = sandboxEnv()) {
  return spawnSync(file, args, { cwd, encoding: 'utf8', env, timeout, maxBuffer: 1024 * 1024 });
}

// biome-ignore format: Output bytes stay intact for diagnostic hashing.
function runOutput(file: string, args: string[], cwd: string, timeout: number, env: NodeJS.ProcessEnv) {
  return spawnSync(file, args, { cwd, encoding: 'buffer', env, timeout, maxBuffer: 1024 * 1024 });
}

// biome-ignore format: This is the complete allowlisted child environment.
function sandboxEnv(extraPath?: string): NodeJS.ProcessEnv {
  return { PATH: [dirname(process.execPath), extraPath, '/usr/bin', '/bin'].filter((path): path is string => Boolean(path)).join(':'), LANG: 'C', LC_ALL: 'C', HOME: '/tmp/krn-home', TMPDIR: '/tmp/krn-home' };
}

function pnpmBinary(copy: string): string {
  const manifest = JSON.parse(
    readFileSync(join(copy, 'package.json'), 'utf8'),
  ) as { readonly packageManager?: string };
  const manager = z
    .string()
    .regex(/^pnpm@\d+\.\d+\.\d+$/)
    .parse(manifest.packageManager);
  // biome-ignore format: Toolchain lookup is one process boundary.
  const result = spawnSync('mise', ['where', manager], { cwd: tmpdir(), encoding: 'utf8', env: { PATH: process.env.PATH, HOME: process.env.HOME } });
  if (result.error || result.status !== 0 || !result.stdout.trim())
    throw (
      result.error ?? new Error(result.stderr || `cannot locate ${manager}`)
    );
  const executable = join(result.stdout.trim(), 'pnpm');
  if (!existsSync(executable)) throw new Error(`missing ${manager} executable`);
  return executable;
}

function pnpmStore(pnpm: string, cwd: string): string {
  // biome-ignore format: Store lookup is one process boundary.
  const result = spawnSync(pnpm, ['store', 'path'], { cwd, encoding: 'utf8', env: { PATH: process.env.PATH, HOME: process.env.HOME } });
  if (result.error || result.status !== 0 || !result.stdout.trim())
    throw (
      result.error ??
      new Error(result.stderr || 'cannot locate the pnpm content store')
    );
  return result.stdout.trim();
}

function git(root: string, args: string[]): string {
  const result = run('git', ['-C', root, ...args], root);
  if (result.error || result.status !== 0)
    throw result.error ?? new Error(result.stderr || 'git command failed');
  return result.stdout.trim();
}

function registeredWorktrees(root: string): string[] {
  // biome-ignore format: Keep the exact worktree inventory command together.
  const result = run('git', ['-C', root, 'worktree', 'list', '--porcelain'], root);
  if (result.error || result.status !== 0)
    throw result.error ?? new Error(result.stderr || 'cannot list worktrees');
  return result.stdout
    .split(/\r?\n/u)
    .filter((line) => line.startsWith('worktree '))
    .map((line) => resolve(line.slice('worktree '.length)));
}

export function pruneExactWorktree(root: string, copy: string): void {
  const exactPath = resolve(copy);
  // biome-ignore format: Keep removal bound to the resolved disposable path.
  const removed = run('git', ['-C', root, 'worktree', 'remove', '--force', exactPath], root);

  // `git worktree prune` has no path argument. Remove only the administrative
  // record whose gitdir points at this disposable worktree if remove left it.
  if (registeredWorktrees(root).includes(exactPath)) {
    // biome-ignore format: Resolve the exact common git directory for this worktree.
    const commonDir = resolve(root, git(root, ['rev-parse', '--git-common-dir']));
    const adminRoot = join(commonDir, 'worktrees');
    if (existsSync(adminRoot)) {
      for (const name of readdirSync(adminRoot)) {
        const admin = join(adminRoot, name);
        const pointer = join(admin, 'gitdir');
        if (!existsSync(pointer)) continue;
        if (
          resolve(readFileSync(pointer, 'utf8').trim()) !==
          join(exactPath, '.git')
        )
          continue;
        rmSync(admin, { recursive: true, force: true });
        break;
      }
    }
  }
  if (registeredWorktrees(root).includes(exactPath))
    throw (
      removed.error ??
      new Error(`could not prune verdict worktree ${exactPath}`)
    );
  rmSync(exactPath, { recursive: true, force: true });
}

// biome-ignore format: Directory creation is the first tracked cleanup step.
export function createWorktreeDirectory(directory: string): string { return mkdtempSync(join(directory, 'verdict-')); }

// biome-ignore format: Attach the allocated directory to the exact checked SHA.
export function addWorktree(root: string, copy: string, sha: string): void { git(root, ['worktree', 'add', '--detach', copy, sha]); }

// biome-ignore format: Keep the cleanup boundary signature compact.
export function cleanupWorktrees(root: string, copies: readonly string[]): void {
  const errors: unknown[] = [];
  for (const copy of copies) {
    try {
      pruneExactWorktree(root, copy);
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length) {
    process.stderr.write(
      `verdict worktree cleanup failed: ${errors.map(String).join('; ')}\n`,
    );
    process.exitCode = 1;
  }
}

function runSandbox(
  root: string,
  copy: string,
  argv: readonly string[],
  timeoutMs: number,
  extraPath?: string,
) {
  const unit = `krn-check-${randomUUID()}`;
  const home = '/tmp';
  const executable = argv[0];
  if (!executable) throw new Error('check argv is empty');
  const path = sandboxEnv(extraPath).PATH ?? '/usr/bin:/bin';
  const monitor = `
    const { spawnSync } = require('node:child_process'), { readdirSync, readFileSync } = require('node:fs');
    const result = spawnSync(process.argv[1], process.argv.slice(2), { encoding: 'buffer', maxBuffer: 1048576 });
    const children = readdirSync('/proc').filter((n) => /^\\d+$/.test(n)).filter((n) => n !== String(process.pid) && (() => { try { const stat = readFileSync('/proc/' + n + '/stat', 'utf8'); return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1] === '1'; } catch { return false; } })());
    for (const child of children) { try { process.kill(Number(child), 'SIGKILL'); } catch {} } if (result.stdout) process.stdout.write(result.stdout); if (result.stderr) process.stderr.write(result.stderr);
    if (children.length) { process.stderr.write('detached check processes remained\\n'); process.exit(125); } process.exit(result.status ?? 1);
  `;
  // biome-ignore format: Keep bwrap's flat argv sequence visible as one invocation.
  const sandbox = [
    '--die-with-parent', '--ro-bind', '/', '/', '--bind', copy, copy, '--clearenv',
    '--unshare-net', '--unshare-pid', '--as-pid-1', '--tmpfs', home,
    '--setenv', 'HOME', home, '--setenv', 'TMPDIR', home, '--setenv', 'PATH', path,
    '--setenv', 'LANG', 'C', '--setenv', 'LC_ALL', 'C', '--proc', '/proc', '--dev', '/dev',
    '--chdir', copy, '--', process.execPath, '-e', monitor, executable, ...argv.slice(1),
  ];
  const uid = process.getuid?.() ?? 0;
  const busEnv = {
    ...sandboxEnv(extraPath),
    XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR ?? `/run/user/${uid}`,
    DBUS_SESSION_BUS_ADDRESS:
      process.env.DBUS_SESSION_BUS_ADDRESS ?? `unix:path=/run/user/${uid}/bus`,
  };
  // biome-ignore format: Preserve the exact scope argv beside the bwrap argv.
  const result = runOutput('systemd-run', ['--quiet', '--user', '--scope', '--unit', unit, '--property', `RuntimeMaxSec=${Math.ceil(timeoutMs / 1000) + 2}s`, 'bwrap', ...sandbox], root, timeoutMs + 10000, busEnv);
  // biome-ignore format: Both systemd observations use the same scope identity.
  const state = run('systemctl', ['--user', 'show', unit, '-p', 'ActiveState', '--value'], root, 15000, busEnv);
  // biome-ignore format: Both systemd observations use the same scope identity.
  const group = run('systemctl', ['--user', 'show', unit, '-p', 'ControlGroup', '--value'], root, 15000, busEnv);
  const cgroup = group.stdout.trim();
  const processList = cgroup ? `/sys/fs/cgroup${cgroup}/cgroup.procs` : '';
  const survivors = processList ? readFileSync(processList, 'utf8').trim() : '';
  if (state.status !== 0 || group.status !== 0 || survivors) {
    // biome-ignore format: Keep the cleanup command next to the failed scope check.
    run('systemctl', ['--user', 'kill', '--kill-who=all', '--signal=KILL', unit], root, 15000, busEnv);
    throw new Error('check systemd scope did not become empty');
  }
  if (state.stdout.trim() !== 'inactive')
    throw new Error('check systemd scope state is unknown');
  return result;
}

function addTail(tail: string, sha: string, id: string, job: Job): void {
  const directory = join(stateDirectory(job), 'diagnostics');
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (realpathSync(directory) !== directory)
    throw new Error('unsafe verdict diagnostics directory');
  const file = join(directory, `${sha}-${id}-${randomUUID()}.txt`);
  const fd = openSync(
    file,
    constants.O_WRONLY |
      constants.O_CREAT |
      constants.O_EXCL |
      constants.O_NOFOLLOW,
    0o600,
  );
  try {
    writeSync(fd, tail.slice(-2048));
  } finally {
    closeSync(fd);
  }
}

export function execute(
  root: string,
  copy: string,
  job: Job,
  id: string,
  argv: readonly string[],
  timeoutMs: number,
  sha: string,
): CheckEvidence {
  const start = Date.now();
  const lockfile = existsSync(join(copy, 'pnpm-lock.yaml'));
  const pnpm = lockfile ? pnpmBinary(copy) : '';
  const localStore = join(copy, '.krn', 'pnpm-store');
  const pnpmPath = lockfile ? pnpmStore(pnpm, root) : '';
  const versionedStore = join(localStore, basename(pnpmPath));
  if (lockfile) {
    const krnDirectory = join(copy, '.krn');
    mkdirSync(krnDirectory, { recursive: true, mode: 0o700 });
    if (realpathSync(krnDirectory) !== krnDirectory)
      throw new Error('unsafe dependency cache directory');
    try {
      lstatSync(localStore);
      throw new Error('dependency cache path already exists');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    // biome-ignore format: Preserve the staging command and its exact paths together.
    const seeded = spawnSync('cp', ['-a', '--reflink=auto', '--', dirname(pnpmPath), localStore], { encoding: 'utf8', env: sandboxEnv(), timeout: 120000 });
    if (seeded.error || seeded.status !== 0)
      throw (
        seeded.error ??
        new Error(seeded.stderr || 'cannot stage the offline pnpm store')
      );
    // biome-ignore format: Resolve the writable store inside this same sandbox.
    const configured = runSandbox(root, copy, [pnpm, `--store-dir=${localStore}`, 'store', 'path'], timeoutMs, dirname(pnpm));
    if (
      configured.status !== 0 ||
      configured.stdout.toString().trim() !== versionedStore
    )
      throw new Error(
        `pnpm did not select the writable per-check store: ${configured.stdout.toString().trim()} ${configured.stderr.toString().trim()}`,
      );
    // biome-ignore format: Verify the per-check lock path inside this sandbox.
    const lockWrite = runSandbox(root, copy, ['/usr/bin/touch', join(versionedStore, 'pnpm-store-operation-locks')], timeoutMs, dirname(pnpm));
    if (lockWrite.status !== 0)
      throw new Error('per-check pnpm operation lock path is not writable');
  }
  const install = lockfile
    ? runSandbox(
        root,
        copy,
        [
          pnpm,
          `--store-dir=${localStore}`,
          '--package-import-method=copy',
          'install',
          '--offline',
          '--frozen-lockfile',
          '--trust-lockfile',
        ],
        timeoutMs,
        dirname(pnpm),
      )
    : { status: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
  const result =
    install.status === 0
      ? runSandbox(
          root,
          copy,
          argv,
          timeoutMs,
          pnpm ? dirname(pnpm) : undefined,
        )
      : install;
  const output = Buffer.concat([
    result.stdout ?? Buffer.alloc(0),
    result.stderr ?? Buffer.alloc(0),
  ]);
  addTail(output.toString('utf8'), sha, id, job);
  return {
    id,
    exitCode:
      result.status ??
      ('error' in result &&
      (result.error as NodeJS.ErrnoException | undefined)?.code === 'ETIMEDOUT'
        ? 124
        : 1),
    durationMs: Date.now() - start,
    sha256: createHash('sha256').update(output).digest('hex'),
  };
}
