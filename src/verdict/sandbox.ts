// Disposable worktrees execute base-declared checks under bwrap and a systemd scope. ADR 0001.
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
// biome-ignore format: These filesystem primitives form the sandbox's owned I/O surface.
import { accessSync, closeSync, constants, existsSync, lstatSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, realpathSync, rmSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, delimiter, dirname, join, resolve } from 'node:path';
import { z } from 'zod';
import type { Job } from '../core/index.ts';
import { stateDirectory } from '../foreman/state.ts';
import type { CheckEvidence } from './index.ts';

export const MAX_CHECK_OUTPUT_BYTES = 8 * 1024 * 1024;
const MAX_PACKAGE_MANIFEST_BYTES = 1024 * 1024;
const MAX_LOCKFILE_BYTES = 16 * 1024 * 1024;
const OUTPUT_TAIL_BYTES = 2 * 1024;

class OutputCapture {
  readonly #hash = createHash('sha256');
  #tail = Buffer.alloc(0);
  #bytes = 0;
  #exceeded = false;

  append(chunk: Buffer): Buffer {
    const remaining = MAX_CHECK_OUTPUT_BYTES - this.#bytes;
    const accepted = chunk.subarray(0, Math.max(0, remaining));
    if (accepted.length !== chunk.length) this.#exceeded = true;
    if (accepted.length) {
      this.#hash.update(accepted);
      this.#bytes += accepted.length;
      if (accepted.length >= OUTPUT_TAIL_BYTES) {
        this.#tail = Buffer.from(accepted.subarray(-OUTPUT_TAIL_BYTES));
      } else {
        const keep = Math.min(
          OUTPUT_TAIL_BYTES - accepted.length,
          this.#tail.length,
        );
        this.#tail = Buffer.concat([
          this.#tail.subarray(this.#tail.length - keep),
          accepted,
        ]);
      }
    }
    return accepted;
  }

  get exceeded(): boolean {
    return this.#exceeded;
  }

  get tail(): Buffer {
    return Buffer.from(this.#tail);
  }

  get outputBytes(): number {
    return this.#bytes;
  }

  get sha256(): string {
    return this.#hash.copy().digest('hex');
  }
}

// biome-ignore format: Share the fixed process limits across sandbox metadata commands.
type CommandResult = { status: number | null; stdout: Buffer; stderr: Buffer };
function run(
  file: string,
  args: readonly string[],
  cwd: string,
  timeout = 15000,
  env = sandboxEnv(),
  signal?: AbortSignal,
): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(file, [...args], {
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
    let timer: NodeJS.Timeout | undefined;
    const abort = () => child.kill('SIGTERM');
    if (signal?.aborted) abort();
    else signal?.addEventListener('abort', abort, { once: true });
    if (timeout) timer = setTimeout(abort, timeout);
    child.once('error', reject);
    child.once('close', (status) => {
      if (timer) clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      resolve({
        status,
        stdout: Buffer.concat(stdout),
        stderr: Buffer.concat(stderr),
      });
    });
  });
}

// biome-ignore format: This is the complete allowlisted child environment.
function sandboxEnv(extraPath?: string): NodeJS.ProcessEnv {
  return { PATH: [dirname(process.execPath), extraPath, '/usr/bin', '/bin'].filter((path): path is string => Boolean(path)).join(':'), LANG: 'C', LC_ALL: 'C', HOME: '/tmp/krn-home', TMPDIR: '/tmp/krn-home' };
}

