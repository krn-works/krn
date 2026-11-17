// The exposure log: one append-only line per lane run naming the standards the run was served,
// the ones it could have been served but was not, and how the run ended. `krn standards effect`
// derives per-record served-vs-withheld numbers from it. The same records score plan predictions:
// a task's `Predicted:` line is judged against a lane's proof line or the outside rows (`krn ledger --predictions`).
import { execFileSync } from 'node:child_process';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { assertFormat } from '../repo/formats.ts';
import { metricReader } from './metrics.ts';

/** Where the log lives, relative to the main checkout. */
export const EXPOSURES_FILE = '.krn/brain/exposures.jsonl';

export type Outcome = 'followed' | 'violated';

/** The row schema: one line per run, carrying a per-record effect. */
export const EXPOSURE_SCHEMA = 'krn.exposure/v1';

export type Exposure = {
  schema: typeof EXPOSURE_SCHEMA;
  /** ISO time the row was written. */
  at: string;
  run: string;
  task: string | null;
  channel: string;
  /** The n-th run of this task on this channel (1 for the first). */
  attempt: number;
  served: string[];
  /** Records a Stop refused the session over: refusals, never served exposures. */
  refused?: string[];
  /** Exactly the records the packet would have served without the holdout that the holdout kept out. */
  withheld: string[];
  /** Tokens of the packet the run was served. */
  tokens: number;
  /** Per served or withheld record: did its own check fail on the final diff. Null when the record has no check or the diff was not checked. */
  violated: Record<string, boolean | null>;
  /** Derived from `violated`: followed or violated for the served records that were checked. */
  outcome: Record<string, Outcome>;
  lane_ok: boolean;
  /** The file kind an edit-moment exposure served (`php`, `*.css`), so the moment fires once per kind and session. */
  scope?: string;
  /** The lane's proof line (clauses, red-first, precedent, Stop refusals), when the run ended with one. */
  proof?: string;
  /** What the closing PR of the task wrote back: its number, the aggregate Check conclusion and the hidden-test result; each null when unknown. */
  evidence?: CloseEvidence;
};

export type CloseEvidence = {
  pr: number | null;
  ci: string | null;
  hidden: string | null;
};

const outcomeOf = (
  served: readonly string[],
  violated: Readonly<Record<string, boolean | null>>,
): Record<string, Outcome> =>
  Object.fromEntries(
    served.flatMap((id) => {
      const value = violated[id];
      return value === null || value === undefined
        ? []
        : [[id, value ? 'violated' : 'followed'] as const];
    }),
  );

/** The exposure of one finished run. A served record is violated only when its own check says so; the run outcome is never copied onto it. */
export function exposureOf(input: {
  run: string;
  task: string | undefined;
  channel: string;
  served: readonly string[];
  withheld: readonly string[];
  refused?: readonly string[];
  laneOk: boolean;
  attempt?: number;
  tokens?: number;
  /** Per-record check results; a served record missing here is null. */
  violated?: Readonly<Record<string, boolean | null>>;
  at?: string;
  proof?: string;
  evidence?: CloseEvidence;
}): Exposure {
  const violated = Object.fromEntries(
    [...input.served, ...input.withheld, ...(input.refused ?? [])].map((id) => [
      id,
      input.violated?.[id] ?? null,
    ]),
  );
  return {
    schema: EXPOSURE_SCHEMA,
    at: input.at ?? new Date().toISOString(),
    run: input.run,
    task: input.task ?? null,
    channel: input.channel,
    attempt: input.attempt ?? 1,
    served: [...input.served],
    withheld: [...input.withheld],
    ...(input.refused === undefined || input.refused.length === 0
      ? {}
      : { refused: [...input.refused] }),
    tokens: input.tokens ?? 0,
    violated,
    outcome: outcomeOf(input.served, violated),
    lane_ok: input.laneOk,
    ...(input.proof === undefined ? {} : { proof: input.proof }),
    ...(input.evidence === undefined ? {} : { evidence: input.evidence }),
  };
}

