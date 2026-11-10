// Per-slice cost: split each transcript into the turns of the PR it was working on, price them, and name the author.
import { readFileSync } from 'node:fs';

type ObjectValue = Record<string, unknown>;

type Usage = {
  input: number;
  cacheRead: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
  output: number;
};
export type Turn = {
  model: string;
  usage: Usage;
  at: number | null;
  /** Bash commands this turn issued; the PR references are read from them. */
  text: string;
  /** Tool-use ids this turn issued, to place subagents launched by it. */
  tools: string[];
};
export type Transcript = {
  role: string;
  turns: Turn[];
  malformed: boolean;
  /** Lead tool-use id that launched this subagent transcript. */
  parentTool?: string;
  /** Session id of the lead transcript this subagent belongs to. */
  lead?: string;
};
export type SlicePr = {
  number: number;
  title: string;
  mergedAt: unknown;
  createdAt?: unknown;
};

const object = (v: unknown): ObjectValue =>
  typeof v === 'object' && v !== null && !Array.isArray(v)
    ? (v as ObjectValue)
    : {};
const count = (v: unknown): number =>
  typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0;

export function usageOf(raw: unknown): Usage {
  const u = object(raw);
  const split = object(u.cache_creation);
  const total = count(u.cache_creation_input_tokens);
  const has5m = typeof split.ephemeral_5m_input_tokens === 'number';
  const has1h = typeof split.ephemeral_1h_input_tokens === 'number';
  // Without the split every cache write is priced as a 5-minute write.
  const w1h = has1h ? count(split.ephemeral_1h_input_tokens) : 0;
  const w5m =
    has5m || has1h
      ? count(split.ephemeral_5m_input_tokens) +
        Math.max(0, total - count(split.ephemeral_5m_input_tokens) - w1h)
      : total;
  return {
    input: count(u.input_tokens),
    cacheRead: count(u.cache_read_input_tokens),
    cacheWrite5m: w5m,
    cacheWrite1h: w1h,
    output: count(u.output_tokens),
  };
}

// The one price table lives in model-prices.json (shared with scripts/claude/spend-window.py).
const priceTable = JSON.parse(
  readFileSync(new URL('./model-prices.json', import.meta.url), 'utf8'),
) as {
  models: Record<string, readonly [number, number, number]>;
  longPrompt: { model: string; tokens: number; scale: number };
};

/** Dollars for one turn, or null when the model has no known price. */
export function turnDollars(turn: Turn): number | null {
  const price = priceTable.models[turn.model.replace(/-\d{8}$/, '')];
  if (!price) return null;
  const u = turn.usage;
  const long = priceTable.longPrompt;
  const scale =
    turn.model.startsWith(long.model) &&
    u.input + u.cacheRead + u.cacheWrite5m + u.cacheWrite1h > long.tokens
      ? long.scale
      : 1;
  const input = price[0] * scale;
  const output = price[1] * scale;
  const read = price[2] * scale;
  return (
    (u.input * input +
      (u.cacheWrite5m * 1.25 + u.cacheWrite1h * 2) * input +
      u.cacheRead * read +
      u.output * output) /
    1e6
  );
}

const SLACK_MS = 10 * 60 * 1000;
/** How long before its PR opened a multi-day task's work can begin. */
const TASK_SPAN_MS = 48 * 60 * 60 * 1000;
function taskOf(title: string): string | undefined {
  return /\((t-[0-9a-z]{7})\)\s*$/.exec(title)?.[1];
}
/**
 * Whether a turn's commands name the PR: its task id, or `--pr N`, `#N` or
 * `gh pr <verb> N` once the PR exists (an earlier `#N` names something else).
 * A task spans many PRs and many sessions, so its id names this PR only after
 * `since`, when the task's previous PR merged, within two days before this PR
 * opened, and only in a turn naming no other task (a listing, which may still
 * name the PR by number).
 */
