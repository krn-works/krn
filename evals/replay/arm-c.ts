// Live arm C (KRN): the unit's base checkout adopts KRN (krn adopt writes the hooks, rules and contract), then one
// headless session runs through the shared session path (arm-session.ts) and the unit's hidden test grades the result.
import { spawnSync } from 'node:child_process';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { outsideGit } from '../../src/cli/outside-git.ts';
import { inForceRecords, injectionTokens } from './arm-b.ts';
import { type ArmOptions, armRow, commitPreparation } from './arm-session.ts';
import { ARMS } from './arms.ts';
import { type LiveUnit, promptOf } from './live.ts';
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

/**
 * Claims the unit's task in the adopted checkout, as `krn lane start` does for a lane: SessionStart serves the standards
 * of the claimed task only, so a session without a claim would run C with nothing served.
 */
export function claimUnitTask(wt: string, { unit }: LiveUnit): void {
  mkdirSync(join(wt, 'tasks'), { recursive: true });
  writeFileSync(
    join(wt, 'tasks', `${unit.id}.json`),
    `${JSON.stringify({
      id: unit.id,
      status: 'open',
      resolution: null,
      created: new Date().toISOString().slice(0, 10),
      priority: 2,
      title: unit.task.title,
      after: [],
      body: [unit.task.body],
    })}\n`,
  );
  mkdirSync(join(wt, '.krn', 'task-claims'), { recursive: true });
  writeFileSync(
    join(wt, '.krn', 'task-claims', `${unit.id}.json`),
    `${JSON.stringify({
      id: unit.id,
      actor: 'krn-eval',
      worktree: wt,
      branch: outsideGit(wt, ['rev-parse', '--abbrev-ref', 'HEAD']).trim(),
      claimed: new Date().toISOString(),
      reason: null,
    })}\n`,
  );
  commitPreparation(wt, 'chore: claim task');
}

/** One arm-C session on a KRN-adopted checkout with its task claimed, and its grade; the row attests the injected tokens. */
export async function armCRow(
  unit: LiveUnit,
  o: ArmCOptions,
  rep = 1,
  asOf: string = new Date().toISOString().slice(0, 10),
): Promise<Row> {
  const { row, note } = await armRow(ARMS.C, unit, o, rep, (wt, log) => {
    const injection = injectionTokens(
      inForceRecords(wt, asOf),
      wt,
      unit.unit.id,
      promptOf(unit.unit),
      asOf,
    );
    adoptKrn(wt, log);
    claimUnitTask(wt, unit);
    return injection;
  });
  return note === undefined ? row : { ...row, injection: note };
}
