import { readSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Job } from '../core/index.ts';
import { leadIntervention } from '../trace/index.ts';

function value(args: string[], flag: string): string {
  const index = args.indexOf(flag);
  const result = index < 0 ? undefined : args[index + 1];
  if (!result || result.startsWith('--')) throw new Error(`missing ${flag}`);
  return result;
}

function readNoteStdin(): string {
  const maximumBytes = 8192;
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  while (totalBytes < maximumBytes) {
    const chunk = Buffer.alloc(Math.min(1024, maximumBytes - totalBytes));
    const bytesRead = readSync(0, chunk, 0, chunk.length, null);
    if (bytesRead === 0) break;
    chunks.push(chunk.subarray(0, bytesRead));
    totalBytes += bytesRead;
  }
  if (totalBytes === maximumBytes) {
    const overflow = Buffer.alloc(1);
    if (readSync(0, overflow, 0, 1, null) > 0)
      throw new Error('note text exceeds 8192 bytes');
  }
  return Buffer.concat(chunks, totalBytes).toString('utf8');
}

export async function noteCommand(args: string[]): Promise<void> {
  const text = (
    args.includes('--text') ? value(args, '--text') : readNoteStdin()
  ).trim();
  const cliKind = value(args, '--kind');
  if (cliKind !== 'intervention' && cliKind !== 'reconstruction')
    throw new Error('--kind must be intervention or reconstruction');
  const job: Job = {
    id: value(args, '--job'),
    issue: value(args, '--issue'),
    worktree: resolve(value(args, '--worktree')),
    ...(args.includes('--repo-root')
      ? { repoRoot: resolve(value(args, '--repo-root')) }
      : {}),
  };
  await leadIntervention(
    job,
    cliKind === 'intervention' ? 'intervention' : 'reconstruction_prompt',
    text,
  );
}
