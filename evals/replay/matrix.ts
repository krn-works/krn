// The frozen A/B/C matrix in one run: every (unit, arm, rep) cell of the preregistration on one harness sha, each
// finished row appended at once, a rerun skipping the cells that already hold a graded or settled row. Units of one
// repository run oldest commit first, so arm C carries what its earlier failures taught (memory.ts); repositories run
// side by side, at most KRN_EVAL_MAX_SESSIONS at a time. Each cell checks the disk budget (src/repo/disk-budget.ts)
// before it clones, and its checkout goes with the cell (arm-session.ts).
import { appendFileSync, existsSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { budgetShortfall } from '../../src/repo/disk-budget.ts';
import { armBRow, formatTokens } from './arm-b.ts';
import { armCRow } from './arm-c.ts';
import { type ArmOptions, armRow } from './arm-session.ts';
import { ARMS, type ArmId } from './arms.ts';
import { DiskBudgetError, type LiveUnit } from './live.ts';
import { commitDateOrder, RepoMemory } from './memory.ts';
import { formatRow, type Row } from './rows.ts';
import { readRows } from './screen.ts';

export interface MatrixOptions extends ArmOptions {
  rowsFile: string;
  reps: number;
  arms?: ArmId[];
  /** Free-space probe in GB per directory (tests pass a stub); defaults to the host's statfs. */
  freeGb?: ((dir: string) => number | undefined) | undefined;
  /** Called with each row once it is appended, and with arm B's token line. */
  onRow?: (row: Row, extra?: string) => void;
  /** Date the arm-C memory records carry. */
  today?: string;
}

/** A rerun finds rows written by another harness: one matrix never mixes them. */
export class HarnessMismatchError extends Error {
  readonly exitCode = 69;
}

/** A row a rerun would not change: graded, or settled without a grade (no attempt, screened out). */
const finished = (r: Row): boolean =>
  r.pass !== null || r.verdict === 'no-attempt' || r.verdict === 'screened';

const cell = (r: Pick<Row, 'unit' | 'arm' | 'rep'>): string =>
  `${r.unit}/${r.arm}/${r.rep}`;

/** Arm A on the shared session path: the plain checkout and the task text, no preparation. */
export const armARow = (lu: LiveUnit, o: ArmOptions, rep: number) =>
  armRow(ARMS.A, lu, o, rep, () => undefined);

/** Runs the missing cells of `units` x arms x 1..reps; returns the rows this run wrote. */
export async function runMatrix(
  units: LiveUnit[],
  o: MatrixOptions,
): Promise<Row[]> {
  const existing = readRows(o.rowsFile);
  const foreign = [...new Set(existing.map((r) => r.harness))].filter(
    (h) => h !== o.harness,
  );
  if (foreign.length > 0)
    throw new HarnessMismatchError(
      `${o.rowsFile} holds rows of harness ${foreign.join(', ')}; this run is ${o.harness}`,
    );
  // An ungraded row (a session that hit a limit) is rerun, so it leaves the file instead of leaving a duplicate cell.
  if (existing.some((r) => !finished(r))) {
    const tmp = `${o.rowsFile}.tmp`;
    writeFileSync(
      tmp,
      existing
        .filter(finished)
        .map((r) => `${formatRow(r)}\n`)
        .join(''),
    );
    renameSync(tmp, o.rowsFile);
  }
  const done = new Map(existing.filter(finished).map((r) => [cell(r), r]));
  const arms = o.arms ?? (['A', 'B', 'C'] as ArmId[]);
  const today = o.today ?? new Date().toISOString().slice(0, 10);
  const written: Row[] = [];
  let stopped: DiskBudgetError | undefined;
  const stopOnBudget = () => {
    const short = budgetShortfall([o.scratch, dirname(o.rowsFile)], o.freeGb);
    if (short)
      throw new DiskBudgetError(
        `replay disk budget: only ${short.free.toFixed(1)} GB free under ${short.dir} (minimum ${short.minFree} GB, KRN_LANE_MIN_FREE_GB); stopped before cloning the next unit, rows so far are kept in ${o.rowsFile}`,
      );
  };
  stopOnBudget();
  if (!existsSync(o.rowsFile)) writeFileSync(o.rowsFile, '');
  const append = (row: Row, extra?: string) => {
    appendFileSync(o.rowsFile, `${formatRow(row)}\n`);
    written.push(row);
    o.onRow?.(row, extra);
  };
  const byRepo = new Map<string, LiveUnit[]>();
  for (const lu of commitDateOrder(units))
    byRepo.set(lu.unit.repo, [...(byRepo.get(lu.unit.repo) ?? []), lu]);
  const queue = [...byRepo.values()];
  const runRepo = async (repoUnits: LiveUnit[]) => {
    const memory = new RepoMemory();
    for (const lu of repoUnits)
      for (const arm of arms)
        for (let rep = 1; rep <= o.reps; rep++) {
          if (stopped) return;
          const have = done.get(cell({ unit: lu.unit.id, arm, rep }));
          if (have) {
            // A row from an earlier run still teaches the units after it.
            if (arm === 'C') memory.learn(lu, have, today);
            continue;
          }
          try {
            stopOnBudget();
          } catch (e) {
            stopped = e as DiskBudgetError;
            return;
          }
          const options = { ...o, memory: memory.forRepo(lu.unit.repo) };
          if (arm === 'A') append((await armARow(lu, options, rep)).row);
          else if (arm === 'B') {
            const b = await armBRow(lu, options, rep, today);
            append(b.row, b.tokens && formatTokens(lu.unit.id, b.tokens));
          } else {
            const row = await armCRow(lu, options, rep, today);
            memory.learn(lu, row, today);
            append(row);
          }
        }
  };
  const width = Math.max(
    1,
    Number((o.env ?? process.env).KRN_EVAL_MAX_SESSIONS) || 4,
  );
  await Promise.all(
    Array.from({ length: Math.min(width, queue.length) }, async () => {
      for (let repoUnits = queue.shift(); repoUnits; repoUnits = queue.shift())
        await runRepo(repoUnits);
    }),
  );
  if (stopped) throw stopped;
  return written;
}