/** Appends one exposure; a run that served, withheld and proved nothing leaves no line. */
export function appendExposure(main: string, exposure: Exposure): void {
  if (
    exposure.served.length === 0 &&
    exposure.withheld.length === 0 &&
    (exposure.refused ?? []).length === 0 &&
    exposure.proof === undefined &&
    exposure.evidence === undefined
  )
    return;
  const path = join(main, EXPOSURES_FILE);
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify(exposure)}\n`);
}

/** A row of the log, with the fields older rows lack filled in: only a refused Stop recorded per-record violations then. */
function normalized(row: Partial<Exposure>): Exposure {
  const served = row.served ?? [];
  const violated =
    row.violated ??
    Object.fromEntries(
      [...served, ...(row.withheld ?? [])].map((id) => [
        id,
        row.channel === 'stop' && row.outcome?.[id] === 'violated'
          ? true
          : null,
      ]),
    );
  return {
    schema: EXPOSURE_SCHEMA,
    at: row.at ?? '',
    run: row.run ?? '',
    task: row.task ?? null,
    channel: row.channel ?? '',
    attempt: row.attempt ?? 1,
    served: [...served],
    withheld: [...(row.withheld ?? [])],
    ...(row.refused === undefined ? {} : { refused: [...row.refused] }),
    tokens: row.tokens ?? 0,
    violated,
    outcome: outcomeOf(served, violated),
    lane_ok: row.lane_ok ?? true,
    ...(row.scope === undefined ? {} : { scope: row.scope }),
    ...(row.proof === undefined ? {} : { proof: row.proof }),
    ...(row.evidence === undefined ? {} : { evidence: row.evidence }),
  };
}

/** Every exposure of the log, in order; blank lines are skipped and a malformed line is an error. */
export function readExposures(main: string): Exposure[] {
  assertFormat(main, 'krn.exposure');
  const path = join(main, EXPOSURES_FILE);
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line, index) => {
      try {
        return normalized(JSON.parse(line) as Partial<Exposure>);
      } catch {
        throw new Error(`${EXPOSURES_FILE}:${index + 1}: not JSON`);
      }
    });
}

/** Per record, over distinct (task, record, arm): runs served or withheld, and among them those whose own check ran on the diff. */
export type EffectTotals = {
  served: number;
  /** Served runs whose check ran (violated is not null). */
  servedScoped: number;
  servedViolated: number;
  withheld: number;
  withheldScoped: number;
  withheldViolated: number;
};

/**
 * Per record: served and withheld runs with their check results. A run of a task counts once per
 * (task, record, arm), its latest attempt, so a rerun does not count a record twice. Rows without a
 * task count each.
 */
export function effectTotals(
  exposures: readonly Exposure[],
): Map<string, EffectTotals> {
  type Cell = { id: string; arm: 'served' | 'withheld'; value: boolean | null };
  const cells = new Map<string, Cell>();
  exposures.forEach((exposure, index) => {
    const add = (id: string, arm: Cell['arm']): void => {
      const key =
        exposure.task === null
          ? `#${index}\0${id}\0${arm}`
          : `${exposure.task}\0${id}\0${arm}`;
      cells.set(key, { id, arm, value: exposure.violated[id] ?? null });
    };
    for (const id of exposure.served) add(id, 'served');
    for (const id of exposure.withheld) add(id, 'withheld');
  });
  const rows = new Map<string, EffectTotals>();
  for (const { id, arm, value } of cells.values()) {
    let row = rows.get(id);
    if (row === undefined) {
      row = {
        served: 0,
        servedScoped: 0,
        servedViolated: 0,
        withheld: 0,
        withheldScoped: 0,
        withheldViolated: 0,
      };
      rows.set(id, row);
    }
    row[arm]++;
    if (value === null) continue;
    row[`${arm}Scoped`]++;
    if (value) row[`${arm}Violated`]++;
  }
  return rows;
}

const rate = (bad: number, n: number): string =>
  n === 0 ? '-' : `${Math.round((100 * bad) / n)}%`;

