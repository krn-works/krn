// Routing report: dollars per accepted merge per role and model, counting every assigned task's spend (retries, reviewers, abandoned work).
// With --sonnet, --sol and --opus replay rows files it prices the two first-attempt policies instead: Sonnet-first and
// Sol-first, each escalating a red first attempt to Opus, on the units all three files grade (paired), with a bootstrap
// CI of the Sol/Sonnet ratio and one verdict line.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Row } from '../../evals/replay/rows.ts';
import { SOL_MODEL } from '../../src/harness/codex.ts';
import {
  collectAllAttempts,
  renderAllAttempts,
} from '../../src/outcome/dollars.ts';
import type { LedgerOptions } from '../../src/outcome/ledger.ts';

const USAGE =
  'usage: node evals/routing/report.ts --all-attempts [--json] [--root <dir>] [--transcripts <dir>] [--repo <owner/name>] [--limit <n>]\n' +
  '       node evals/routing/report.ts --all-attempts --sonnet <rows> --sol <rows> --opus <rows> [--json]\n';

/** The paired sample the decision rule needs. */
export const MIN_PAIRED = 20;

export type Role = 'sonnet' | 'sol' | 'opus';

/** Whether a row's realized model is the role's model: a row realized on another model never counts for the role. */
export function realizedAs(role: Role, model: string | null | undefined) {
  if (typeof model !== 'string') return false;
  const names = model.split(',');
  if (role === 'sol') return names.length === 1 && names[0] === SOL_MODEL;
  return names.some((m) => m.includes(role));
}

interface Attempt {
  pass: boolean;
  cost: number;
}

/** One graded attempt per unit (its lowest rep) whose realized model is the role's and whose cost is known. */
export function attempts(role: Role, rows: Row[]) {
  const byUnit = new Map<string, Row>();
  let excluded = 0;
  for (const r of rows) {
    if (r.pass === null) continue;
    if (!realizedAs(role, r.model) || r.cost === null) {
      excluded++;
      continue;
    }
    const seen = byUnit.get(r.unit);
    if (seen === undefined || r.rep < seen.rep) byUnit.set(r.unit, r);
  }
  const out = new Map<string, Attempt>();
  for (const [u, r] of byUnit)
    out.set(u, { pass: r.pass === true, cost: r.cost as number });
  return { attempts: out, excluded };
}

/** One unit under one policy: the first attempt, and Opus only after a red first attempt. */
export interface PolicyUnit {
  cost: number;
  accepted: boolean;
}

const underPolicy = (first: Attempt, opus: Attempt | undefined) =>
  first.pass
    ? { cost: first.cost, accepted: true }
    : opus === undefined
      ? undefined
      : { cost: first.cost + opus.cost, accepted: opus.pass };

export interface PairedUnit {
  unit: string;
  sonnet: PolicyUnit;
  sol: PolicyUnit;
}

/** Units both first attempts graded, and that Opus graded wherever either first attempt was red. */
export function pairUnits(
  sonnet: Map<string, Attempt>,
  sol: Map<string, Attempt>,
  opus: Map<string, Attempt>,
): { paired: PairedUnit[]; missingEscalation: number } {
  const paired: PairedUnit[] = [];
  let missingEscalation = 0;
  for (const unit of [...sonnet.keys()].sort()) {
    const a = sonnet.get(unit) as Attempt;
    const b = sol.get(unit);
    if (b === undefined) continue;
    const pa = underPolicy(a, opus.get(unit));
    const pb = underPolicy(b, opus.get(unit));
    if (pa === undefined || pb === undefined) {
      missingEscalation++;
      continue;
    }
    paired.push({ unit, sonnet: pa, sol: pb });
  }
  return { paired, missingEscalation };
}

/** USD per accepted merge over the units; null when none was accepted. */
export function perMerge(units: PolicyUnit[]): number | null {
  const merges = units.filter((u) => u.accepted).length;
  return merges === 0 ? null : units.reduce((s, u) => s + u.cost, 0) / merges;
}

/** Deterministic PRNG (mulberry32), so a report over the same rows prints the same interval. */
function prng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 95% percentile bootstrap CI over units of Sol-first $/merge divided by Sonnet-first $/merge. */
export function ratioInterval(
  paired: PairedUnit[],
  resamples = 2000,
  seed = 1,
): [number, number] | null {
  if (paired.length === 0) return null;
  const rand = prng(seed);
  const ratios: number[] = [];
  for (let i = 0; i < resamples; i++) {
    const draw = Array.from(
      { length: paired.length },
      () => paired[Math.floor(rand() * paired.length)] as PairedUnit,
    );
    const a = perMerge(draw.map((p) => p.sonnet));
    const b = perMerge(draw.map((p) => p.sol));
    if (a !== null && b !== null && a > 0) ratios.push(b / a);
  }
  if (ratios.length === 0) return null;
  ratios.sort((x, y) => x - y);
  const at = (q: number) =>
    ratios[
      Math.min(ratios.length - 1, Math.floor(q * ratios.length))
    ] as number;
  return [at(0.025), at(0.975)];
}