export function references(
  text: string,
  pr: SlicePr,
  at: number | null = null,
  since: number | null = null,
): boolean {
  const task = taskOf(pr.title);
  const created = Date.parse(String(pr.createdAt));
  // A turn naming several tasks lists them; only a turn naming this task alone works on it.
  const tasks = new Set(text.match(/\bt-[0-9a-z]{7}\b/g));
  if (task && tasks.size === 1 && tasks.has(task))
    return (
      at === null ||
      ((since === null || at > since) &&
        (!Number.isFinite(created) || at >= created - TASK_SPAN_MS))
    );
  if (at !== null && Number.isFinite(created) && at < created - SLACK_MS)
    return false;
  return new RegExp(
    `(?:--pr\\s+${pr.number}\\b|#${pr.number}\\b|\\bgh pr [a-z-]+ ${pr.number}\\b)`,
  ).test(text);
}

/** When each PR's task last merged a PR before this one opened; null when none did. */
function taskSince(prs: SlicePr[]): Map<SlicePr, number | null> {
  const result = new Map<SlicePr, number | null>();
  for (const pr of prs) {
    const task = taskOf(pr.title);
    const opened = Date.parse(String(pr.createdAt ?? pr.mergedAt));
    let since: number | null = null;
    for (const other of prs) {
      if (other === pr || !task || taskOf(other.title) !== task) continue;
      const merged = Date.parse(String(other.mergedAt));
      if (Number.isFinite(merged) && merged <= opened)
        since = Math.max(since ?? merged, merged);
    }
    result.set(pr, since);
  }
  return result;
}

/**
 * The PR of each turn. A PR's slice runs from its first to its last reference
 * made before it merged (plus slack); where slices overlap, a turn belongs to
 * the PR whose reference is nearest (ties to the inner slice), and a turn
 * between slices belongs to the next one. Turns before the first slice (resume)
 * or after the last (handoff, which may name the next task) belong to no PR.
 */
export function segmentTurns(turns: Turn[], prs: SlicePr[]): (number | null)[] {
  const since = taskSince(prs);
  const slices: {
    number: number;
    start: number;
    end: number;
    refs: number[];
  }[] = [];
  for (const pr of prs) {
    const merged = Date.parse(String(pr.mergedAt));
    const refs: number[] = [];
    turns.forEach((turn, i) => {
      if (
        turn.text &&
        references(turn.text, pr, turn.at, since.get(pr) ?? null) &&
        (turn.at === null ||
          !Number.isFinite(merged) ||
          turn.at <= merged + SLACK_MS)
      )
        refs.push(i);
    });
    const start = refs[0];
    const end = refs.at(-1);
    if (start !== undefined && end !== undefined)
      slices.push({ number: pr.number, start, end, refs });
  }
  const byStart = [...slices].sort((a, b) => a.start - b.start);
  const distance = (s: (typeof slices)[number], i: number) =>
    Math.min(...s.refs.map((r) => Math.abs(r - i)));
  return turns.map((_, i) => {
    const inside = slices
      .filter((s) => s.start <= i && i <= s.end)
      .sort(
        (a, b) =>
          distance(a, i) - distance(b, i) || b.start - a.start || a.end - b.end,
      );
    return (
      (
        inside[0] ??
        (byStart[0] && i > byStart[0].start
          ? byStart.find((s) => s.start > i)
          : undefined)
      )?.number ?? null
    );
  });
}

type SliceCost = {
  dollars: number | null;
  leadDollars: number | null;
  subagentDollars: number | null;
  turns: number;
  subagentTurns: number;
  /** Turns whose model has no price; their dollars are not counted. */
  unpricedTurns: number;
  /** Lead token totals of the slice's own turns; null when a transcript did not parse. */
  leadTokens: {
    input: number;
    cache_read: number;
    cache_creation: number;
    output: number;
  } | null;
  author: { role: string; model: string } | null;
};

