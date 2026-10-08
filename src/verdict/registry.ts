// Resolve check IDs from the immutable base commit. ADR 0001.
import { spawnSync } from 'node:child_process';
import { dirname } from 'node:path';
import { z } from 'zod';

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

export type Check = z.infer<typeof registrySchema>['checks'][number];

function git(root: string, args: string[]): string {
  const result = spawnSync('git', ['-C', root, ...args], {
    cwd: root,
    encoding: 'utf8',
    env: {
      PATH: [dirname(process.execPath), '/usr/bin', '/bin'].join(':'),
      LANG: 'C',
      LC_ALL: 'C',
      HOME: '/tmp/krn-home',
      TMPDIR: '/tmp/krn-home',
    },
    timeout: 15000,
    maxBuffer: 1024 * 1024,
  });
  if (result.error || result.status !== 0)
    throw result.error ?? new Error(result.stderr || 'git command failed');
  return result.stdout.trim();
}

export function resolveChecks(
  root: string,
  base: string,
  ids: readonly string[],
): Check[] {
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
