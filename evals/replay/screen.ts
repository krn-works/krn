// Screening: does arm A (plain clone) leave room for a correctness effect? Pure decisions over unit files and result rows.
// ADR 0021 point 7: at least 70 post-cutoff units whose bodies come from the issue text only; the confirmatory run starts only if A passes at most 85%.
import { readFileSync } from 'node:fs';
import type { Unit } from '../units/unit.ts';
import type { Row } from './rows.ts';

export const MIN_UNITS = 70;
export const MAX_A_PASS = 0.85;
/** Units must come from fix commits dated on or after this day. */
export const CUTOFF = '2026-07-01';

export interface ScreenUnit extends Unit {
  /** Commit date (YYYY-MM-DD) of the reference fix. */
  committed?: string | undefined;
  /** The public issue the body was written from. */
  issue?: string | undefined;
}

/** Issue-only body: names its issue and carries no Outcome or Proof paragraph written by the pilot's lead. */
export function issueOnly(u: ScreenUnit): boolean {
  return (
    /^https:\/\/github\.com\/[^/]+\/[^/]+\/issues\/\d+$/.test(u.issue ?? '') &&
    !/^(Outcome|Proof):/m.test(u.task.body)
  );
}

export function eligible(units: ScreenUnit[]): ScreenUnit[] {
  return units.filter(
    (u) => (u.committed ?? '') >= CUTOFF && issueOnly(u) && u.hidden.file,
  );
}

export function parseRows(text: string): Row[] {
  return text
    .split('\n')
    .filter((l) => l.startsWith('{'))
    .map((l) => JSON.parse(l) as Row);
}

export const readRows = (file: string): Row[] => {
  try {
    return parseRows(readFileSync(file, 'utf8'));
  } catch {
    return [];
  }
};

export interface Screening {
  units: number;
  /** Arm A units graded on the screening run. */
  screened: number;
  /** Share of screened A units that passed, null with nothing graded. */
  passRate: number | null;
  verdict: 'go' | 'no-go' | 'pending';
  reason: string;
}

/** A unit passes when any graded arm-A rep passes: the plain clone solved it. */
export function screen(units: ScreenUnit[], rows: Row[]): Screening {
  const ok = new Set(eligible(units).map((u) => u.id));
  const byUnit = new Map<string, boolean>();
  for (const r of rows) {
    if (r.arm !== 'A' || r.pass === null || !ok.has(r.unit)) continue;
    byUnit.set(r.unit, (byUnit.get(r.unit) ?? false) || r.pass);
  }
  const screened = byUnit.size;
  const passRate =
    screened === 0
      ? null
      : [...byUnit.values()].filter(Boolean).length / screened;
  const base = { units: ok.size, screened, passRate };
  if (ok.size < MIN_UNITS)
    return {
      ...base,
      verdict: 'no-go',
      reason: `${ok.size} eligible units, ${MIN_UNITS} required`,
    };
  if (passRate === null || screened < ok.size)
    return {
      ...base,
      verdict: 'pending',
      reason: `${screened} of ${ok.size} units screened`,
    };
  return passRate <= MAX_A_PASS
    ? { ...base, verdict: 'go', reason: `A passes ${pct(passRate)} <= 85%` }
    : { ...base, verdict: 'no-go', reason: `A passes ${pct(passRate)} > 85%` };
}

const pct = (x: number) => `${(x * 100).toFixed(1)}%`;

export function report(s: Screening): string[] {
  return [
    `units: ${s.units} eligible of ${MIN_UNITS} required`,
    `A pass rate: ${s.passRate === null ? 'unmeasured' : pct(s.passRate)} (${s.screened} screened)`,
    `verdict: ${s.verdict} (${s.reason})`,
  ];
}