export interface PolicyReport {
  n: number;
  missingEscalation: number;
  excluded: Record<Role, number>;
  policies: Record<
    'sonnet' | 'sol',
    { perMerge: number | null; accepted: number; cost: number }
  >;
  ratio: number | null;
  ci: [number, number] | null;
  verdict: string;
}

export function policyReport(rows: Record<Role, Row[]>): PolicyReport {
  const s = attempts('sonnet', rows.sonnet);
  const g = attempts('sol', rows.sol);
  const o = attempts('opus', rows.opus);
  const { paired, missingEscalation } = pairUnits(
    s.attempts,
    g.attempts,
    o.attempts,
  );
  const side = (k: 'sonnet' | 'sol') => {
    const units = paired.map((p) => p[k]);
    return {
      perMerge: perMerge(units),
      accepted: units.filter((u) => u.accepted).length,
      cost: units.reduce((t, u) => t + u.cost, 0),
    };
  };
  const policies = { sonnet: side('sonnet'), sol: side('sol') };
  const ratio =
    policies.sonnet.perMerge !== null &&
    policies.sol.perMerge !== null &&
    policies.sonnet.perMerge > 0
      ? policies.sol.perMerge / policies.sonnet.perMerge
      : null;
  const ci = ratioInterval(paired);
  const n = paired.length;
  let verdict: string;
  if (n < MIN_PAIRED)
    verdict = `inconclusive: ${n} paired units, below ${MIN_PAIRED}`;
  else if (ci === null) verdict = 'inconclusive: no accepted merge to price';
  else if (ci[1] < 1 && policies.sol.accepted >= policies.sonnet.accepted)
    verdict =
      'sol-first wins: cheaper per accepted merge, acceptance not lower';
  else if (ci[0] > 1) verdict = 'sonnet-first wins: cheaper per accepted merge';
  else verdict = 'inconclusive: the ratio CI spans 1 or Sol accepts fewer';
  return {
    n,
    missingEscalation,
    excluded: { sonnet: s.excluded, sol: g.excluded, opus: o.excluded },
    policies,
    ratio,
    ci,
    verdict,
  };
}

const usd = (v: number | null) => (v === null ? 'n/a' : `$${v.toFixed(3)}`);

export function renderPolicyReport(r: PolicyReport): string {
  const line = (name: string, p: PolicyReport['policies']['sonnet']) =>
    `${name}: ${usd(p.perMerge)} per accepted merge, ${p.accepted}/${r.n} accepted, ${usd(p.cost)} all attempts`;
  return [
    `paired units: ${r.n} (missing Opus escalation: ${r.missingEscalation}; excluded rows sonnet ${r.excluded.sonnet}, sol ${r.excluded.sol}, opus ${r.excluded.opus})`,
    line('sonnet-first (Opus after red)', r.policies.sonnet),
    line('sol-first (Opus after red)', r.policies.sol),
    `sol/sonnet per merge: ${r.ratio === null ? 'n/a' : r.ratio.toFixed(3)} (95% bootstrap CI ${r.ci === null ? 'n/a' : `${r.ci[0].toFixed(3)}-${r.ci[1].toFixed(3)}`})`,
    `verdict: ${r.verdict}`,
    '',
  ].join('\n');
}

const readRowsFile = (file: string): Row[] =>
  readFileSync(file, 'utf8')
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => JSON.parse(l) as Row);

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (!args.includes('--all-attempts')) {
    process.stderr.write(USAGE);
    process.exit(2);
  }
  const value = (flag: string): string | undefined => {
    const i = args.indexOf(flag);
    return i < 0 ? undefined : args[i + 1];
  };
  const files = {
    sonnet: value('--sonnet'),
    sol: value('--sol'),
    opus: value('--opus'),
  };
  const given = Object.values(files).filter((f) => f !== undefined).length;
  if (given > 0) {
    if (given < 3) {
      process.stderr.write(USAGE);
      process.exit(2);
    }
    const r = policyReport({
      sonnet: readRowsFile(files.sonnet as string),
      sol: readRowsFile(files.sol as string),
      opus: readRowsFile(files.opus as string),
    });
    process.stdout.write(
      args.includes('--json')
        ? `${JSON.stringify(r)}\n`
        : renderPolicyReport(r),
    );
    process.exit(r.n === 0 ? 65 : 0);
  }
  const options: LedgerOptions = { limit: 300 };
  const root = value('--root');
  if (root !== undefined) options.root = root;
  const transcripts = value('--transcripts');
  if (transcripts !== undefined) options.transcripts = transcripts;
  const repo = value('--repo');
  if (repo !== undefined) options.repo = repo;
  const limit = value('--limit');
  if (limit !== undefined) options.limit = Number(limit);
  const report = await collectAllAttempts(options);
  process.stdout.write(
    args.includes('--json')
      ? `${JSON.stringify(report)}\n`
      : renderAllAttempts(report),
  );
}
