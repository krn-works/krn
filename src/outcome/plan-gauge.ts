// The plan gauge: points of the five-hour and seven-day plan limits used in a window, against the window's dollars.
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

type PlanSample = {
  at: number;
  fiveHour: number;
  sevenDay: number;
};

type PlanPoints = {
  samples: number;
  fiveHour: number;
  sevenDay: number;
};

const planSamplesPath = (root: string) =>
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

type AccountHeadroom = {
  /** The account's seven-day reset (ms): one per account, so it keys the account. */
  sevenDayResets: number;
  /** Hashed labels seen on its rows (the sampler's label can name the wrong account). */
  labels: string[];
  /** Points left (100 minus used) in each window. */
  fiveHourLeft: number;
  sevenDayLeft: number;
};

const WEEK = 7 * 24 * 3600 * 1000;

type Group = {
  labels: Set<string>;
  sevenUsed: number;
  fiveResets: number;
  fiveUsed: number;
};

/**
 * Headroom per account from sampler rows that carry both resets; older rows
 * lack them and are skipped. The sampler labels a row with the account signed
 * in when it samples, while a running session reports its own account's
 * windows, so the label is not the key: the seven-day reset is. A row whose
 * seven-day reset has passed by `now` belongs to the same account's next week
 * with nothing used. Inside a window the highest value wins, since stale
 * sessions report lower values and a gauge only rises inside its window.
 */
export function accountHeadroom(text: string, now: number): AccountHeadroom[] {
  const groups = new Map<number, Group>();
  for (const line of text.split('\n')) {
    let r: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(line);
      if (typeof parsed !== 'object' || parsed === null) continue;
      r = parsed as Record<string, unknown>;
    } catch {
      continue;
    }
    const { account, five_hour, seven_day } = r;
    const fiveResets = Date.parse(String(r.five_hour_resets));
    let sevenResets = Date.parse(String(r.seven_day_resets));
    if (
      typeof five_hour !== 'number' ||
      typeof seven_day !== 'number' ||
      !Number.isFinite(fiveResets) ||
      !Number.isFinite(sevenResets)
    )
      continue;
    let sevenUsed = seven_day;
    if (sevenResets <= now) {
      sevenResets += Math.ceil((now - sevenResets + 1) / WEEK) * WEEK;
      sevenUsed = 0;
    }
    const g = groups.get(sevenResets) ?? {
      labels: new Set<string>(),
      sevenUsed: 0,
      fiveResets: fiveResets,
      fiveUsed: 0,
    };
    if (typeof account === 'string' && account) g.labels.add(account);
    g.sevenUsed = Math.max(g.sevenUsed, sevenUsed);
    if (fiveResets > g.fiveResets) {
      g.fiveResets = fiveResets;
      g.fiveUsed = five_hour;
    } else if (fiveResets === g.fiveResets)
      g.fiveUsed = Math.max(g.fiveUsed, five_hour);
    groups.set(sevenResets, g);
  }
  return [...groups]
    .map(([sevenDayResets, g]) => ({
      sevenDayResets,
      labels: [...g.labels].sort(),
      fiveHourLeft: g.fiveResets > now ? Math.max(0, 100 - g.fiveUsed) : 100,
      sevenDayLeft: Math.max(0, 100 - g.sevenUsed),
    }))
    .sort((a, b) => a.sevenDayResets - b.sevenDayResets);
}

/**
 * The account to spend next: of those with points left in both windows, the
 * one whose seven-day reset is nearest, since its unused points expire first.
 */
export function spendNext(accounts: AccountHeadroom[]) {
  return (
    accounts
      .filter((a) => a.fiveHourLeft > 0 && a.sevenDayLeft > 0)
      .sort((a, b) => a.sevenDayResets - b.sevenDayResets)[0] ?? null
  );
}

const minute = (ms: number) =>
  new Date(ms).toISOString().replace(/:\d{2}\.\d{3}Z$/u, 'Z');

// An account is named by its seven-day reset, with its labels when it has any.
const name = (a: AccountHeadroom) =>
  `7d-reset ${minute(a.sevenDayResets)}${a.labels.length ? ` (${a.labels.join('/')})` : ''}`;

/** One line: points left per account, then the account to spend next. */
export function renderPlanLine(accounts: AccountHeadroom[]): string {
  if (accounts.length === 0) return 'plan: no sample records its resets';
  const each = accounts
    .map((a) => `${name(a)} 5h ${a.fiveHourLeft} 7d ${a.sevenDayLeft}`)
    .join(', ');
  const next = spendNext(accounts);
  const tail = next
    ? `spend next ${name(next)}`
    : 'spend next: none has points left';
  return `plan points left: ${each}; ${tail}`;
}

export async function readPlanLine(root: string, now: number) {
  let text = '';
  try {
    text = await readFile(planSamplesPath(root), 'utf8');
  } catch {
    // no sampler file yet
  }
  return renderPlanLine(accountHeadroom(text, now));
}
