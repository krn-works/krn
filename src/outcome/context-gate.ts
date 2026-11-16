// Context-quality gate: delivery outcome per session-peak context band, read with Fisher's exact test (ADR 0021).
import { resolve } from 'node:path';
import { transcriptDirs } from '../harness/transcripts.ts';
import { gh, ghRepoView } from '../repo/gh.ts';
import { collectFirstPushGreen } from './first-push-green.ts';
import { sessionMarkers } from './holdings.ts';
import { LANE_MARKER } from './lane-marker.ts';
import {
  array,
  attributePr,
  callRun,
  listTimeoutMs,
  number,
  object,
  parse,
  type Run,
  sessions,
  string,
  time,
} from './ledger.ts';
import { titleTaskId } from './task-id.ts';

export const BANDS = [
  { name: '<150k', lo: 0, hi: 150_000 },
  { name: '150-200k', lo: 150_000, hi: 200_000 },
  { name: '200-300k', lo: 200_000, hi: 300_000 },
  { name: '300k+', lo: 300_000, hi: Number.POSITIVE_INFINITY },
] as const;
export type BandName = (typeof BANDS)[number]['name'];
export const BASE_BAND: BandName = '<150k';
/** Fewest merges per band (both sides) below which the gate does not judge. */
export const MIN_PER_BAND = 100;
/** Share of lead-shipped merges that must map to their authoring session. */
export const MIN_COVERAGE = 0.8;
/** One-sided significance level for "significantly worse". */
export const ALPHA = 0.05;
/** First lead-era merge the gate reads unless `since` says otherwise. */
export const GATE_SINCE = '2026-11-09T14:48:57Z';
const REWORK_HOURS = 48;

export const bandOf = (peak: number): BandName =>
  (BANDS.find((b) => peak >= b.lo && peak < b.hi) ?? BANDS[0]).name;

const logFactorial = (n: number): number => {
  let sum = 0;
  for (let i = 2; i <= n; i++) sum += Math.log(i);
  return sum;
};

/**
 * One-sided Fisher exact p-value that group B has fewer successes than group A
 * (hypergeometric lower tail of B's successes). A: aYes of aN; B: bYes of bN.
 */
export function fisherLess(
  aYes: number,
  aN: number,
  bYes: number,
  bN: number,
): number {
  const yes = aYes + bYes;
  const total = aN + bN;
  const logChoose = (n: number, k: number) =>
    logFactorial(n) - logFactorial(k) - logFactorial(n - k);
  const denominator = logChoose(total, bN);
  let p = 0;
  for (let k = Math.max(0, bN - (total - yes)); k <= bYes; k++)
    p += Math.exp(
      logChoose(yes, k) + logChoose(total - yes, bN - k) - denominator,
    );
  return Math.min(1, p);
}

export type GateRow = {
  band: BandName;
  /** First pushed head got a green Check; null when no Check was measured. */
  firstGreen: boolean | null;
  rework: boolean;
};

export type BandStats = {
  band: BandName;
  n: number;
  measured: number;
  green: number;
  rework: number;
};

export function bandStats(rows: GateRow[]): BandStats[] {
  return BANDS.map(({ name }) => {
    const own = rows.filter((r) => r.band === name);
    const measured = own.filter((r) => r.firstGreen !== null);
    return {
      band: name,
      n: own.length,
      measured: measured.length,
      green: measured.filter((r) => r.firstGreen).length,
      rework: own.filter((r) => r.rework).length,
    };
  });
}

export type Verdict = {
  verdict: 'pass' | 'fail' | 'inconclusive';
  reason: string;
};

/**
 * The named band against the <150k band: inconclusive under MIN_PER_BAND merges
 * on either side, fail when its first-push-green is significantly lower or its
 * rework significantly higher (one-sided Fisher, ALPHA), pass otherwise.
 */
export function judgeBand(stats: BandStats[], band: BandName): Verdict {
  const base = stats.find((s) => s.band === BASE_BAND);
  const test = stats.find((s) => s.band === band);
  if (!base || !test || band === BASE_BAND)
    return { verdict: 'inconclusive', reason: `no band ${band} to compare` };
  const small = [base, test].find(
    (s) => s.n < MIN_PER_BAND || s.measured < MIN_PER_BAND,
  );
  if (small)
    return {
      verdict: 'inconclusive',
      reason: `band ${small.band} has ${Math.min(small.n, small.measured)} merges, need ${MIN_PER_BAND}`,
    };
  const pGreen = fisherLess(
    base.green,
    base.measured,
    test.green,
    test.measured,
  );
  // Rework is worse when higher, so compare the non-rework counts.
  const pRework = fisherLess(
    base.n - base.rework,
    base.n,
    test.n - test.rework,
    test.n,
  );
  const detail = `first-push-green p=${pGreen.toFixed(3)}, rework p=${pRework.toFixed(3)} (one-sided Fisher, worse than ${BASE_BAND}, alpha ${ALPHA})`;
  return pGreen < ALPHA || pRework < ALPHA
    ? { verdict: 'fail', reason: `band ${band} significantly worse: ${detail}` }
    : {
        verdict: 'pass',
        reason: `band ${band} not significantly worse: ${detail}`,
      };
}

type GatePr = {
  number: number;
  title: string;
  body: string;
  mergedAt: string;
};

/**
 * A later `fix(` PR merged within 48 hours that shares the task id or a code
 * file marks a merge as reworked. `files` maps PR number to its code files.
 */