/** One row per record: served and withheld runs, and how often the record's own check failed in each arm. */
export function effectRows(exposures: readonly Exposure[]): string[] {
  return [...effectTotals(exposures).entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(
      ([id, v]) =>
        `${id}: served ${v.served} (scoped ${v.servedScoped}, violated ${rate(v.servedViolated, v.servedScoped)}) withheld ${v.withheld} (scoped ${v.withheldScoped}, violated ${rate(v.withheldViolated, v.withheldScoped)})`,
    );
}

/** The channels whose packets are keyed by a task: the session start and the lane brief. */
const TASK_PACKETS = new Set(['session', 'lane']);

/**
 * Mean Jaccard overlap of the served record sets of different tasks: each task's set is the union of
 * its session and lane packets (a run without a task counts as its own). Null when fewer than two sets exist.
 */
export function servedOverlap(
  exposures: readonly Exposure[],
): { mean: number; pairs: number; tasks: number } | null {
  const sets = new Map<string, Set<string>>();
  for (const row of exposures) {
    if (!TASK_PACKETS.has(row.channel) || row.served.length === 0) continue;
    const key = row.task ?? `run:${row.run}`;
    const set = sets.get(key) ?? new Set<string>();
    for (const id of row.served) set.add(id);
    sets.set(key, set);
  }
  const all = [...sets.values()];
  let total = 0;
  let pairs = 0;
  for (let i = 0; i < all.length; i += 1)
    for (let j = i + 1; j < all.length; j += 1) {
      const a = all[i] as Set<string>;
      const b = all[j] as Set<string>;
      const shared = [...a].filter((id) => b.has(id)).length;
      total += shared / (a.size + b.size - shared);
      pairs += 1;
    }
  return pairs === 0 ? null : { mean: total / pairs, pairs, tasks: all.length };
}

/** A served packet whose outcome is not known yet (the session has just started): no per-record result. */
export function servedExposure(
  run: string,
  channel: string,
  served: readonly string[],
  tokens = 0,
): Exposure {
  return exposureOf({
    run,
    task: undefined,
    channel,
    served,
    withheld: [],
    laneOk: true,
    tokens,
  });
}

/** A refused Stop: each record the session still violated, so the effect report counts the violation. */
export function violatedExposure(
  run: string,
  ids: readonly string[],
): Exposure {
  return exposureOf({
    run,
    task: undefined,
    channel: 'stop',
    served: ids,
    withheld: [],
    laneOk: false,
    violated: Object.fromEntries(ids.map((id) => [id, true])),
  });
}

export type Verdict = 'hit' | 'miss' | 'unmeasured';

type Op = '>=' | '<=' | '==' | '>' | '<';

type Claim =
  | { source: 'proof'; field: string; op: Op; value: number }
  | {
      source: 'outside';
      field: string;
      op: Op;
      value: number;
      rowsOp: Op;
      rows: number;
    }
  | { source: 'metric'; field: string; op: Op; value: number };

const OP = '(>=|<=|==|>|<)';
const PROOF_FIELDS = [
  'clauses',
  'clauses-total',
  'red-first',
  'precedent',
  'stop-refusals',
] as const;
/** Outside-row columns a claim may name, in the order summary.txt holds them. */
const OUTSIDE_FIELDS = [
  'repo',
  'stack',
  'adopt',
  'first-test',
  'drain',
  'prs',
  'sessions',
  'usd',
  'hidden',
  'hook',
] as const;

/** The outside rows file, relative to the main checkout. */
export const OUTSIDE_SUMMARY = '.krn/runs/outside/summary.txt';

const PROOF_CLAIM = new RegExp(
  `^proof\\s+([a-z-]+)\\s*${OP}\\s*(\\d+(?:\\.\\d+)?)$`,
  'u',
);
const OUTSIDE_CLAIM = new RegExp(
  `^outside\\s+([a-z-]+)\\s*${OP}\\s*(\\d+(?:\\.\\d+)?)\\s+in\\s*${OP}\\s*(\\d+)\\s+rows$`,
  'u',
);

const METRIC_CLAIM = new RegExp(
  `^metric\\s+([a-z][a-z0-9-]*)\\s*${OP}\\s*(\\d+(?:\\.\\d+)?)$`,
  'u',
);

/** The claim of a `Predicted:` line, or undefined when the line is absent or not measurable. */
export function parseClaim(text: string): Claim | undefined {
  const line = /^[ \t]*Predicted:[ \t]*(.*)$/imu.exec(text)?.[1]?.trim();
  if (line === undefined) return undefined;
  const proof = PROOF_CLAIM.exec(line);
  if (
    proof !== null &&
    (PROOF_FIELDS as readonly string[]).includes(proof[1] ?? '')
  )
    return {
      source: 'proof',
      field: proof[1] as string,
      op: proof[2] as Op,
      value: Number(proof[3]),
    };
  const metric = METRIC_CLAIM.exec(line);
  if (metric !== null)
    return {
      source: 'metric',
      field: metric[1] as string,
      op: metric[2] as Op,
      value: Number(metric[3]),
    };
  const outside = OUTSIDE_CLAIM.exec(line);
  if (
    outside !== null &&
    (OUTSIDE_FIELDS as readonly string[]).includes(outside[1] ?? '')
  )
    return {
      source: 'outside',
      field: outside[1] as string,
      op: outside[2] as Op,
      value: Number(outside[3]),
      rowsOp: outside[4] as Op,
      rows: Number(outside[5]),
    };
  return undefined;
}

function holds(actual: number, op: Op, wanted: number): boolean {
  if (op === '>=') return actual >= wanted;
  if (op === '<=') return actual <= wanted;
  if (op === '==') return actual === wanted;
  return op === '>' ? actual > wanted : actual < wanted;
}

/** The counts of a proof line (`proof: clauses 2/3, red-first 0, precedent 5 modules, stop refusals 1`). */
export function parseProofLine(
  line: string,
): Record<string, number> | undefined {
  const m =
    /proof: clauses (\d+)\/(\d+), red-first (\d+), precedent (\d+) modules, stop refusals (\d+)/u.exec(
      line,
    );
  if (m === null) return undefined;
  return {
    clauses: Number(m[1]),
    'clauses-total': Number(m[2]),
    'red-first': Number(m[3]),
    precedent: Number(m[4]),
    'stop-refusals': Number(m[5]),
  };
}

/** The rows of an outside summary: lines of eight or more ` | ` cells that start with `owner/repo`. */
export function parseOutsideRows(text: string): string[][] {
  return text
    .split('\n')
    .filter((line) => /^[\w.-]+\/[\w.-]+ /u.test(line))
    .map((line) => line.split(' | ').map((cell) => cell.trim()))
    .filter((cells) => cells.length >= OUTSIDE_FIELDS.indexOf('hidden'));
}

function numeric(cell: string | undefined): number | undefined {
  if (cell === 'pass') return 1;
  if (cell === 'fail') return 0;
  const bare = (cell ?? '').replace(/^\$/u, '');
  return /^\d+(?:\.\d+)?$/u.test(bare) ? Number(bare) : undefined;
}

export type Records = {
  /** Proof line per task id, the latest exposure of the task that carries one. */
  proofs: ReadonlyMap<string, string>;
  /** Outside rows, or undefined when the file is missing. */
  outside: string[][] | undefined;
  /**
   * Merge commit per task id. When present, an outside claim scores only rows whose hook commit
   * descends from its task's merge; a task without a merge commit is unmeasured.
   */
  merges?: ReadonlyMap<string, string>;
  /** A registered metric's current value (`spec/metrics.json`); undefined when unregistered or its command fails. */
  metric?: (name: string) => number | undefined;
  /** True when `commit` is `ancestor` or contains it; required with `merges`. */
  descends?: (ancestor: string, commit: string) => boolean;
};

/** Judges one claim: hit or miss from the records, unmeasured when they hold no value for it. */
export function judge(claim: Claim, taskId: string, records: Records): Verdict {
  if (claim.source === 'proof') {
    const counts = parseProofLine(records.proofs.get(taskId) ?? '');
    const actual = counts?.[claim.field];
    if (actual === undefined) return 'unmeasured';
    return holds(actual, claim.op, claim.value) ? 'hit' : 'miss';
  }
  if (claim.source === 'metric') {
    const actual = records.metric?.(claim.field);
    if (actual === undefined) return 'unmeasured';
    return holds(actual, claim.op, claim.value) ? 'hit' : 'miss';
  }
  const column = OUTSIDE_FIELDS.indexOf(
    claim.field as (typeof OUTSIDE_FIELDS)[number],
  );
  let rows = records.outside ?? [];
  if (records.merges !== undefined) {
    const merge = records.merges.get(taskId);
    const hookColumn = OUTSIDE_FIELDS.indexOf('hook');
    const descends = records.descends;
    if (merge === undefined || descends === undefined) return 'unmeasured';
    rows = rows.filter((row) => {
      const hook = row[hookColumn] ?? '';
      return /^[0-9a-f]{7,40}$/u.test(hook) && descends(merge, hook);
    });
  }
  const values = rows
    .map((row) => numeric(row[column]))
    .filter((v): v is number => v !== undefined);
  if (values.length === 0) return 'unmeasured';
  const count = values.filter((v) => holds(v, claim.op, claim.value)).length;
  return holds(count, claim.rowsOp, claim.rows) ? 'hit' : 'miss';
}

type Task = {
  id: string;
  status: string;
  text: string;
};

/** The plan a task belongs to: its `Source:` line, else the `Why:` line, cut at the first `;`, sentence end or `slice N`. */
export function planOf(text: string): string {
  const named =
    /^[ \t]*Source:[ \t]*(.+)$/imu.exec(text)?.[1] ??
    /^[ \t]*Why:[ \t]*(.+)$/imu.exec(text)?.[1];
  return (
    (named ?? 'no plan named').split(/;|\.\s|\s+slice\s+\d+/iu)[0]?.trim() ||
    'no plan named'
  );
}

export type Scorecard = Map<
  string,
  { hit: string[]; miss: string[]; unmeasured: string[]; unpredicted: string[] }
>;

/** One scorecard entry per plan over the closed tasks; `unpredicted` counts tasks without a measurable `Predicted:` line. */
export function scoreTasks(
  tasks: readonly Task[],
  records: Records,
): Scorecard {
  const card: Scorecard = new Map();
  for (const task of tasks) {
    if (task.status !== 'closed') continue;
    const plan = planOf(task.text);
    const entry = card.get(plan) ?? {
      hit: [],
      miss: [],
      unmeasured: [],
      unpredicted: [],
    };
    card.set(plan, entry);
    const claim = parseClaim(task.text);
    if (claim === undefined) entry.unpredicted.push(task.id);
    else entry[judge(claim, task.id, records)].push(task.id);
  }
  return card;
}

export function readTaskTexts(root: string): Task[] {
  const dir = join(root, 'tasks');
  if (!existsSync(dir)) return [];
  const tasks: Task[] = [];
  for (const name of readdirSync(dir).filter((n) => n.endsWith('.json'))) {
    try {
      const t = JSON.parse(readFileSync(join(dir, name), 'utf8')) as {
        id?: unknown;
        status?: unknown;
        body?: unknown;
      };
      tasks.push({
        id: String(t.id ?? name),
        status: String(t.status ?? ''),
        text: Array.isArray(t.body) ? t.body.join('\n') : '',
      });
    } catch {
      // an unreadable record is `krn task check`'s finding
    }
  }
  return tasks.sort((a, b) => a.id.localeCompare(b.id));
}

export function readRecords(root: string): Records {
  const proofs = new Map<string, string>();
  for (const e of readExposures(root))
    if (e.task !== null && e.proof !== undefined) proofs.set(e.task, e.proof);
  const path = join(root, OUTSIDE_SUMMARY);
  return {
    proofs,
    outside: existsSync(path)
      ? parseOutsideRows(readFileSync(path, 'utf8'))
      : undefined,
    metric: metricReader(root),
    merges: mergeCommits(root),
    descends: (ancestor, commit) => isAncestor(root, ancestor, commit),
  };
}

function git(root: string, args: string[]): string | undefined {
  try {
    return execFileSync('git', ['-C', root, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return undefined;
  }
}

/** The oldest commit on HEAD per task id that carries a `Ticket: <id>` trailer: the commit the task merged as. */
function mergeCommits(root: string): Map<string, string> {
  const merges = new Map<string, string>();
  const log = git(root, [
    'log',
    '--reverse',
    '--format=%H %(trailers:key=Ticket,valueonly,separator=%x20)%x1e',
  ]);
  for (const entry of (log ?? '').split('\x1e')) {
    const [sha, ...ids] = entry.trim().split(/\s+/u);
    for (const id of ids) if (sha && !merges.has(id)) merges.set(id, sha);
  }
  return merges;
}

function isAncestor(root: string, ancestor: string, commit: string): boolean {
  return (
    git(root, ['merge-base', '--is-ancestor', ancestor, commit]) !== undefined
  );
}

/** The scorecard text: one line per plan with its hit, miss, unmeasured and unpredicted counts. */
export function renderScorecard(card: Scorecard): string {
  const lines = ['plan | hit | miss | unmeasured | unpredicted'];
  for (const [plan, e] of [...card].sort((a, b) => a[0].localeCompare(b[0])))
    lines.push(
      `${plan} | ${e.hit.length} | ${e.miss.length} | ${e.unmeasured.length} | ${e.unpredicted.length}`,
    );
  return `${lines.join('\n')}\n`;
}

export function predictionScorecard(root: string): string {
  return renderScorecard(scoreTasks(readTaskTexts(root), readRecords(root)));
}

/** Share of the plan's tasks (ids in `docs/program/plan.md` rows) that are closed and scored hit or miss. */
export function planScoredShare(root: string): number {
  const planPath = join(root, 'docs/program/plan.md');
  if (!existsSync(planPath)) return 0;
  const ids = new Set(
    [
      ...readFileSync(planPath, 'utf8').matchAll(/\[S\d+ (t-[0-9a-z]+)\]/gu),
    ].map((m) => m[1] as string),
  );
  if (ids.size === 0) return 0;
  const records = readRecords(root);
  let scored = 0;
  for (const task of readTaskTexts(root)) {
    if (!ids.has(task.id) || task.status !== 'closed') continue;
    const claim = parseClaim(task.text);
    if (claim !== undefined && judge(claim, task.id, records) !== 'unmeasured')
      scored++;
  }
  return scored / ids.size;
}
