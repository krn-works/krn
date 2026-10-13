// Resolve check IDs from the immutable base commit. ADR 0001.
import { spawn } from 'node:child_process';
import { dirname } from 'node:path';
import { z } from 'zod';

const checkSchema = z
  .object({
    id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/),
    argv: z.array(z.string().min(1)).min(1).max(64),
    timeoutMs: z.number().int().min(1000).max(600000),
  })
  .strict();

const registryV1Schema = z
  .object({
    version: z.literal(1),
    checks: z.array(checkSchema).max(16),
  })
  .strict();
const registryV2Schema = z
  .object({
    version: z.literal(2),
    checks: z.array(checkSchema).max(16),
    protected: z.array(z.string().min(1)).max(64),
  })
  .strict();
const registrySchema = z.discriminatedUnion('version', [
  registryV1Schema,
  registryV2Schema,
]);

export type Check = z.infer<typeof checkSchema>;
export type Registry = { checks: Check[]; protected: string[] };

async function git(root: string, args: string[]): Promise<string> {
  const result = await new Promise<{
    status: number | null;
    stdout: string;
    stderr: string;
  }>((resolve, reject) => {
    const child = spawn('git', ['-C', root, ...args], {
      cwd: root,
      env: {
        PATH: [dirname(process.execPath), '/usr/bin', '/bin'].join(':'),
        LANG: 'C',
        LC_ALL: 'C',
        HOME: '/tmp/krn-home',
        TMPDIR: '/tmp/krn-home',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.setEncoding('utf8').on('data', (chunk) => {
      stderr += chunk;
    });
    const timer = setTimeout(() => child.kill('SIGTERM'), 15000);
    child.once('error', reject);
    child.once('close', (status) => {
      clearTimeout(timer);
      resolve({ status, stdout, stderr });
    });
  });
  if (result.status !== 0)
    throw new Error(result.stderr || 'git command failed');
  return result.stdout.trim();
}

export async function resolveRegistry(
  root: string,
  base: string,
): Promise<Registry> {
  const raw = await git(root, ['show', `${base}:krn.checks.json`]);
  const registry = registrySchema.parse(JSON.parse(raw));
  return {
    checks: registry.checks,
    protected: registry.version === 2 ? registry.protected : [],
  };
}

export async function resolveChecks(
  root: string,
  base: string,
  ids: readonly string[],
): Promise<Check[]> {
  if (!ids.length) throw new Error('zero declared checks');
  if (ids.length > 16 || new Set(ids).size !== ids.length)
    throw new Error('invalid check IDs');
  const registry = await resolveRegistry(root, base);
  const checks = new Map(registry.checks.map((check) => [check.id, check]));
  return ids.map((id) => {
    const check = checks.get(id);
    if (!check) throw new Error(`check ${id} is not in the base registry`);
    return check;
  });
}
