// Check IDs resolve at the base commit, then run in disposable sandboxes. ADR 0001.
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync,
  constants,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { z } from 'zod';
import type { Job } from '../core/index.ts';
import { stateDirectory } from '../foreman/state.ts';

const registrySchema = z
  .object({
    version: z.literal(1),
    checks: z
      .array(
        z
          .object({
            id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/),
            argv: z.array(z.string().min(1)).min(1).max(64),
            timeoutMs: z.number().int().min(1000).max(600000),
          })
          .strict(),
      )
      .max(16),
  })
  .strict();

export type CheckEvidence = {
  readonly id: string;
  readonly exitCode: number;
  readonly durationMs: number;
  readonly sha256: string;
};
export type VerdictEvent = {
  readonly sha: string;
  readonly checks: readonly CheckEvidence[];
};
export type Verdict =
  | { readonly kind: 'pass'; readonly checks: readonly CheckEvidence[] }
  | {
      readonly kind: 'fail';
      readonly checks: readonly CheckEvidence[];
      readonly findings: readonly string[];
    }
  | {
      readonly kind: 'refused';
      readonly checks: readonly CheckEvidence[];
      readonly findings: readonly string[];
    };

function run(
  file: string,
  args: string[],
  cwd: string,
  timeout = 15000,
  env = sandboxEnv(),
) {
  return spawnSync(file, args, {
    cwd,
    encoding: 'utf8',
    env,
    timeout,
    maxBuffer: 1024 * 1024,
  });
}

function runOutput(
  file: string,
  args: string[],
  cwd: string,
  timeout: number,
  env: NodeJS.ProcessEnv,
) {
  return spawnSync(file, args, {
    cwd,
    encoding: 'buffer',
    env,
    timeout,
    maxBuffer: 1024 * 1024,
  });
}

function sandboxEnv(extraPath?: string): NodeJS.ProcessEnv {
  return {
    PATH: [dirname(process.execPath), extraPath, '/usr/bin', '/bin']
      .filter((path): path is string => Boolean(path))
      .join(':'),
    LANG: 'C',
    LC_ALL: 'C',
    HOME: '/tmp/krn-home',
    TMPDIR: '/tmp/krn-home',
  };
}

function pnpmBinary(copy: string): string {
  const manifest = JSON.parse(
    readFileSync(join(copy, 'package.json'), 'utf8'),
  ) as {
    readonly packageManager?: string;
  };
  const manager = z
    .string()
    .regex(/^pnpm@\d+\.\d+\.\d+$/)
    .parse(manifest.packageManager);
  const result = spawnSync('mise', ['where', manager], {
    cwd: tmpdir(),
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
    },
  });
  if (result.error || result.status !== 0 || !result.stdout.trim())
    throw (
      result.error ?? new Error(result.stderr || `cannot locate ${manager}`)
    );
  const executable = join(result.stdout.trim(), 'pnpm');
  if (!existsSync(executable)) throw new Error(`missing ${manager} executable`);
  return executable;
}