export async function pnpmBinary(manager: string): Promise<string> {
  let result: CommandResult;
  try {
    // biome-ignore format: Toolchain lookup is one process boundary.
    result = await run('mise', ['where', manager], tmpdir(), 15000, { PATH: process.env.PATH, HOME: process.env.HOME });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    const expectedVersion = manager.slice('pnpm@'.length);
    const executable = process.env.PATH?.split(delimiter)
      .map((directory) => resolve(directory || '.', 'pnpm'))
      .find((candidate) => {
        if (!existsSync(candidate)) return false;
        try {
          accessSync(candidate, constants.X_OK);
          return true;
        } catch {
          return false;
        }
      });
    if (!executable) throw new Error(`PATH pnpm must be ${expectedVersion}`);
    const version = await run(executable, ['--version'], tmpdir(), 15000, {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
    });
    if (
      version.status !== 0 ||
      version.stdout.toString().trim() !== expectedVersion
    )
      throw new Error(
        version.stderr.toString() || `PATH pnpm must be ${expectedVersion}`,
      );
    return executable;
  }
  const directory = result.stdout.toString().trim();
  if (result.status !== 0 || !directory)
    throw new Error(result.stderr.toString() || `cannot locate ${manager}`);
  const executable = join(directory, 'pnpm');
  if (!existsSync(executable)) throw new Error(`missing ${manager} executable`);
  return executable;
}

async function pnpmStore(pnpm: string, cwd: string): Promise<string> {
  const result = await run(pnpm, ['store', 'path'], cwd, 15000, {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
  });
  const store = result.stdout.toString().trim();
  if (result.status !== 0 || !store)
    throw new Error(
      result.stderr.toString() || 'cannot locate the pnpm content store',
    );
  return store;
}

async function git(root: string, args: string[]): Promise<string> {
  const result = await run('git', ['-C', root, ...args], root);
  if (result.status !== 0)
    throw new Error(result.stderr.toString() || 'git command failed');
  return result.stdout.toString().trim();
}

async function gitBlob(
  root: string,
  sha: string,
  path: 'package.json' | 'pnpm-lock.yaml',
  limit: number,
  source: 'candidate' | 'base' = 'candidate',
): Promise<Buffer | undefined> {
  const entry = await git(root, ['ls-tree', '-z', sha, '--', path]);
  if (!entry) return undefined;
  const [metadata, entryPathWithTerminator] = entry.split('\t');
  const entryPath = entryPathWithTerminator?.replace(/\0$/u, '');
  const [mode, type, oid] = metadata?.split(/\s+/u) ?? [];
  if (
    entryPath !== path ||
    type !== 'blob' ||
    !oid ||
    !['100644', '100755'].includes(mode ?? '')
  )
    throw new Error(`${source} ${path} must be a regular Git file`);

  const child = spawn('git', ['-C', root, 'cat-file', 'blob', oid], {
    cwd: root,
    env: sandboxEnv(),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const chunks: Buffer[] = [];
  let size = 0;
  let oversized = false;
  let stderr = '';
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
    stderr += chunk;
  });
  child.stdout.on('data', (chunk: Buffer) => {
    size += chunk.length;
    if (size > limit) {
      oversized = true;
      child.kill('SIGKILL');
      return;
    }
    chunks.push(chunk);
  });
  const status = await new Promise<number | null>((resolveStatus, reject) => {
    const timer = setTimeout(() => child.kill('SIGKILL'), 15000);
    child.once('error', reject);
    child.once('close', (code) => {
      clearTimeout(timer);
      resolveStatus(code);
    });
  });
  if (oversized) throw new Error(`${source} ${path} exceeds its size limit`);
  if (status !== 0)
    throw new Error(
      stderr.trim()
        ? `cannot read ${source} ${path}`
        : `git failed reading ${source} ${path}`,
    );
  return Buffer.concat(chunks, size);
}

function sandboxDirectories(paths: readonly string[]): string[] {
  const directories = new Set<string>(['/usr', '/etc', '/tmp', '/home']);
  for (const path of paths) {
    let directory = resolve(path);
    while (directory !== '/') {
      directories.add(directory);
      directory = dirname(directory);
    }
  }
  return [...directories].sort(
    (left, right) => left.split('/').length - right.split('/').length,
  );
}

async function registeredWorktrees(root: string): Promise<string[]> {
  const result = await run(
    'git',
    ['-C', root, 'worktree', 'list', '--porcelain'],
    root,
  );
  if (result.status !== 0)
    throw new Error(result.stderr.toString() || 'cannot list worktrees');
  return result.stdout
    .toString()
    .split(/\r?\n/u)
    .filter((line) => line.startsWith('worktree '))
    .map((line) => resolve(line.slice('worktree '.length)));
}

