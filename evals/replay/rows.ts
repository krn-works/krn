// The one results format: (unit, arm, rep, pass, cost, harness sha). `pass` is null until a session is graded.
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ArmId } from './arms.ts';

export interface Row {
  unit: string;
  arm: ArmId;
  rep: number;
  pass: boolean | null;
  /** USD for the session, 0 for a dry row. */
  cost: number;
  harness: string;
}

/** Content hash of every file under the replay directory: the harness a row was produced by. */
export function harnessSha(dir: string): string {
  const h = createHash('sha256');
  for (const f of readdirSync(dir).sort()) {
    if (!f.endsWith('.ts')) continue;
    h.update(f);
    h.update(readFileSync(join(dir, f)));
  }
  return h.digest('hex').slice(0, 12);
}

export const formatRow = (r: Row): string => JSON.stringify(r);