function pnpmStore(pnpm: string, cwd: string): string {
  const result = spawnSync(pnpm, ['store', 'path'], {
    cwd,
    encoding: 'utf8',
    env: { PATH: process.env.PATH, HOME: process.env.HOME },
  });
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

function clean(root: string, sha: string): string | null {
  if (git(root, ['status', '--porcelain=v1', '--untracked-files=all']))
    return 'worktree is dirty';
  return git(root, ['rev-parse', 'HEAD']) === sha ? null : 'HEAD changed';
}

function resolveChecks(root: string, base: string, ids: readonly string[]) {
  if (!ids.length) throw new Error('zero declared checks');
  if (ids.length > 16 || new Set(ids).size !== ids.length)
    throw new Error('invalid check IDs');
  const raw = git(root, ['show', `${base}:krn.checks.json`]);
  const registry = registrySchema.parse(JSON.parse(raw));
  const checks = new Map(registry.checks.map((check) => [check.id, check]));
  return ids.map((id) => {
    const check = checks.get(id);
    if (!check) throw new Error(`check ${id} is not in the base registry`);
    return check;
  });
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
    const { spawnSync } = require('node:child_process');
    const { readdirSync, readFileSync } = require('node:fs');
    const result = spawnSync(process.argv[1], process.argv.slice(2), { encoding: 'buffer', maxBuffer: 1048576 });
    const children = readdirSync('/proc').filter((name) => /^\\d+$/.test(name)).filter((name) => {
      if (Number(name) === process.pid) return false;
      try { const stat = readFileSync('/proc/' + name + '/stat', 'utf8'); return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1] === '1'; } catch { return false; }
    });
    for (const child of children) { try { process.kill(Number(child), 'SIGKILL'); } catch {} }
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    if (children.length) { process.stderr.write('detached check processes remained\\n'); process.exit(125); }
    process.exit(result.status ?? 1);
  `;
  const sandbox = [
    '--die-with-parent',
    '--ro-bind',
    '/',
    '/',
    '--bind',
    copy,
    copy,
    '--clearenv',
    '--unshare-net',
    '--unshare-pid',
    '--as-pid-1',
    '--tmpfs',
    home,
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
  const result = runOutput(
    'systemd-run',
    [
      '--quiet',
      '--user',
      '--scope',
      '--unit',
      unit,
      '--property',
      `RuntimeMaxSec=${Math.ceil(timeoutMs / 1000) + 2}s`,
      'bwrap',
      ...sandbox,
    ],
    root,
    timeoutMs + 10000,
    busEnv,
  );
  const state = run(
    'systemctl',
    ['--user', 'show', unit, '-p', 'ActiveState', '--value'],
    root,
    15000,
    busEnv,
  );
  const group = run(
    'systemctl',
    ['--user', 'show', unit, '-p', 'ControlGroup', '--value'],
    root,
    15000,
    busEnv,
  );
  const cgroup = group.stdout.trim();
  const processList = cgroup ? `/sys/fs/cgroup${cgroup}/cgroup.procs` : '';
  const survivors = processList ? readFileSync(processList, 'utf8').trim() : '';
  if (state.status !== 0 || group.status !== 0 || survivors) {
    run(
      'systemctl',
      ['--user', 'kill', '--kill-who=all', '--signal=KILL', unit],
      root,
      15000,
      busEnv,
    );
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

function execute(
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
    const seeded = spawnSync(
      'cp',
      ['-a', '--reflink=auto', '--', dirname(pnpmPath), localStore],
      { encoding: 'utf8', env: sandboxEnv(), timeout: 120000 },
    );
    if (seeded.error || seeded.status !== 0)
      throw (
        seeded.error ??
        new Error(seeded.stderr || 'cannot stage the offline pnpm store')
      );
    const configured = runSandbox(
      root,
      copy,
      [pnpm, `--store-dir=${localStore}`, 'store', 'path'],
      timeoutMs,
      dirname(pnpm),
    );
    if (
      configured.status !== 0 ||
      configured.stdout.toString().trim() !== versionedStore
    )
      throw new Error(
        `pnpm did not select the writable per-check store: ${configured.stdout.toString().trim()} ${configured.stderr.toString().trim()}`,
      );
    const lockWrite = runSandbox(
      root,
      copy,
      ['/usr/bin/touch', join(versionedStore, 'pnpm-store-operation-locks')],
      timeoutMs,
      dirname(pnpm),
    );
    if (lockWrite.status !== 0)
      throw new Error('per-check pnpm operation lock path is not writable');
  }
  const install = lockfile
    ? runSandbox(
        root,
        copy,
        // Use only metadata-free, frozen resolution from the exact checked SHA.
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

export async function judge(
  job: Job,
  sha: string,
  base: string,
  ids: readonly string[],
  record: (event: VerdictEvent) => Promise<void>,
): Promise<Verdict> {
  const root = realpathSync(
    resolve(
      job.repoRoot ?? git(job.worktree, ['rev-parse', '--show-toplevel']),
    ),
  );
  if (!/^[a-f0-9]{40,64}$/i.test(sha) || !/^[a-f0-9]{40,64}$/i.test(base))
    return {
      kind: 'refused',
      checks: [],
      findings: ['invalid base or target SHA'],
    };
  const before = clean(job.worktree, sha);
  if (before) return { kind: 'refused', checks: [], findings: [before] };
  const copies: string[] = [];
  try {
    const checks = resolveChecks(root, base, ids);
    const state = join(root, '.krn');
    const directory = join(state, 'tmp');
    mkdirSync(state, { recursive: true, mode: 0o700 });
    if (realpathSync(state) !== state)
      throw new Error('unsafe verdict state directory');
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    if (realpathSync(directory) !== directory)
      throw new Error('unsafe verdict worktree directory');
    const results: CheckEvidence[] = [];
    for (const check of checks) {
      const copy = mkdtempSync(join(directory, 'verdict-'));
      copies.push(copy);
      git(root, ['worktree', 'add', '--detach', copy, sha]);
      results.push(
        execute(root, copy, job, check.id, check.argv, check.timeoutMs, sha),
      );
    }
    await record({ sha, checks: results });
    const after = clean(job.worktree, sha);
    if (after) return { kind: 'refused', checks: results, findings: [after] };
    const failed = results.filter((check) => check.exitCode !== 0);
    return failed.length
      ? {
          kind: 'fail',
          checks: results,
          findings: failed
            .slice(0, 2)
            .map((c) => `${c.id} exited ${c.exitCode}`),
        }
      : { kind: 'pass', checks: results };
  } catch (error) {
    return {
      kind: 'refused',
      checks: [],
      findings: [error instanceof Error ? error.message : String(error)],
    };
  } finally {
    for (const copy of copies) {
      spawnSync('git', ['-C', root, 'worktree', 'remove', '--force', copy], {
        encoding: 'utf8',
      });
      rmSync(copy, { recursive: true, force: true });
    }
  }
}
