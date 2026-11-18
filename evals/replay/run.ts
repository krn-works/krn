// Usage: node evals/replay/run.ts --arms A,B,C --units <n> [--reps <n>] [--dry]
// --prereg evals/replay/abc.prereg.md --report [--rows <file>] [--strict] prints one verdict line per contrast (Holm-adjusted) and the cost co-primary; 65 with no graded row.
// --screen runs live arm-A sessions (evals/replay/live.ts) then reports; --screen --report only reports recorded rows,
// then a contamination line: the rows whose session reached the upstream fix, read from the transcripts under --scratch.
// --screen --model <m> --rows <file> runs them on another model; a Codex model (gpt-6.2-sol) runs on `codex exec`.
// --screen --session-minutes <n> lowers every attempt's time cap (default 30), the gate's re-prompt included.
// --screen --record <dir> keeps each graded session's patch and grade (default .krn/runs/screen-recordings when
// --rows is not given);
// --screen --grade-preflight grades every eligible unit's base and reference with its exact grader and starts no
// session: one line per unit, exit 0 when each is red at base and green at the reference, 1 when one is screened out;
// --screen --replay <dir> grades every recorded patch on a fresh unit.base checkout with no model session and exits
// 0 when each replayed grade equals the recorded one, 1 when one differs, 65 when none replays.
// One runner for every replay arm. --dry prints one row per (unit, arm, rep) without starting a session; without
// --dry, --arms B,C run each row live through the session driver: C on a KRN-adopted checkout (arm-c.ts), B on a
// checkout with the in-force records as a static CLAUDE.md (arm-b.ts), which also prints its token counts.
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mainCheckoutRoot } from '../../src/task/claims.ts';
import { loadUnits } from '../units/unit.ts';
import { analyze, matrixProblems, parsePrereg, reportLines } from './abc.ts';
import { armBRow, formatTokens } from './arm-b.ts';
import { armCRow } from './arm-c.ts';
import { type Arm, parseArms } from './arms.ts';
import { contaminationLines, scanRows } from './contamination.ts';
import { preflightOnce, sandboxedCommitGrade } from './grade-preflight.ts';
import { type LiveUnit, screenLive } from './live.ts';
import { readRecordings, replayRecording, replayVerdict } from './recording.ts';
import { formatRow, harnessSha, type Row } from './rows.ts';
import {
  attemptLines,
  eligible,
  firstFailingLine,
  readRows,
  report,
  type ScreenUnit,
  screen,
} from './screen.ts';

const here = dirname(fileURLToPath(import.meta.url));

// The screening clones live once, in the main checkout: a run started from a linked worktree (as `krn pr ship` runs
// the plan proof) or from another directory still finds them.
export function defaultSources(from: string = here): string {
  return join(mainCheckoutRoot(from), '.krn', 'sources', 'screening');
}

