// Bounded child-process and git primitives shared by the verdict sandbox and its worktree lifecycle.
import { spawn } from 'node:child_process';
import { dirname } from 'node:path';

// biome-ignore format: Share the fixed process limits across sandbox metadata commands.
export type CommandResult = { status: number | null; stdout: Buffer; stderr: Buffer };
export function run(
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
export function sandboxEnv(extraPath?: string): NodeJS.ProcessEnv {
  return { PATH: [dirname(process.execPath), extraPath, '/usr/bin', '/bin'].filter((path): path is string => Boolean(path)).join(':'), LANG: 'C', LC_ALL: 'C', HOME: '/tmp/krn-home', TMPDIR: '/tmp/krn-home' };
}

export async function git(root: string, args: string[]): Promise<string> {
  const result = await run('git', ['-C', root, ...args], root);
  if (result.status !== 0)
    throw new Error(result.stderr.toString() || 'git command failed');
  return result.stdout.toString().trim();
}
