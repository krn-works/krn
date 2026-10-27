import { spawn } from 'node:child_process';
import { lstat, mkdir, realpath } from 'node:fs/promises';
import { isAbsolute, join, parse, relative, resolve, sep } from 'node:path';
import { EvalDataError } from './manifest.ts';

async function directory(path: string): Promise<void> {
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink())
    throw new EvalDataError(
      `mask requires a directory without symlinks: ${path}`,
    );
}

function inside(path: string, parent: string): boolean {
  const child = relative(parent, path);
  return (
    child === '' ||
    (!isAbsolute(child) && child !== '..' && !child.startsWith(`..${sep}`))
  );
}

function overlaps(left: string, right: string): boolean {
  return inside(left, right) || inside(right, left);
}

async function directoryWithoutSymlinks(path: string): Promise<void> {
  const root = parse(path).root;
  let current = root;
  for (const component of path
    .slice(root.length)
    .split(sep)
    .filter((value) => value !== '')) {
    current = join(current, component);
    const stat = await lstat(current);
    if (stat.isSymbolicLink())
      throw new EvalDataError(
        `tool directory path component must not be a symlink: ${current}`,
      );
    if (!stat.isDirectory())
      throw new EvalDataError(
        `tool directory path component must be a directory: ${current}`,
      );
  }
  await directory(path);
}

export async function maskCommand(options: {
  slot: string;
  network: boolean;
  tools: string[];
  command: string[];
}): Promise<number> {
  let slot: string;
  const tools: string[] = [];
  try {
    if (!isAbsolute(options.slot))
      throw new EvalDataError('slot must be absolute');
    slot = await realpath(options.slot);
    await directory(join(slot, 'repo'));
    for (const name of ['home', 't']) {
      const path = join(slot, name);
      await mkdir(path, { recursive: true });
      await directory(path);
    }
    for (const path of options.tools) {
      if (!isAbsolute(path))
        throw new EvalDataError('tool directory must be absolute');
      const tool = resolve(path);
      if (tool === parse(tool).root)
        throw new EvalDataError(
          `tool directory must not be filesystem root: ${tool}`,
        );
      for (const reserved of ['/w', '/tmp', '/proc', '/dev']) {
        if (overlaps(tool, reserved))
          throw new EvalDataError(
            `tool directory overlaps mask-reserved path ${reserved}: ${tool}`,
          );
      }
      for (const protectedPath of ['/usr', '/etc']) {
        if (tool === protectedPath || inside(protectedPath, tool))
          throw new EvalDataError(
            `tool directory equals or contains protected path ${protectedPath}: ${tool}`,
          );
      }
      if (overlaps(tool, slot))
        throw new EvalDataError(
          `tool directory overlaps slot ${slot}: ${tool}`,
        );
      await directoryWithoutSymlinks(tool);
      tools.push(tool);
    }
  } catch (error) {
    if (error instanceof EvalDataError) throw error;
    throw new EvalDataError(
      `mask slot/tool: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const args = [
    '--die-with-parent',
    '--tmpfs',
    '/',
    '--dir',
    '/tmp',
    '--size',
    '268435456',
    '--tmpfs',
    '/tmp',
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
    ...tools.flatMap((path) => ['--ro-bind', path, path]),
    '--bind',
    slot,
    '/w',
    '--clearenv',
    ...(options.network ? [] : ['--unshare-net']),
    '--unshare-ipc',
    '--unshare-uts',
    '--unshare-pid',
    '--as-pid-1',
    '--new-session',
    '--cap-drop',
    'ALL',
    '--setenv',
    'HOME',
    '/w/home',
    '--setenv',
    'TMPDIR',
    '/w/t',
    '--setenv',
    'PATH',
    [...tools, '/usr/bin'].join(':'),
    '--proc',
    '/proc',
    '--dev',
    '/dev',
    '--chdir',
    '/w/repo',
    // The private status pipe separates setup failure from a command's exit 1.
    '--info-fd',
    '3',
    '--',
    ...options.command,
  ];
  return new Promise((resolve) => {
    const child = spawn('bwrap', args, {
      stdio: ['inherit', 'inherit', 'inherit', 'pipe'],
    });
    let started = false;
    child.stdio[3]?.on('data', () => {
      started = true;
    });
    child.on('error', (error) => {
      process.stderr.write(`${error.message}\n`);
      resolve(70);
    });
    child.on('close', (code, signal) => {
      if (!started) resolve(70);
      else if (signal) {
        // Preserve signal termination too; stdout and stderr are inherited.
        process.kill(process.pid, signal);
      } else resolve(code ?? 70);
    });
  });
}