export function plan(opts: {
  arms: Arm[];
  units: string[];
  reps: number;
  harness: string;
}): Row[] {
  const rows: Row[] = [];
  for (const unit of opts.units)
    for (const arm of opts.arms)
      for (let rep = 1; rep <= opts.reps; rep++)
        rows.push({
          unit,
          arm: arm.id,
          rep,
          pass: null,
          cost: null,
          harness: opts.harness,
        });
  return rows;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const flag = (n: string) => {
    const i = args.indexOf(`--${n}`);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const prereg = flag('prereg');
  if (prereg !== undefined) {
    // --prereg <file> --report [--rows <file>]: one verdict per contrast over recorded rows; 65 when none is graded.
    const frozen = parsePrereg(readFileSync(prereg, 'utf8'));
    const rows = readRows(flag('rows') ?? join(here, 'abc-rows.jsonl'));
    if (args.includes('--strict')) {
      // Before any significance test: the rows must be the whole preregistered matrix from one harness and model.
      const problems = matrixProblems(rows, frozen);
      if (problems.length > 0) {
        for (const p of problems.slice(0, 20)) console.error(`matrix: ${p}`);
        console.error(
          `verdict: matrix incomplete or mixed (${problems.length} problems)`,
        );
        process.exit(65);
      }
    }
    const result = analyze(rows, frozen);
    if (result.graded === 0) {
      console.error('no graded rows for the frozen units');
      process.exit(65);
    }
    for (const l of reportLines(result, frozen)) console.log(l);
    process.exit(0);
  }
  if (args.includes('--screen')) {
    const loaded = loadUnits(flag('units-dir') ?? join(here, '..', 'units'));
    const units = loaded.map((u) => u.unit as ScreenUnit);
    const rowsFile = flag('rows') ?? join(here, 'screen-rows.jsonl');
    const sources = flag('sources') ?? defaultSources();
    const scratch = flag('scratch') ?? join(tmpdir(), 'krn-screen-live');
    const replay = flag('replay');
    if (replay !== undefined) {
      const byId = new Map(loaded.map((u) => [u.unit.id, u]));
      const results = [];
      for (const r of readRecordings(replay)) {
        const u = byId.get(r.unit);
        if (!u) {
          results.push({ recording: r, pass: null, error: 'no such unit' });
          continue;
        }
        results.push(
          await replayRecording(r, u.unit, u.dir, {
            sources,
            scratch,
            dir: replay,
          }),
        );
      }
      const v = replayVerdict(results);
      for (const l of v.lines) console.log(l);
      process.exit(v.code);
    }
    if (args.includes('--grade-preflight')) {
      const check = preflightOnce(
        sandboxedCommitGrade({ sources, scratch }),
        join(dirname(resolve(rowsFile)), 'grade-preflight'),
      );
      const ok = new Set(eligible(units).map((u) => u.id));
      let screened = 0;
      for (const lu of loaded.filter((u) => ok.has(u.unit.id))) {
        const c = await check(lu);
        if (!c.ok) screened++;
        console.log(
          `preflight ${lu.unit.id} ${c.ok ? 'ok' : `screened (${c.reasons.join('; ')})${c.tail ? ` grade: ${firstFailingLine(c.tail) ?? ''}` : ''}`}`,
        );
      }
      console.log(
        `verdict: ${ok.size - screened} of ${ok.size} units gradable, ${screened} screened out`,
      );
      process.exit(screened === 0 ? 0 : 1);
    }
    if (!args.includes('--report') && flag('metric') === undefined)
      await screenLive(loaded, {
        sources,
        scratch,
        rowsFile,
        // The tracked screening run records by default; a run into another rows file records only when asked.
        recordings:
          flag('record') ??
          (flag('rows') === undefined
            ? join(here, '..', '..', '.krn', 'runs', 'screen-recordings')
            : undefined),
        harness: harnessSha(here),
        reps: Number(flag('reps') ?? 1),
        model: flag('model'),
        ...(flag('session-minutes') === undefined
          ? {}
          : { sessionMs: Number(flag('session-minutes')) * 60_000 }),
      });
    const s = screen(units, readRows(rowsFile));
    if (flag('metric') === 'screen-a-pass-rate') {
      if (s.passRate === null) process.exit(65);
      console.log(s.passRate.toFixed(3));
    } else {
      for (const l of attemptLines(readRows(rowsFile))) console.log(l);
      for (const l of report(s)) console.log(l);
      for (const l of contaminationLines(scanRows(rowsFile, scratch)))
        console.log(l);
    }
    process.exit(0);
  }
  const dry = args.includes('--dry');
  const arms = parseArms(flag('arms') ?? 'A,B,C');
  const count = Number(flag('units') ?? 1);
  const reps = Number(flag('reps') ?? 1);
  const unitsDir = flag('units-dir') ?? join(here, '..', 'units');
  const all = loadUnits(unitsDir).map((u) => u.unit as ScreenUnit);
  // A live row grades with the hidden test, so it draws only from verified units, like the screening run.
  const ids = (dry ? all : eligible(all))
    .map((u) => u.id)
    .sort()
    .slice(0, count);
  if (ids.length < count) {
    console.error(`only ${ids.length} units available, ${count} requested`);
    process.exit(64);
  }
  if (!dry) {
    // Live rows run arms B and C through the session driver; arm A lives only under --screen.
    if (arms.some((a) => a.id === 'A')) {
      console.error('live rows run arms B and C; arm A runs under --screen');
      process.exit(69);
    }
    const byId = new Map(loadUnits(unitsDir).map((u) => [u.unit.id, u]));
    const scratch = flag('scratch') ?? join(tmpdir(), 'krn-replay-live');
    const harness = harnessSha(here);
    const model = flag('model');
    const modelOption = model === undefined ? {} : { model };
    const rows: Row[] = [];
    for (const id of ids)
      for (const arm of arms)
        for (let rep = 1; rep <= reps; rep++) {
          const options = {
            sources: flag('sources') ?? defaultSources(),
            scratch,
            harness,
            ...modelOption,
          };
          const unit = byId.get(id) as LiveUnit;
          let row: Row;
          if (arm.id === 'B') {
            const b = await armBRow(unit, options, rep);
            row = b.row;
            console.log(formatRow(row));
            if (b.tokens !== undefined) console.log(formatTokens(id, b.tokens));
          } else {
            row = await armCRow(unit, options, rep);
            console.log(formatRow(row));
          }
          rows.push(row);
        }
    const graded = rows.filter((r) => r.pass !== null);
    console.log(
      `verdict: ${rows.length} rows, ${graded.length} graded, ${graded.filter((r) => r.pass).length} pass`,
    );
    process.exit(graded.length === rows.length ? 0 : 1);
  }
  const rows = plan({ arms, units: ids, reps, harness: harnessSha(here) });
  for (const r of rows) console.log(formatRow(r));
  console.log(`verdict: ${rows.length} rows`);
}