/** Attribute every transcript's turns to PRs and total them per PR. */
export function sliceCosts(
  lead: Transcript[],
  subagents: Transcript[],
  prs: SlicePr[],
): Map<number, SliceCost> {
  const owner = new Map<string, number | null>();
  const parts = new Map<
    number,
    { transcript: Transcript; turns: Turn[]; lead: boolean }[]
  >();
  const add = (
    pr: number | null,
    t: Transcript,
    turn: Turn,
    isLead: boolean,
  ) => {
    if (pr === null) return;
    const list = parts.get(pr) ?? [];
    let part = list.find((p) => p.transcript === t);
    if (!part) {
      part = { transcript: t, turns: [], lead: isLead };
      list.push(part);
    }
    part.turns.push(turn);
    parts.set(pr, list);
  };
  for (const t of lead) {
    const segment = segmentTurns(t.turns, prs);
    t.turns.forEach((turn, i) => {
      for (const id of turn.tools) owner.set(id, segment[i] ?? null);
      add(segment[i] ?? null, t, turn, true);
    });
  }
  for (const t of subagents) {
    const segment = segmentTurns(t.turns, prs);
    const parent = t.parentTool ? (owner.get(t.parentTool) ?? null) : null;
    t.turns.forEach((turn, i) => {
      add(segment[i] ?? parent, t, turn, false);
    });
  }
  const result = new Map<number, SliceCost>();
  for (const [pr, list] of parts) {
    let lead = 0;
    let sub = 0;
    let unpriced = 0;
    let malformed = false;
    const tokens = { input: 0, cache_read: 0, cache_creation: 0, output: 0 };
    let best: {
      role: string;
      output: number;
      models: Map<string, number>;
    } | null = null;
    for (const part of list) {
      malformed ||= part.transcript.malformed;
      const models = new Map<string, number>();
      let output = 0;
      for (const turn of part.turns) {
        const d = turnDollars(turn);
        if (d === null) unpriced++;
        else if (part.lead) lead += d;
        else sub += d;
        if (part.lead) {
          tokens.input += turn.usage.input;
          tokens.cache_read += turn.usage.cacheRead;
          tokens.cache_creation +=
            turn.usage.cacheWrite5m + turn.usage.cacheWrite1h;
          tokens.output += turn.usage.output;
        }
        output += turn.usage.output;
        models.set(turn.model, (models.get(turn.model) ?? 0) + 1);
      }
      if (!best || output > best.output)
        best = { role: part.transcript.role, output, models };
    }
    const model = best
      ? ([...best.models].sort((a, b) => b[1] - a[1])[0]?.[0] ?? '')
      : '';
    const known = (v: number) => (malformed ? null : round2(v));
    result.set(pr, {
      dollars: known(lead + sub),
      leadDollars: known(lead),
      subagentDollars: known(sub),
      turns: list.filter((p) => p.lead).reduce((n, p) => n + p.turns.length, 0),
      subagentTurns: list
        .filter((p) => !p.lead)
        .reduce((n, p) => n + p.turns.length, 0),
      unpricedTurns: unpriced,
      leadTokens: malformed || !list.some((p) => p.lead) ? null : tokens,
      author: best ? { role: best.role, model } : null,
    });
  }
  return result;
}
const round2 = (v: number) => Math.round(v * 100) / 100;

export type Outcome =
  | { status: 'pending' | 'unknown' }
  | {
      status: 'kept' | 'changed' | 'reverted';
      added: number;
      surviving: number;
    };

/** Lines a commit added per file, from `git diff --numstat`; binary files are skipped. */
export function addedLines(numstat: string): Map<string, number> {
  const files = new Map<string, number>();
  for (const line of numstat.split('\n')) {
    const match = /^(\d+)\t\d+\t(.+)$/.exec(line);
    if (match && Number(match[1]) > 0 && !match[2]?.includes(' => '))
      files.set(match[2] ?? '', Number(match[1]));
  }
  return files;
}
/** Lines a `git blame --incremental` output attributes to the commit. */
export function survivingLines(incremental: string, sha: string): number {
  let lines = 0;
  for (const line of incremental.split('\n')) {
    const match = /^([0-9a-f]{40}) \d+ \d+ (\d+)$/.exec(line);
    if (match && match[1] === sha) lines += Number(match[2]);
  }
  return lines;
}
export function classifyOutcome(
  added: number,
  surviving: number,
  reverted: boolean,
): Outcome {
  if (reverted) return { status: 'reverted', added, surviving };
  return {
    status: surviving < added ? 'changed' : 'kept',
    added,
    surviving,
  };
}