export function reworked(
  prs: Pick<GatePr, 'number' | 'title' | 'mergedAt'>[],
  files: Map<number, Set<string>>,
): Set<number> {
  const out = new Set<number>();
  for (const pr of prs) {
    const at = time(pr.mergedAt) ?? 0;
    const task = titleTaskId(pr.title);
    for (const fix of prs) {
      if (fix.number === pr.number || !fix.title.startsWith('fix(')) continue;
      const delta = (time(fix.mergedAt) ?? 0) - at;
      if (delta <= 0 || delta > REWORK_HOURS * 3_600_000) continue;
      const shared = [...(files.get(fix.number) ?? [])].some((f) =>
        files.get(pr.number)?.has(f),
      );
      if ((task && titleTaskId(fix.title) === task) || shared) {
        out.add(pr.number);
        break;
      }
    }
  }
  return out;
}

/** Code files per PR number from `git log --first-parent --name-only --format=@@%H|%cI|%s`. */
export function codeFilesByPr(log: string): Map<number, Set<string>> {
  const out = new Map<number, Set<string>>();
  for (const block of log.split('@@').slice(1)) {
    const [head = '', ...rest] = block.trim().split('\n');
    const m = /\(#(\d+)\)\s*$/.exec(head.split('|').slice(2).join('|'));
    if (!m) continue;
    out.set(
      Number(m[1]),
      new Set(rest.filter((f) => /^(src|scripts|bin)\//.test(f))),
    );
  }
  return out;
}

export type ContextGate = {
  merges: number;
  leadShipped: number;
  mapped: number;
  coverage: number;
  stats: BandStats[];
  band: BandName;
  verdict: Verdict;
  sessions: Record<BandName, number>;
};

export type ContextGateOptions = {
  root?: string;
  transcripts?: string;
  repo?: string;
  since?: string;
  band?: BandName;
  run?: Run;
};

/** Reads merges (gh), first-push-green (gh), rework (git) and lead sessions (transcripts) and judges one band. */
export async function collectContextGate(
  options: ContextGateOptions = {},
): Promise<ContextGate> {
  const root = resolve(options.root ?? process.cwd());
  const run = options.run ?? callRun(listTimeoutMs(1000));
  const repo =
    options.repo ?? string(object(parse(await ghRepoView(run))).nameWithOwner);
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error('Invalid repository');
  const since = options.since ?? GATE_SINCE;
  const merged: GatePr[] = array(
    parse(
      await gh(run, [
        'pr',
        'list',
        '--repo',
        repo,
        '--state',
        'merged',
        '--limit',
        '2000',
        '--json',
        'number,title,body,mergedAt',
      ]),
    ),
  )
    .map(object)
    .filter(
      (p) =>
        number(p.number) !== null &&
        (time(p.mergedAt) ?? 0) >= Date.parse(since),
    )
    .map((p) => ({
      number: Number(p.number),
      title: string(p.title),
      body: string(p.body),
      mergedAt: string(p.mergedAt),
    }));
  const files = codeFilesByPr(
    String(
      await run('git', [
        '-C',
        root,
        'log',
        '--first-parent',
        `--since=${since}`,
        '--name-only',
        '--format=@@%H|%cI|%s',
        'HEAD',
      ]),
    ),
  );
  const rework = reworked(merged, files);
  const transcripts = await sessions(
    options.transcripts ? [options.transcripts] : await transcriptDirs(root),
  );
  const markers = await sessionMarkers(root);
  const lead = transcripts.lead.filter(
    (s) => markers.get(s.id) !== 'lane' && s.peak > 0,
  );
  const shipped = merged.filter((p) => !p.body.includes(LANE_MARKER));
  const owner = new Map<number, number>();
  for (const pr of shipped) {
    const session = attributePr(pr, lead);
    if (session) owner.set(pr.number, session.peak);
  }
  const measured = await collectFirstPushGreen({
    repo,
    run,
    numbers: [...owner.keys()],
  });
  const first = new Map(measured.prs.map((p) => [p.number, p.first]));
  const rows: GateRow[] = [...owner].map(([n, peak]) => ({
    band: bandOf(peak),
    firstGreen: first.get(n) ? first.get(n) === 'success' : null,
    rework: rework.has(n),
  }));
  const stats = bandStats(rows);
  const band = options.band ?? '200-300k';
  const coverage = shipped.length ? owner.size / shipped.length : 0;
  const verdict =
    coverage < MIN_COVERAGE
      ? {
          verdict: 'inconclusive' as const,
          reason: `coverage ${(coverage * 100).toFixed(1)}% is below ${MIN_COVERAGE * 100}%`,
        }
      : judgeBand(stats, band);
  const peaks = Object.fromEntries(
    BANDS.map((b) => [
      b.name,
      lead.filter((s) => bandOf(s.peak) === b.name).length,
    ]),
  ) as Record<BandName, number>;
  return {
    merges: merged.length,
    leadShipped: shipped.length,
    mapped: owner.size,
    coverage,
    stats,
    band,
    verdict,
    sessions: peaks,
  };
}

const pct = (k: number, n: number) =>
  n ? `${((100 * k) / n).toFixed(0)}%` : 'n/a';

export function renderContextGate(g: ContextGate): string {
  const lines = [
    `coverage: ${(g.coverage * 100).toFixed(1)}% (${g.mapped} of ${g.leadShipped} lead-shipped merges mapped to their lead session; ${g.merges} merges read)`,
    '| session peak | sessions | n merges | first-push-green | rework |',
    '|-|-|-|-|-|',
    ...g.stats.map(
      (s) =>
        `| ${s.band} | ${g.sessions[s.band]} | ${s.n} | ${pct(s.green, s.measured)} (n=${s.measured}) | ${pct(s.rework, s.n)} |`,
    ),
    `verdict: ${g.verdict.verdict} (${g.verdict.reason})`,
  ];
  return `${lines.join('\n')}\n`;
}
