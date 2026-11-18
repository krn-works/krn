// First ten tasks per adopter against a static control (ADR 0021 point 4 Fisher rule), thresholds frozen in
// first-ten.prereg.md. Rows are the replay rows (evals/replay/rows.ts), read by the replay row reader.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fisherBenefitP } from '../../src/brain/retire.ts';
import { field } from '../replay/abc.ts';
import type { ArmId } from '../replay/arms.ts';
import type { Row } from '../replay/rows.ts';
import { readRows } from '../replay/screen.ts';

export interface CohortRow extends Row {
  adopter: string;
  /** Position among the adopter's tasks, 1 is the first after adoption. */
  seq: number;
  /** The pre-task SHA both arms start from. */
  sha: string;
}

export interface FirstTenPrereg {
  tasks: number;
  minAdopters: number;
  treatment: ArmId;
  control: ArmId;
  alpha: number;
  failP: number;
  minBenefitPp: number;
  maxCostRatio: number;
}

export type Verdict = 'PASS' | 'FAIL' | 'INSUFFICIENT';

export interface FirstTenReport {
  verdict: Verdict;
  notes: string[];
}

export function parseFirstTenPrereg(text: string): FirstTenPrereg {
  const num = (name: string): number => Number(field(text, name));
  return {
    tasks: num('tasks-per-adopter'),
    minAdopters: num('min-adopters'),
    treatment: field(text, 'treatment') as ArmId,
    control: field(text, 'control') as ArmId,
    alpha: num('alpha'),
    failP: num('fail-p'),
    minBenefitPp: num('min-benefit-pp'),
    maxCostRatio: num('max-cost-ratio'),
  };
}

interface Pair {
  treatment: CohortRow;
  control: CohortRow;
}

/** The adopter's pairs, or why it does not qualify. */
function pairsOf(
  adopter: string,
  rows: CohortRow[],
  p: FirstTenPrereg,
): Pair[] | string {
  const pairs: Pair[] = [];
  for (let seq = 1; seq <= p.tasks; seq++) {
    const at = rows.filter((r) => r.seq === seq);
    const t = at.filter((r) => r.arm === p.treatment);
    const c = at.filter((r) => r.arm === p.control);
    if (t.length !== 1 || c.length !== 1)
      return `${adopter} excluded: task ${seq} lacks exactly one ${p.treatment} and one ${p.control} row`;
    const [treatment, control] = [t[0], c[0]] as [CohortRow, CohortRow];
    if (treatment.pass === null || control.pass === null)
      return `${adopter} excluded: task ${seq} is ungraded`;
    if (treatment.sha !== control.sha)
      return `${adopter} excluded: task ${seq} arms start from different SHAs`;
    pairs.push({ treatment, control });
  }
  return pairs;
}

/** One verdict over a recorded cohort, with the evidence lines behind it. */
export function firstTenReport(
  rows: CohortRow[],
  p: FirstTenPrereg,
): FirstTenReport {
  const notes: string[] = [];
  const adopters = [...new Set(rows.map((r) => r.adopter))].sort();
  const pairs: Pair[] = [];
  let qualifying = 0;
  for (const a of adopters) {
    const got = pairsOf(
      a,
      rows.filter((r) => r.adopter === a),
      p,
    );
    if (typeof got === 'string') notes.push(got);
    else {
      qualifying++;
      pairs.push(...got);
    }
  }
  notes.push(`${qualifying} of ${adopters.length} adopters qualify`);
  const harnesses = new Set(rows.map((r) => r.harness));
  if (harnesses.size > 1)
    return {
      verdict: 'INSUFFICIENT',
      notes: [...notes, `mixed harness: ${[...harnesses].sort().join(', ')}`],
    };
  if (qualifying < p.minAdopters)
    return {
      verdict: 'INSUFFICIENT',
      notes: [...notes, `need at least ${p.minAdopters} qualifying adopters`],
    };
  const all = pairs.flatMap((x) => [x.treatment, x.control]);
  if (all.some((r) => r.cost === null || !(r.cost > 0)))
    return {
      verdict: 'INSUFFICIENT',
      notes: [
        ...notes,
        'a row has unknown cost: the cost ratio is unestablished',
      ],
    };
  const fails = (arm: ArmId): number =>
    all.filter((r) => r.arm === arm && r.pass === false).length;
  const n = pairs.length;
  const benefitPp = ((fails(p.control) - fails(p.treatment)) / n) * 100;
  const pValue = fisherBenefitP(fails(p.treatment), n, fails(p.control), n);
  const usd = (arm: ArmId): number =>
    all.filter((r) => r.arm === arm).reduce((s, r) => s + (r.cost ?? 0), 0);
  const costRatio = usd(p.treatment) / usd(p.control);
  notes.push(
    `${n} pairs: ${p.treatment} fails ${fails(p.treatment)}, ${p.control} fails ${fails(p.control)}, gain ${benefitPp.toFixed(1)} pp, one-sided Fisher p ${pValue.toFixed(4)}, cost ratio ${costRatio.toFixed(2)}`,
  );
  let verdict: Verdict = 'INSUFFICIENT';
  if (pValue >= p.failP || costRatio > p.maxCostRatio) verdict = 'FAIL';
  else if (pValue < p.alpha && benefitPp >= p.minBenefitPp) verdict = 'PASS';
  return { verdict, notes };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const here = dirname(fileURLToPath(import.meta.url));
  const args = process.argv.slice(2);
  const flag = (name: string): string | undefined => {
    const i = args.indexOf(`--${name}`);
    return i < 0 ? undefined : args[i + 1];
  };
  if (!args.includes('--report')) {
    process.stderr.write(
      'usage: node evals/adoption/first-ten.ts --report [--rows <file>] [--prereg <file>]\n',
    );
    process.exit(64);
  }
  const prereg = parseFirstTenPrereg(
    readFileSync(flag('prereg') ?? join(here, 'first-ten.prereg.md'), 'utf8'),
  );
  const rows = readRows(
    flag('rows') ?? join(here, 'first-ten-cohort.jsonl'),
  ) as CohortRow[];
  const report = firstTenReport(rows, prereg);
  for (const l of report.notes) process.stderr.write(`${l}\n`);
  console.log(report.verdict);
  process.exit(
    report.verdict === 'PASS' ? 0 : report.verdict === 'FAIL' ? 1 : 65,
  );
}
