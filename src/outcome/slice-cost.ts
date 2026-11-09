// Per-slice cost: split each transcript into the turns of the PR it was working on, price them, and name the author.
type ObjectValue = Record<string, unknown>;

export type Usage = {
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

// USD per million tokens: base input, output, cache read. Cache writes cost 1.25x (5 min) and 2x (1 h) base input.
// Source: the claude-api skill reference shared/models.md (checked 2026-11-09); .krn/runs/token-cost/cost-scan.py uses the same table.
const PRICES: Record<string, readonly [number, number, number]> = {
  'claude-fable-5-1': [10, 50, 0.25],
  'claude-fable-5': [10, 50, 1],
  'claude-opus-5-5': [4, 20, 0.2],
  'claude-opus-5': [5, 25, 0.5],
  'claude-opus-4-8': [5, 25, 0.5],
  'claude-opus-4-7': [5, 25, 0.5],
  'claude-opus-4-6': [5, 25, 0.5],
  'claude-sonnet-5-5': [2, 10, 0.2],
  'claude-sonnet-5': [2, 10, 0.2],
  'claude-sonnet-4-6': [3, 15, 0.3],
  'claude-haiku-5-5': [0.1, 0.5, 0.01],
  'claude-haiku-4-5': [1, 5, 0.1],
};

/** Dollars for one turn, or null when the model has no known price. */
export function turnDollars(turn: Turn): number | null {
  const price = PRICES[turn.model.replace(/-\d{8}$/, '')];
  if (!price) return null;
  const u = turn.usage;
  // Haiku 5.5 prompts above 100K tokens bill every rate at five times the base.
  const scale =
    turn.model.startsWith('claude-haiku-5-5') &&
    u.input + u.cacheRead + u.cacheWrite5m + u.cacheWrite1h > 100_000
      ? 5
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
function taskOf(title: string): string | undefined {
  return /\((t-[0-9a-z]{7})\)\s*$/.exec(title)?.[1];
}
/**
 * Whether a turn's commands name the PR: its task id, or `--pr N`, `#N` or
 * `gh pr <verb> N` once the PR exists (an earlier `#N` names something else).
 */
export function references(
  text: string,
  pr: SlicePr,
  at: number | null = null,
): boolean {
  const task = taskOf(pr.title);
  if (task && new RegExp(`\\b${task}\\b`).test(text)) return true;
  const created = Date.parse(String(pr.createdAt));
  if (at !== null && Number.isFinite(created) && at < created - SLACK_MS)
    return false;
  return new RegExp(
    `(?:--pr\\s+${pr.number}\\b|#${pr.number}\\b|\\bgh pr [a-z-]+ ${pr.number}\\b)`,
  ).test(text);
}

/**
 * The PR of each turn. A PR's slice runs from its first to its last reference
 * made before it merged (plus slack); overlapping slices give a turn to the one
 * ending first, and a turn between slices belongs to the next one. Turns before
 * the first slice (resume) or after the last (handoff, which may name the next
 * task) belong to no PR.
 */
export function segmentTurns(turns: Turn[], prs: SlicePr[]): (number | null)[] {
  const slices: { number: number; start: number; end: number }[] = [];
  for (const pr of prs) {
    const merged = Date.parse(String(pr.mergedAt));
    let start = -1;
    let end = -1;
    turns.forEach((turn, i) => {
      if (
        turn.text &&
        references(turn.text, pr, turn.at) &&
        (turn.at === null ||
          !Number.isFinite(merged) ||
          turn.at <= merged + SLACK_MS)
      ) {
        if (start < 0) start = i;
        end = i;
      }
    });
    if (end >= 0) slices.push({ number: pr.number, start, end });
  }
  const byEnd = [...slices].sort((a, b) => a.end - b.end);
  const byStart = [...slices].sort((a, b) => a.start - b.start);
  return turns.map(
    (_, i) =>
      (
        byEnd.find((s) => s.start <= i && i <= s.end) ??
        (byStart[0] && i > byStart[0].start
          ? byStart.find((s) => s.start > i)
          : undefined)
      )?.number ?? null,
  );
}

export type SliceCost = {
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
