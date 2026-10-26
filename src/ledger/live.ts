import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { deliveryTrailers } from './delivery.ts';
import type { Contract } from './index.ts';

const contractSchema = z
  .object({
    issueId: z.string().min(1),
    identifier: z.string().min(1),
    title: z.string().min(1),
    description: z.string().max(8 * 1024),
    revision: z.string().min(1),
    targetRepo: z.string().min(1),
    checks: z
      .array(z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u))
      .min(1)
      .max(16),
  })
  .strict()
  .refine((value) => new Set(value.checks).size === value.checks.length);

export async function loadLiveContract(
  path: string,
  issue: string,
  options: { readonly origin: string; readonly revision?: string },
): Promise<Contract> {
  const contract = contractSchema.parse(
    JSON.parse(await readFile(path, 'utf8')),
  );
  if (contract.issueId !== issue)
    throw new Error('contract issueId mismatch with --issue');
  if (options.revision && options.revision !== contract.revision)
    throw new Error('--revision mismatch with local contract revision');
  if (
    repositoryFromRemote(options.origin) !==
    normalizeRepository(contract.targetRepo)
  )
    throw new Error('contract targetRepo mismatch with origin remote');
  const delivery = deliveryTrailers(contract);
  if (!delivery.ok)
    throw new Error(`delivery metadata refused: ${delivery.error}`);
  return contract;
}

function normalizeRepository(value: string): string {
  return value
    .replace(/\.git$/i, '')
    .replace(/\/$/, '')
    .toLowerCase();
}

function repositoryFromRemote(remote: string): string {
  const match =
    /^(?:https?|ssh|git):\/\/[^/]+\/([^/]+\/[^/]+?)(?:\.git)?\/?$/i.exec(
      remote,
    ) ?? /^[^@]+@[^:]+:([^/]+\/[^/]+?)(?:\.git)?$/i.exec(remote);
  if (!match?.[1])
    throw new Error('unable to parse origin remote owner/repository');
  return normalizeRepository(match[1]);
}