export async function pruneExactWorktree(
  root: string,
  copy: string,
): Promise<void> {
  const exactPath = resolve(copy);
  // biome-ignore format: Keep removal bound to the resolved disposable path.
  const removed = await run('git', ['-C', root, 'worktree', 'remove', '--force', exactPath], root);

  // `git worktree prune` has no path argument. Remove only the administrative
  // record whose gitdir points at this disposable worktree if remove left it.
  if ((await registeredWorktrees(root)).includes(exactPath)) {
    // biome-ignore format: Resolve the exact common git directory for this worktree.
    const commonDir = resolve(root, await git(root, ['rev-parse', '--git-common-dir']));
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
  if (
    (await registeredWorktrees(root)).includes(exactPath) ||
    removed.status !== 0
  )
    throw new Error(
      removed.stderr.toString() ||
        `could not prune verdict worktree ${exactPath}`,
    );
  rmSync(exactPath, { recursive: true, force: true });
}

// biome-ignore format: Directory creation is the first tracked cleanup step.
export function createWorktreeDirectory(directory: string): string { return mkdtempSync(join(directory, 'verdict-')); }

// biome-ignore format: Attach the allocated directory to the exact checked SHA.
export async function addWorktree(root: string, copy: string, sha: string): Promise<void> { await git(root, ['worktree', 'add', '--detach', copy, sha]); }

// biome-ignore format: Keep the cleanup boundary signature compact.
export async function cleanupWorktrees(root: string, copies: readonly string[]): Promise<void> {
  const errors: unknown[] = [];
  for (const copy of copies) {
    try {
      await pruneExactWorktree(root, copy);
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

export class TeardownUnconfirmed extends Error {
  constructor(detail: string) {
    super(`teardown_unconfirmed: ${detail}`);
    this.name = 'TeardownUnconfirmed';
  }
}

function scopePids(controlGroup: string): number[] {
  if (!controlGroup) return [];
  if (!controlGroup.startsWith('/') || controlGroup.split('/').includes('..'))
    throw new Error('systemd returned an invalid cgroup path');
  const cgroup = resolve('/sys/fs/cgroup', controlGroup.slice(1));
  try {
    return readFileSync(join(cgroup, 'cgroup.procs'), 'utf8')
      .trim()
      .split(/\s+/u)
      .filter(Boolean)
      .map((pid) => {
        if (!/^\d+$/u.test(pid)) throw new Error('invalid cgroup PID');
        return Number(pid);
      });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

async function killAndVerifyScope(
  root: string,
  busEnv: NodeJS.ProcessEnv,
  unit: string,
): Promise<void> {
  const kill = await run(
    'systemctl',
    ['--user', 'kill', '--kill-who=all', '--signal=SIGKILL', unit],
    root,
    5000,
    busEnv,
  );
  const deadline = Date.now() + 5000;
  let lastState = kill.stderr.toString() || `kill status ${kill.status}`;
  while (Date.now() < deadline) {
    const shown = await run(
      'systemctl',
      [
        '--user',
        'show',
        unit,
        '-p',
        'ActiveState',
        '-p',
        'ControlGroup',
        '--value',
      ],
      root,
      1500,
      busEnv,
    );
    const [activeState = '', controlGroup = ''] = shown.stdout
      .toString()
      .trimEnd()
      .split(/\r?\n/u);
    let pids: number[];
    try {
      pids = scopePids(controlGroup);
    } catch (error) {
      lastState = error instanceof Error ? error.message : String(error);
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
      continue;
    }
    if (shown.status === 0) {
      if (activeState === 'inactive' && pids.length === 0) return;
      lastState = `state=${activeState || 'unknown'}; PIDs=${pids.join(',') || 'none'}`;
    } else {
      const detail = `${shown.stderr.toString()} ${shown.stdout.toString()}`;
      if (
        /not loaded|not found|could not be found/i.test(detail) &&
        pids.length === 0
      )
        return;
      lastState = detail.trim() || 'systemctl show failed';
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
  }
  throw new TeardownUnconfirmed(
    `${unit} did not become inactive and empty: ${lastState}`,
  );
}

async function runSandbox(
  root: string,
  copy: string,
  argv: readonly string[],
  timeoutMs: number,
  extraPath?: string,
  signal?: AbortSignal,
): Promise<{
  status: number | null;
  sha256: string;
  tail: Buffer;
  outputBytes: number;
  outputExceeded: boolean;
}> {
  const unit = `krn-check-${randomUUID()}.scope`;
  const home = '/tmp';
  const executable = argv[0];
  if (!executable) throw new Error('check argv is empty');
  const path = sandboxEnv(extraPath).PATH ?? '/usr/bin:/bin';
  const nodeDirectory = dirname(process.execPath);
  const toolDirectories = [
    ...new Set(
      [nodeDirectory, extraPath].filter((value): value is string =>
        Boolean(value),
      ),
    ),
  ];
  const directories = sandboxDirectories([
    ...toolDirectories,
    copy,
    '/dev',
    '/proc',
  ]);
  const monitor = `
    const { spawn } = require('node:child_process'), { readdirSync, readFileSync } = require('node:fs'), { createHash } = require('node:crypto');
    const LIMIT=${MAX_CHECK_OUTPUT_BYTES}, TAIL=${OUTPUT_TAIL_BYTES}, hash=createHash('sha256');
    let bytes=0, tail=Buffer.alloc(0), exceeded=false;
    const child = spawn(process.argv[1], process.argv.slice(2), { stdio: ['ignore', 'pipe', 'pipe'] });
    const forward=(chunk, destination)=>{
      const accepted=chunk.subarray(0,Math.max(0,LIMIT-bytes));
      if(accepted.length!==chunk.length){exceeded=true;child.kill('SIGKILL');}
      if(accepted.length){
        hash.update(accepted);bytes+=accepted.length;
        tail=accepted.length>=TAIL?Buffer.from(accepted.subarray(-TAIL)):Buffer.concat([tail.subarray(Math.max(0,tail.length-(TAIL-accepted.length))),accepted]);
        destination.write(accepted);
      }
    };
    child.stdout.on('data', (chunk) => forward(chunk,process.stdout));
    child.stderr.on('data', (chunk) => forward(chunk,process.stderr));
    child.on('close', (status) => {
    const children = readdirSync('/proc').filter((n) => /^\\d+$/.test(n)).filter((n) => n !== String(process.pid) && (() => { try { const stat = readFileSync('/proc/' + n + '/stat', 'utf8'); return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1] === '1'; } catch { return false; } })());
    for (const pid of children) { try { process.kill(Number(pid), 'SIGKILL'); } catch {} }
    const digest=hash.digest('hex');
    let exitStatus=exceeded?125:(status ?? 1);
    if(tail.length>TAIL||digest.length!==64)exitStatus=125;
    if (children.length) { process.stderr.write('detached check processes remained\\n'); exitStatus=125; }
    process.exitCode=exitStatus;
    });
  `;
  // The new root starts empty. Only runtime files and the detached candidate
  // copy are mounted, so host sockets and operator files have no path in it.
  const sandbox = [
    '--die-with-parent',
    '--tmpfs',
    '/',
    ...directories.flatMap((directory) => ['--dir', directory]),
    '--ro-bind',
    '/usr',
    '/usr',
    '--ro-bind',
    '/etc',
    '/etc',
    '--symlink',
    '/usr/bin',
    '/bin',
    '--symlink',
    '/usr/sbin',
    '/sbin',
    '--symlink',
    '/usr/lib',
    '/lib',
    '--symlink',
    '/usr/lib64',
    '/lib64',
    ...toolDirectories.flatMap((directory) => [
      '--ro-bind',
      directory,
      directory,
    ]),
    '--size',
    '67108864',
    '--tmpfs',
    home,
    '--bind',
    copy,
    copy,
    '--clearenv',
    '--unshare-net',
    '--unshare-ipc',
    '--unshare-uts',
    '--unshare-pid',
    '--as-pid-1',
    '--new-session',
    '--cap-drop',
    'ALL',
    '--setenv',
    'HOME',
    home,
    '--setenv',
    'TMPDIR',
    home,
    '--setenv',
    'PATH',
    path,
    '--setenv',
    'LANG',
    'C',
    '--setenv',
    'LC_ALL',
    'C',
    '--proc',
    '/proc',
    '--dev',
    '/dev',
    '--chdir',
    copy,
    '--',
    process.execPath,
    '-e',
    monitor,
    executable,
    ...argv.slice(1),
  ];
  const uid = process.getuid?.() ?? 0;
  const busEnv = {
    ...sandboxEnv(extraPath),
    XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR ?? `/run/user/${uid}`,
    DBUS_SESSION_BUS_ADDRESS:
      process.env.DBUS_SESSION_BUS_ADDRESS ?? `unix:path=/run/user/${uid}/bus`,
  };
  // biome-ignore format: Preserve the exact scope argv beside the bwrap argv.
  const capture = new OutputCapture();
  let abortPromise: Promise<void> | undefined;
  let timedOut = false;
  const resultPromise = new Promise<{ status: number | null }>(
    (resolveResult, reject) => {
      const child = spawn(
        'systemd-run',
        [
          '--quiet',
          '--user',
          '--scope',
          '--unit',
          unit,
          '--property',
          `RuntimeMaxSec=${Math.ceil(timeoutMs / 1000) + 2}s`,
          '--property',
          'MemoryMax=1G',
          '--property',
          'TasksMax=256',
          'bwrap',
          ...sandbox,
        ],
        { cwd: root, env: busEnv, stdio: ['ignore', 'pipe', 'pipe'] },
      );
      const abort = () => {
        if (abortPromise) return abortPromise;
        abortPromise = killAndVerifyScope(root, busEnv, unit).catch(
          (error: unknown) => {
            child.kill('SIGTERM');
            throw error instanceof TeardownUnconfirmed
              ? error
              : new TeardownUnconfirmed(
                  error instanceof Error ? error.message : String(error),
                );
          },
        );
        void abortPromise.catch(() => {});
        return abortPromise;
      };
      child.stdout.on('data', (chunk: Buffer) => {
        capture.append(chunk);
        if (capture.exceeded) abort();
      });
      child.stderr.on('data', (chunk: Buffer) => {
        capture.append(chunk);
        if (capture.exceeded) abort();
      });
      if (signal?.aborted) abort();
      else signal?.addEventListener('abort', abort, { once: true });
      const timer = setTimeout(() => {
        timedOut = true;
        void abort();
      }, timeoutMs);
      child.once('error', reject);
      child.once('close', (status) => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
        resolveResult({ status });
      });
    },
  );
  const result = await resultPromise;
  if (abortPromise) await abortPromise;
  if (signal?.aborted) {
    if (!abortPromise) await killAndVerifyScope(root, busEnv, unit);
    throw new Error('stopped');
  }
  if (result.status === 125) await killAndVerifyScope(root, busEnv, unit);
  // biome-ignore format: Both systemd observations use the same scope identity.
  const state = await run('systemctl', ['--user', 'show', unit, '-p', 'ActiveState', '--value'], root, 15000, busEnv);
  // biome-ignore format: Both systemd observations use the same scope identity.
  const group = await run('systemctl', ['--user', 'show', unit, '-p', 'ControlGroup', '--value'], root, 15000, busEnv);
  const cgroup = group.stdout.toString().trim();
  const processList = cgroup ? `/sys/fs/cgroup${cgroup}/cgroup.procs` : '';
  const survivors = processList ? readFileSync(processList, 'utf8').trim() : '';
  if (state.status !== 0 || group.status !== 0 || survivors) {
    await killAndVerifyScope(root, busEnv, unit);
    throw new Error('check systemd scope did not become empty');
  }
  if (state.stdout.toString().trim() !== 'inactive')
    throw new Error('check systemd scope state is unknown');
  return {
    status: capture.exceeded ? 125 : timedOut ? 124 : result.status,
    sha256: capture.sha256,
    tail: capture.tail,
    outputBytes: capture.outputBytes,
    outputExceeded: capture.exceeded || result.status === 125,
  };
}

function addTail(tail: Buffer, sha: string, id: string, job: Job): void {
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
    writeSync(fd, tail.subarray(-OUTPUT_TAIL_BYTES));
  } finally {
    closeSync(fd);
  }
}

export async function execute(
  root: string,
  copy: string,
  job: Job,
  id: string,
  argv: readonly string[],
  timeoutMs: number,
  candidateSha: string,
  signal: AbortSignal | undefined,
  baseSha: string,
): Promise<CheckEvidence> {
  const start = Date.now();
  const lockfile = await gitBlob(
    root,
    candidateSha,
    'pnpm-lock.yaml',
    MAX_LOCKFILE_BYTES,
  );
  let pnpm = '';
  if (lockfile) {
    if (!baseSha)
      throw new Error(
        'trusted base SHA is required when the candidate has a lockfile',
      );
    const candidatePackageManifest = await gitBlob(
      root,
      candidateSha,
      'package.json',
      MAX_PACKAGE_MANIFEST_BYTES,
    );
    if (!candidatePackageManifest)
      throw new Error('candidate package.json is missing');
    const basePackageManifest = await gitBlob(
      root,
      baseSha,
      'package.json',
      MAX_PACKAGE_MANIFEST_BYTES,
      'base',
    );
    if (!basePackageManifest) throw new Error('base package.json is missing');
    let baseManager: string;
    try {
      const parsed: unknown = JSON.parse(basePackageManifest.toString('utf8'));
      const packageManager =
        typeof parsed === 'object' &&
        parsed !== null &&
        'packageManager' in parsed
          ? parsed.packageManager
          : undefined;
      baseManager = z
        .string()
        .regex(/^pnpm@\d+\.\d+\.\d+$/u)
        .parse(packageManager);
    } catch {
      throw new Error('base package.json has an invalid packageManager');
    }
    try {
      pnpm = await pnpmBinary(baseManager);
    } catch (error) {
      throw new Error(
        `cannot resolve base manager ${baseManager}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  const localStore = join(copy, '.krn', 'pnpm-store');
  const pnpmPath = lockfile ? await pnpmStore(pnpm, root) : '';
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
    const seeded = await run('cp', ['-a', '--reflink=auto', '--', dirname(pnpmPath), localStore], copy, 120000, sandboxEnv(), signal);
    if (seeded.status !== 0)
      throw new Error(
        seeded.stderr.toString() || 'cannot stage the offline pnpm store',
      );
    // biome-ignore format: Resolve the writable store inside this same sandbox.
    const configured = await runSandbox(root, copy, [pnpm, `--store-dir=${localStore}`, 'store', 'path'], timeoutMs, dirname(pnpm), signal);
    if (
      configured.status !== 0 ||
      configured.tail.toString().trim() !== versionedStore
    )
      throw new Error(
        `pnpm did not select the writable per-check store: ${configured.tail.toString().trim()}`,
      );
    // biome-ignore format: Verify the per-check lock path inside this sandbox.
    const lockWrite = await runSandbox(root, copy, ['/usr/bin/touch', join(versionedStore, 'pnpm-store-operation-locks')], timeoutMs, dirname(pnpm), signal);
    if (lockWrite.status !== 0)
      throw new Error('per-check pnpm operation lock path is not writable');
  }
  const install = lockfile
    ? await runSandbox(
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
        signal,
      )
    : { status: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
  const result =
    install.status === 0
      ? await runSandbox(
          root,
          copy,
          argv,
          timeoutMs,
          pnpm ? dirname(pnpm) : undefined,
          signal,
        )
      : install;
  const resultTail = 'tail' in result ? result.tail : Buffer.alloc(0);
  const outputHash =
    'sha256' in result ? result.sha256 : createHash('sha256').digest('hex');
  addTail(resultTail, candidateSha, id, job);
  return {
    id,
    exitCode: result.status ?? 1,
    durationMs: Date.now() - start,
    sha256: outputHash,
  };
}
