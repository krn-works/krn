// Live arm C (KRN): the unit's base checkout adopts KRN (krn adopt writes the hooks, rules and contract), then one
// headless session runs through the shared session path (arm-session.ts) and the unit's hidden test grades the result.
import { spawnSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { type ArmOptions, armRow, commitPreparation } from './arm-session.ts';
import { ARMS } from './arms.ts';
import type { LiveUnit } from './live.ts';
import type { Row } from './rows.ts';

const krnEntry = fileURLToPath(
  new URL('../../src/cli/krn.mjs', import.meta.url),
);

export type ArmCOptions = ArmOptions;

/** Adopts KRN into the checkout and commits the adoption, so the session's change is the only uncommitted work. */
export function adoptKrn(wt: string, log: string): void {
  const r = spawnSync(process.execPath, [krnEntry, 'adopt', wt], {
    encoding: 'utf8',
    // Adoption of a large checkout took 96 s on 2026-11-17 (t-1182p41).
    timeout: 600_000,
  });
  appendFileSync(log, `adopt: exit ${r.status}\n${r.stdout}${r.stderr}`);
  if (r.status !== 0)
    throw new Error(`krn adopt exited ${r.status}: ${r.stderr.trim()}`);
  commitPreparation(wt, 'chore: adopt krn');
}

/** One arm-C session on a KRN-adopted checkout and its grade. */
export async function armCRow(
  unit: LiveUnit,
  o: ArmCOptions,
  rep = 1,
): Promise<Row> {
  return (await armRow(ARMS.C, unit, o, rep, adoptKrn)).row;
}
