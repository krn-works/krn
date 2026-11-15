// The exposure log: one append-only line per lane run naming the standards the run was served,
// the ones it could have been served but was not, and how the run ended. `krn standards effect`
// derives per-record served-vs-withheld numbers from it.
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** Where the log lives, relative to the main checkout. */
export const EXPOSURES_FILE = '.krn/brain/exposures.jsonl';

export type Outcome = 'followed' | 'violated';

export type Exposure = {
  run: string;
  task: string | null;
  channel: string;
  served: string[];
  withheld: string[];
  /** Per served record: followed when the lane delivered without rework, else violated. */
  outcome: Record<string, Outcome>;
  lane_ok: boolean;
  rework: number;
  /** The lane's proof line (clauses, red-first, precedent, Stop refusals), when the run ended with one. */
  proof?: string;
};

/** The exposure of one finished run: every served record shares the run's outcome. */
export function exposureOf(input: {
  run: string;
  task: string | undefined;
  channel: string;
  served: readonly string[];
  withheld: readonly string[];
  laneOk: boolean;
  rework: number;
  proof?: string;
}): Exposure {
  const result: Outcome =
    input.laneOk && input.rework === 0 ? 'followed' : 'violated';
  return {
    run: input.run,
    task: input.task ?? null,
    channel: input.channel,
    served: [...input.served],
    withheld: [...input.withheld],
    outcome: Object.fromEntries(input.served.map((id) => [id, result])),
    lane_ok: input.laneOk,
    rework: input.rework,
    ...(input.proof === undefined ? {} : { proof: input.proof }),
  };
}

/** Appends one exposure; a run that served, withheld and proved nothing leaves no line. */
export function appendExposure(main: string, exposure: Exposure): void {
  if (
    exposure.served.length === 0 &&
    exposure.withheld.length === 0 &&
    exposure.proof === undefined
  )
    return;
  const path = join(main, EXPOSURES_FILE);
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify(exposure)}\n`);
}

/** Every exposure of the log, in order; blank lines are skipped and a malformed line is an error. */
export function readExposures(main: string): Exposure[] {
  const path = join(main, EXPOSURES_FILE);
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line, index) => {
      try {
        return JSON.parse(line) as Exposure;
      } catch {
        throw new Error(`${EXPOSURES_FILE}:${index + 1}: not JSON`);
      }
    });
}

const rate = (ok: number, n: number): string =>
  n === 0 ? '-' : `${Math.round((100 * ok) / n)}%`;

export type EffectTotals = {
  served: number;
  servedOk: number;
  withheld: number;
  withheldOk: number;
  followed: number;
  violated: number;
};

/** Per record: served and withheld runs, the lanes that delivered in each, and the followed/violated counts. */
export function effectTotals(
  exposures: readonly Exposure[],
): Map<string, EffectTotals> {
  const rows = new Map<string, EffectTotals>();
  const row = (id: string) => {
    let value = rows.get(id);
    if (value === undefined) {
      value = {
        served: 0,
        servedOk: 0,
        withheld: 0,
        withheldOk: 0,
        followed: 0,
        violated: 0,
      };
      rows.set(id, value);
    }
    return value;
  };
  for (const exposure of exposures) {
    for (const id of exposure.served) {
      const value = row(id);
      value.served++;
      if (exposure.lane_ok) value.servedOk++;
      if (exposure.outcome[id] === 'followed') value.followed++;
      if (exposure.outcome[id] === 'violated') value.violated++;
    }
    for (const id of exposure.withheld) {
      const value = row(id);
      value.withheld++;
      if (exposure.lane_ok) value.withheldOk++;
    }
  }
  return rows;
}

/** One row per record: served and withheld runs with the share of lanes that delivered, and the followed/violated counts. */
export function effectRows(exposures: readonly Exposure[]): string[] {
  const rows = effectTotals(exposures);
  return [...rows.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(
      ([id, v]) =>
        `${id}: served ${v.served} (ok ${rate(v.servedOk, v.served)}, followed ${v.followed}, violated ${v.violated}) withheld ${v.withheld} (ok ${rate(v.withheldOk, v.withheld)})`,
    );
}

/** A served packet whose outcome is not known yet (the session has just started): no per-record outcome. */
export function servedExposure(
  run: string,
  channel: string,
  served: readonly string[],
): Exposure {
  return {
    run,
    task: null,
    channel,
    served: [...served],
    withheld: [],
    outcome: {},
    lane_ok: true,
    rework: 0,
  };
}

/** A refused Stop: each record the session still violated, so the effect report counts the violation. */
export function violatedExposure(
  run: string,
  ids: readonly string[],
): Exposure {
  return {
    run,
    task: null,
    channel: 'stop',
    served: [...ids],
    withheld: [],
    outcome: Object.fromEntries(ids.map((id) => [id, 'violated' as const])),
    lane_ok: false,
    rework: 1,
  };
}
