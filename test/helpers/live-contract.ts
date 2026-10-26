import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Contract } from '../../src/ledger/index.ts';

export async function writeLiveContract(
  root: string,
  issue: string,
  overrides: Partial<Contract> = {},
): Promise<string> {
  const directory = join(root, '.krn');
  await mkdir(directory, { recursive: true });
  const path = join(directory, 'live-contract.json');
  await writeFile(
    path,
    JSON.stringify({
      issueId: issue,
      identifier: issue,
      title: 'Local delivery fixture',
      description: 'Local delivery fixture',
      revision: '2026-10-18T18:00:00.000Z',
      targetRepo: 'fixture/repo',
      checks: ['gate'],
      ...overrides,
    } satisfies Contract),
  );
  return path;
}
