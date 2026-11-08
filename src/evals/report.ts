import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { flagValue } from '../cli/flag-value.ts';
import { CliUsageError } from '../cli/usage-error.ts';
import {
  EvalDataError,
  type Fr40Manifest,
  fr40Manifest,
  loadManifest,
} from './manifest.ts';
import { planExperiment } from './plan.ts';
import { runDirectory } from './score.ts';
import { bonettPrice, mcnemarOneSided } from './stats.ts';

const usage =
  'usage: krn eval report --experiment <dir> --root <dir> [--draft] [--json]';

type Arm = 'A' | 'B' | 'S';
const ARMS: readonly Arm[] = ['A', 'B', 'S'];

/** One run's outcome as read from its evidence directory. */
export type Outcome = {
  readonly task: string;
  readonly arm: Arm;
  readonly status: 'pass' | 'fail' | 'error' | 'missing';
  readonly tokens: number | null;
};

export type Comparison = {
  readonly units: number;
  readonly wins: number;
  readonly losses: number;
  readonly difference: number;
  readonly p: number;
  readonly lower: number;
  readonly upper: number;
};

export type Verdict = 'GO' | 'KILL' | 'INCONCLUSIVE' | 'CONTINUE' | 'STOP';

export type Report = ReturnType<typeof analyse>;

function compare(
  units: readonly string[],
  passed: (task: string, arm: Arm) => boolean,
  x: Arm,
  y: Arm,
  level: number,
): Comparison {
  let wins = 0;
  let losses = 0;
  for (const task of units) {
    const a = passed(task, x);
    const b = passed(task, y);
    if (a && !b) wins += 1;
    if (b && !a) losses += 1;
  }
  const n = units.length;
  return {
    units: n,
    wins,
    losses,
    difference: n === 0 ? 0 : (wins - losses) / n,
    p: mcnemarOneSided(wins + losses, wins),
    ...bonettPrice(wins, losses, n, level),
  };
}

/**
 * Fixed-strata analysis (decisions 2026-11-08): units are tasks scored in all
 * three arms; the primary test pools discordant units across strata, and the
 * per-stratum table is descriptive.
 */
export function analyse(
  manifest: Pick<Fr40Manifest, 'id' | 'frozen' | 'tasks' | 'analysis'>,
  outcomes: readonly Outcome[],
) {
  const { analysis } = manifest;
  const byKey = new Map(outcomes.map((o) => [`${o.task}\0${o.arm}`, o]));
  const outcome = (task: string, arm: Arm) => byKey.get(`${task}\0${arm}`);
  const passed = (task: string, arm: Arm) =>
    outcome(task, arm)?.status === 'pass';
  const scored = (o: Outcome | undefined) =>
    o?.status === 'pass' || o?.status === 'fail';
  const units = manifest.tasks
    .map((task) => task.id)
    .filter((task) => ARMS.every((arm) => scored(outcome(task, arm))));
  const arms = ARMS.map((arm) => {
    const passes = units.filter((task) => passed(task, arm)).length;
    return {
      arm,
      passes,
      units: units.length,
      rate: units.length === 0 ? 0 : passes / units.length,
    };
  });
  const strata = [...new Set(manifest.tasks.map((task) => task.stratum))].map(
    (stratum) => {
      const members = manifest.tasks
        .filter((task) => task.stratum === stratum && units.includes(task.id))
        .map((task) => task.id);
      return {
        stratum,
        units: members.length,
        passes: Object.fromEntries(
          ARMS.map((arm) => [
            arm,
            members.filter((task) => passed(task, arm)).length,
          ]),
        ) as Record<Arm, number>,
      };
    },
  );
  const bMinusA = compare(units, passed, 'B', 'A', analysis.level);
  const bMinusS = compare(units, passed, 'B', 'S', analysis.level);
  let tokensB = 0;
  let tokensA = 0;
  let tokenUnits = 0;
  for (const task of units) {
    const a = outcome(task, 'A')?.tokens;
    const b = outcome(task, 'B')?.tokens;
    if (a == null || b == null) continue;
    tokensA += a;
    tokensB += b;
    tokenUnits += 1;
  }
  const tokenRatio =
    tokenUnits === 0 || tokensA === 0 ? null : tokensB / tokensA;
  const errors = outcomes.filter((o) => o.status === 'error').length;
  const complete = units.length === manifest.tasks.length;
  let verdict: Verdict;
  let retrieval = false;
  if (!complete)
    verdict =
      units.length >= analysis.stopAfter && bMinusA.difference <= 0
        ? 'STOP'
        : 'CONTINUE';
  else if (
    bMinusA.difference >= analysis.goPacket &&
    bMinusA.p < analysis.alpha &&
    tokenRatio !== null &&
    tokenRatio <= analysis.tokenRatio
  ) {
    verdict = 'GO';
    retrieval = bMinusS.difference >= analysis.goRetrieval;
  } else if (bMinusA.upper < analysis.killUpper) verdict = 'KILL';
  else verdict = 'INCONCLUSIVE';
  return {
    experiment: manifest.id,
    draft: !manifest.frozen,
    tasks: manifest.tasks.length,
    units: units.length,
    errors,
    arms,
    strata,
    bMinusA,
    bMinusS,
    tokenRatio,
    tokenUnits,
    thresholds: analysis,
    verdict,
    retrieval,
  };
}

