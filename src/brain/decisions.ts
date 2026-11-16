// The unserved record file: decisions, preferences and facts (ADR 0019). `.agents/decisions.json` is
// queryable with `krn standards query --type decision` and is never read by a packet builder.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseUnified, UNSERVED_TYPES, type UnifiedRecord } from './record.ts';

/** The decisions file of a repository, relative to its root. */
export const DECISIONS_FILE = '.agents/decisions.json';

/** True for a record type this store holds and no packet serves. */
export const isUnservedType = (type: string): boolean =>
  (UNSERVED_TYPES as readonly string[]).includes(type);

/** Every record of the decisions file, empty when the repository has none; a malformed file throws. */
export function readDecisions(root: string): UnifiedRecord[] {
  const path = join(root, DECISIONS_FILE);
  if (!existsSync(path)) return [];
  const rows = parseUnified(JSON.parse(readFileSync(path, 'utf8')));
  const bad = rows.find((row) => !isUnservedType(row.type));
  if (bad !== undefined)
    throw new Error(
      `${DECISIONS_FILE}: ${bad.id} has type ${bad.type}; the file holds ${UNSERVED_TYPES.join(', ')} only`,
    );
  return rows;
}
