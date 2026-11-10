// The plan gauge: points of the five-hour and seven-day plan limits used in a window, against the window's dollars.
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

export type PlanSample = {
  at: number;
  fiveHour: number;
  sevenDay: number;
};

export type PlanPoints = {
  samples: number;
  fiveHour: number;
  sevenDay: number;
};

export const planSamplesPath = (root: string) =>
  join(root, '.krn', 'plan', 'samples.jsonl');

/** Parses sampler rows; a malformed row is skipped. Rows are sorted by time. */
export function parsePlanSamples(text: string): PlanSample[] {
  const rows: PlanSample[] = [];
  for (const line of text.split('\n')) {
    try {
      const r: unknown = JSON.parse(line);
      if (typeof r !== 'object' || r === null) continue;
      const at = Date.parse(String((r as { time?: unknown }).time));
      const five = (r as { five_hour?: unknown }).five_hour;
      const seven = (r as { seven_day?: unknown }).seven_day;
      if (
        Number.isFinite(at) &&
        typeof five === 'number' &&
        typeof seven === 'number'
      )
        rows.push({ at, fiveHour: five, sevenDay: seven });
    } catch {
      // blank or partial line
    }
  }
  return rows.sort((a, b) => a.at - b.at);
}

/**
 * Plan points consumed in [from, to). The gauge is per account and sessions
 * report it with stale values, so a row whose seven-day value is below the
 * running maximum is stale and dropped (the seven-day gauge only rises inside
 * its window). On the remaining rows, points are the sum of rises: a fall of
 * the five-hour gauge is a window reset and adds nothing. The row before
 * `from` is the baseline.
 */
export function planPoints(
  rows: PlanSample[],
  from: number,
  to: number,
): PlanPoints {
  let seenMax = -1;
  let prev: PlanSample | null = null;
  const out: PlanPoints = { samples: 0, fiveHour: 0, sevenDay: 0 };
  for (const row of rows) {
    if (row.at >= to) break;
    if (row.sevenDay < seenMax) continue;
    seenMax = row.sevenDay;
    if (prev && row.at >= from) {
      out.samples++;
      out.fiveHour += Math.max(0, row.fiveHour - prev.fiveHour);
      out.sevenDay += row.sevenDay - prev.sevenDay;
    }
    prev = row;
  }
  return out;
}

export async function readPlanPoints(root: string, from: number, to: number) {
  try {
    return planPoints(
      parsePlanSamples(await readFile(planSamplesPath(root), 'utf8')),
      from,
      to,
    );
  } catch {
    return null;
  }
}

/** Dollars per plan point for both windows; null when the window consumed no points. */
export function dollarsPerPoint(dollars: number, points: PlanPoints) {
  const per = (n: number) => (n > 0 ? dollars / n : null);
  return { fiveHour: per(points.fiveHour), sevenDay: per(points.sevenDay) };
}
