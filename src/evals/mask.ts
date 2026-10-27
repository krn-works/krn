import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { access, lstat, mkdir, realpath } from 'node:fs/promises';
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

export async function credentialMounts(
  values: string[],
  slot: string,
): Promise<string[]> {
  const args: string[] = [];
  const destinations = new Set<string>();
  for (const value of values) {
    const delimiter = value.indexOf('=');
    const source = value.slice(0, delimiter);
    const target = value.slice(delimiter + 1);
    if (
      delimiter < 1 ||
      !source ||
      !target.startsWith('/w/') ||
      target.includes('\\') ||
      target.includes('\0') ||
      target
        .slice(1)
        .split('/')
        .some((part) => !part || part === '.' || part === '..') ||
      inside(target, '/w/repo')
    )
      throw new EvalDataError(
        'credential requires <host file>=<absolute path under /w, outside /w/repo>',
      );
    if (destinations.has(target))
      throw new EvalDataError(`duplicate credential destination: ${target}`);
    for (const prior of destinations) {
      if (overlaps(prior, target))
        throw new EvalDataError('credential destinations overlap');
    }
    destinations.add(target);
    if (source.includes('\0') || source.includes('\\'))
      throw new EvalDataError('invalid credential host path');
    let current = isAbsolute(source) ? parse(source).root : process.cwd();
    const components = source
      .slice(isAbsolute(source) ? current.length : 0)
      .split('/');
    for (const [index, component] of components.entries()) {
      if (!component || component === '.' || component === '..')
        throw new EvalDataError(
          'credential host path must not contain empty or dot segments',
        );
      current = join(current, component);
      const stat = await lstat(current);
      if (stat.isSymbolicLink())
        throw new EvalDataError(
          `credential path must not contain a symlink: ${current}`,
        );
      if (
        index === components.length - 1 ? !stat.isFile() : !stat.isDirectory()
      )
        throw new EvalDataError(
          `credential requires a regular file and directory parents: ${current}`,
        );
    }
    await access(current, constants.R_OK);
    // A symlink in the writable slot must not redirect the mount into repo.
    const destination = join(slot, target.slice('/w/'.length));
    let parent = slot;
    let existingParent = slot;
    for (const component of relative(slot, destination).split(sep)) {
      parent = join(parent, component);
      try {
        const stat = await lstat(parent);
        if (
          stat.isSymbolicLink() ||
          (parent !== destination && !stat.isDirectory()) ||
          (parent === destination && !stat.isFile())
        )
          throw new EvalDataError(
            `credential destination must not contain symlinks or non-directory parents: ${parent}`,
          );
        if (stat.isDirectory()) existingParent = parent;
      } catch (error) {
        if (
          !(
            error instanceof Error &&
            'code' in error &&
            error.code === 'ENOENT'
          )
        )
          throw error;
        await access(existingParent, constants.W_OK | constants.X_OK);
      }
    }
    args.push('--ro-bind', current, target);
  }
  return args;
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

async function resolverMounts(): Promise<string[]> {
  // Test-only override: exercise resolver failures without changing host /etc.
  const source = process.env.KRN_EVAL_RESOLV_CONF ?? '/etc/resolv.conf';
  try {
    const symlink = (await lstat(source)).isSymbolicLink();
    const target = await realpath(source);
    if (!(await lstat(target)).isFile())
      throw new EvalDataError('resolver target must be a regular file');
    await access(target, constants.R_OK);
    // /etc and /usr are already mounted. Expose only the final file elsewhere,
    // never its parent directory (notably /run with systemd-resolved).
    return symlink && !inside(target, '/etc') && !inside(target, '/usr')
      ? ['--ro-bind', target, target]
      : [];
  } catch (error) {
    throw new EvalDataError(
      `mask resolver: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export async function maskCommand(options: {
  slot: string;
  network: boolean;
  tools: string[];
  credentials?: string[];
  command: string[];
}): Promise<number> {
  let slot: string;
  const tools: string[] = [];
  let credentials: string[] = [];
  const resolver = options.network ? await resolverMounts() : [];
  try {
    if (!isAbsolute(options.slot))
      throw new EvalDataError('slot must be absolute');
    if (options.credentials?.length)
      await directoryWithoutSymlinks(options.slot);
    slot = await realpath(options.slot);
    await directory(join(slot, 'repo'));
    credentials = await credentialMounts(options.credentials ?? [], slot);
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
    ...resolver,
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
    ...credentials,
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
