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
    };

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
