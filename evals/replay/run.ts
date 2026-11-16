// Usage: node evals/replay/run.ts --arms A,B,C --units <n> [--reps <n>] [--dry]
// One runner for every replay arm. --dry prints one row per (unit, arm, rep) without starting a session.
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadUnits } from '../units/unit.ts';
import { type Arm, parseArms } from './arms.ts';
import { formatRow, harnessSha, type Row } from './rows.ts';

const here = dirname(fileURLToPath(import.meta.url));

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
          cost: 0,
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
  const dry = args.includes('--dry');
  const arms = parseArms(flag('arms') ?? 'A,B,C');
  const count = Number(flag('units') ?? 1);
  const reps = Number(flag('reps') ?? 1);
  const ids = loadUnits(join(here, '..', 'units'))
    .map((u) => u.unit.id)
    .sort()
    .slice(0, count);
  if (ids.length < count) {
    console.error(`only ${ids.length} units available, ${count} requested`);
    process.exit(64);
  }
  if (!dry) {
    console.error(
      'live sessions need the session driver (lane run); use --dry',
    );
    process.exit(69);
  }
  const rows = plan({ arms, units: ids, reps, harness: harnessSha(here) });
  for (const r of rows) console.log(formatRow(r));
  console.log(`verdict: ${rows.length} rows`);
}
