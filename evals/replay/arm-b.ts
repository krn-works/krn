// Live arm B (static records): the unit's base checkout gets a CLAUDE.md rendered from the same in-force records KRN
// would serve, cut to the token count arm C injects for the same row (ADR 0021 point 7: C may not inject more than B).
// No hooks, no adoption: the session is the plain checkout plus that one file.
import { appendFileSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { projectStandards, renderRules } from '../../src/adopt/adopt.ts';
import {
  type BrainRecord,
  packetRecord,
  tokens,
} from '../../src/brain/packet.ts';
import { inForce, renderStandardsBlock } from '../../src/brain/standards.ts';
import {
  packetOver,
  tierEffect,
  withoutAlwaysLoaded,
  workerRecords,
} from '../../src/brain/worker-packet.ts';
import { type ArmOptions, armRow, commitPreparation } from './arm-session.ts';
import { ARMS } from './arms.ts';
import { type LiveUnit, promptOf } from './live.ts';
import type { Row } from './rows.ts';

export const STATIC_HEADER = '# Repository conventions';

const line = (record: BrainRecord): string => `- [${record.id}] ${record.text}`;

/** The in-force records of the checkout that address a worker: what `krn adopt` would seed, as brain records. */
export function inForceRecords(wt: string, asOf: string): BrainRecord[] {
  return projectStandards(wt, {})
    .filter((standard) => inForce(standard, asOf))
    .map(packetRecord)
    .filter(
      (record) => record.audience !== 'lead' && record.audience !== 'adopt',
    );
}

/** Tokens of the instruction text `krn adopt` writes into AGENTS.md (the delivery rules and the standards block). */
export const adoptionTokens = (): number =>
  tokens(`${renderRules()}\n${renderStandardsBlock()}`);

/**
 * Tokens arm C injects for this task before its first tool call: the adopted instruction text plus the lane packet KRN
 * selects for the brief from the records it serves (advisory ones; an enforced record is taught by its check). The
 * records the edit-moment hook serves during the session are not knowable beforehand and are not counted.
 */
export function injectionTokens(
  records: readonly BrainRecord[],
  wt: string,
  task: string,
  brief: string,
  asOf: string,
): number {
  const served = withoutAlwaysLoaded(wt, workerRecords(records));
  return (
    adoptionTokens() + (packetOver(served, brief, asOf, task)?.tokens ?? 0)
  );
}

export interface StaticRender {
  text: string;
  /** Tokens of the rendered record lines. */
  tokens: number;
  records: string[];
}

/**
 * The records as a static file, task-independent: highest tier first, then by id, whole records added until the lines
 * reach `target` tokens, so B carries at least what C injects (fewer only when the records run out).
 */
export function renderStatic(
  records: readonly BrainRecord[],
  target: number,
): StaticRender {
  const ordered = [...records].sort(
    (a, b) => tierEffect(b) - tierEffect(a) || a.id.localeCompare(b.id),
  );
  const chosen: BrainRecord[] = [];
  for (const record of ordered) {
    if (tokens(chosen.map(line).join('\n')) >= target) break;
    chosen.push(record);
  }
  const body = chosen.map(line).join('\n');
  return {
    text: chosen.length === 0 ? '' : `${STATIC_HEADER}\n\n${body}\n`,
    tokens: tokens(body),
    records: chosen.map((record) => record.id),
  };
}

/** What a row reports about its two token counts. */
export interface TokenCounts {
  /** Tokens of arm B's static records. */
  static: number;
  /** Tokens arm C injects for the same row. */
  injection: number;
}

export const formatTokens = (unit: string, t: TokenCounts): string =>
  `tokens: unit ${unit} B static ${t.static} C injection ${t.injection}${t.static < t.injection ? ' (B below C: records ran out)' : ''}`;

/** Writes the rendered records into the checkout's CLAUDE.md (appended to the repository's own) and commits it. */
export function writeStatic(wt: string, render: StaticRender): void {
  if (render.text === '') return;
  const file = join(wt, 'CLAUDE.md');
  if (existsSync(file)) appendFileSync(file, `\n${render.text}`);
  else writeFileSync(file, render.text);
  commitPreparation(wt, 'chore: static records');
}

/** One arm-B session on a checkout with the static CLAUDE.md, its grade and the row's token counts. */
export async function armBRow(
  unit: LiveUnit,
  o: ArmOptions,
  rep = 1,
  asOf: string = new Date().toISOString().slice(0, 10),
): Promise<{ row: Row; tokens: TokenCounts }> {
  const { row, note } = await armRow(ARMS.B, unit, o, rep, (wt, log) => {
    const records = inForceRecords(wt, asOf);
    const injection = injectionTokens(
      records,
      wt,
      unit.unit.id,
      promptOf(unit.unit),
      asOf,
    );
    const render = renderStatic(records, injection);
    appendFileSync(
      log,
      `static records: ${render.records.join(',')} (${render.tokens} tokens, C injects ${injection})\n`,
    );
    writeStatic(wt, render);
    return { static: render.tokens, injection };
  });
  return { row, tokens: note };
}