const pp = (value: number) =>
  `${value >= 0 ? '+' : ''}${(value * 100).toFixed(1)} pp`;

export function formatReport(report: Report): string {
  const t = report.thresholds;
  const row = (name: string, c: Comparison) =>
    `${name}\t${c.units}\t${c.wins}\t${c.losses}\t${pp(c.difference)}\t${c.p.toFixed(4)}\t[${pp(c.lower)}, ${pp(c.upper)}]`;
  return [
    `${report.experiment} (${report.draft ? 'draft' : 'frozen'}): ${report.units}/${report.tasks} units scored in every arm, ${report.errors} scorer errors`,
    'arm\tpasses\tunits\trate',
    ...report.arms.map(
      (a) => `${a.arm}\t${a.passes}\t${a.units}\t${(a.rate * 100).toFixed(1)}%`,
    ),
    'stratum\tunits\tA\tB\tS',
    ...report.strata.map(
      (s) =>
        `${s.stratum}\t${s.units}\t${s.passes.A}\t${s.passes.B}\t${s.passes.S}`,
    ),
    `comparison\tunits\twins\tlosses\tdifference\tp (one-sided exact McNemar)\t${Math.round(t.level * 100)}% Bonett-Price`,
    row('B-A', report.bMinusA),
    row('B-S', report.bMinusS),
    `token ratio B/A: ${report.tokenRatio === null ? 'unknown' : report.tokenRatio.toFixed(3)} over ${report.tokenUnits} units`,
    `thresholds: GO packets if B-A >= ${pp(t.goPacket)}, p < ${t.alpha}, token ratio <= ${t.tokenRatio}; GO retrieval if also B-S >= ${pp(t.goRetrieval)}; KILL if the upper bound of B-A < ${pp(t.killUpper)}; STOP after ${t.stopAfter} units if B-A <= 0`,
    `verdict: ${report.verdict}${report.verdict === 'GO' ? (report.retrieval ? ' (packets and retrieval)' : ' (packets only)') : ''}`,
    '',
  ].join('\n');
}

async function readJson(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT')
      return undefined;
    throw new EvalDataError(`${path}: unreadable evidence`);
  }
}

function field(value: unknown, key: string): unknown {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)[key]
    : undefined;
}

/** Read score.json (krn eval score) and session.json (krn eval session) for every planned run. */
export async function readOutcomes(
  manifest: Fr40Manifest,
  root: string,
  draft: boolean,
): Promise<Outcome[]> {
  const outcomes: Outcome[] = [];
  for (const run of planExperiment(manifest, { draft }).runs) {
    const directory = runDirectory(root, manifest.id, run.runId);
    const score = await readJson(join(directory, 'score.json'));
    const session = await readJson(join(directory, 'session.json'));
    const status = field(score, 'status');
    const tokens = field(field(session, 'usage'), 'total_tokens');
    outcomes.push({
      task: run.task,
      arm: run.arm as Arm,
      status:
        status === 'pass' || status === 'fail' || status === 'error'
          ? status
          : 'missing',
      tokens: typeof tokens === 'number' ? tokens : null,
    });
  }
  return outcomes;
}

export async function reportCommand(args: string[]): Promise<void> {
  let experiment: string | undefined;
  let root: string | undefined;
  let draft = false;
  let json = false;
  for (let index = 0; index < args.length; index += 1) {
    const option = args[index];
    const next = () =>
      flagValue(
        args,
        index++,
        () => new CliUsageError(`missing value for ${option}; ${usage}`),
      );
    if (option === '--draft') draft = true;
    else if (option === '--json') json = true;
    else if (option === '--experiment' && experiment === undefined)
      experiment = next();
    else if (option === '--root' && root === undefined) root = next();
    else
      throw new CliUsageError(
        `unknown or repeated eval report option "${option}"; ${usage}`,
      );
  }
  if (experiment === undefined || root === undefined)
    throw new CliUsageError(usage);
  const manifest = fr40Manifest(await loadManifest(experiment));
  const report = analyse(manifest, await readOutcomes(manifest, root, draft));
  process.stdout.write(
    json
      ? `${JSON.stringify({ ok: true, ...report }, null, 2)}\n`
      : formatReport(report),
  );
}
