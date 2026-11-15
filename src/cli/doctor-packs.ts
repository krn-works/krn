// `krn doctor` pack section: each registered adopted repository that lacks pack records, with the remedy.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { missingPackRecords } from '../adopt/drift.ts';
import { readRegistry, registryPath } from '../brain/adopted-registry.ts';

export const PACK_STALE_EXIT = 65;

export function packsReport(file: string = registryPath()): {
  text: string;
  exitCode: number;
} {
  const lines: string[] = [];
  let stale = 0;
  for (const root of readRegistry(file)) {
    if (!existsSync(join(root, '.git'))) continue;
    const missing = missingPackRecords(root);
    if (missing.length === 0) continue;
    stale += 1;
    lines.push(
      `pack-stale=${root} lacks ${missing.length} pack records: ${missing.join(', ')}`,
    );
  }
  if (stale > 0)
    lines.push(
      'pack-remedy=run `krn adopt --refresh-all` (or `krn adopt <repo> --refresh`)',
    );
  else lines.push('pack=current');
  return {
    text: `${lines.join('\n')}\n`,
    exitCode: stale > 0 ? PACK_STALE_EXIT : 0,
  };
}
