import { spawnSync } from 'node:child_process';

export interface GitResult {
  ok: boolean;
  out: string;
  status: number | null;
}

function run(repo: string, args: readonly string[], trim: boolean): GitResult {
  const result = spawnSync('git', ['-C', repo, ...args], {
    encoding: 'utf8',
    maxBuffer: 512 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const ok = result.error === undefined && result.status === 0;
  const out = result.stdout ?? '';
  return { ok, out: ok && trim ? out.trim() : out, status: result.status };
}

export const git = (repo: string, args: readonly string[]): GitResult =>
  run(repo, args, true);
export const gitRaw = (repo: string, args: readonly string[]): GitResult =>
  run(repo, args, false);

export function gitAvailable(): boolean {
  const result = spawnSync('git', ['--version'], { stdio: 'ignore' });
  return result.error === undefined && result.status === 0;
}
