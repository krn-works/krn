// Usage: node evals/sibling-transplant/aggregate.ts <measure-output.json>...
import { readFileSync } from 'node:fs';
import { clusterBootstrap, wilson } from './detector.ts';

interface Row {
  fix: boolean;
  scored: number;
  hits: number;
  added: number;
  trivial: number;
}
interface Out {
  repo: string;
  lang: string;
  head: string;
  newest: string;
  oldest: string;
  rows: Row[];
}
const outs = process.argv
  .slice(2)
  .map((f) => JSON.parse(readFileSync(f, 'utf8')) as Out);
const line = (label: string, rows: Row[]) => {
  const k = rows.reduce((a, r) => a + r.hits, 0);
  const n = rows.reduce((a, r) => a + r.scored, 0);
  const w = wilson(k, n);
  const b = clusterBootstrap(rows.map((r) => ({ hits: r.hits, n: r.scored })));
  const pct = (x: number) => (100 * x).toFixed(1);
  return `${label}: PRs ${rows.length}, added ${rows.reduce((a, r) => a + r.added, 0)}, trivial ${rows.reduce((a, r) => a + r.trivial, 0)}, scored ${n}, with ancestor ${k}, share ${n ? pct(k / n) : '-'}%, Wilson ${pct(w.lo)}-${pct(w.hi)}%, PR-cluster bootstrap ${pct(b.lo)}-${pct(b.hi)}%`;
};
for (const o of outs)
  console.log(
    `repo ${o.repo.split('/').pop()} (${o.lang}) HEAD ${o.head} range ${o.oldest}..${o.newest}`,
  );
const all = outs.flatMap((o) => o.rows);
console.log(line('overall', all));
for (const l of ['ts', 'py'])
  console.log(
    line(
      `lang ${l}`,
      outs.filter((o) => o.lang === l).flatMap((o) => o.rows),
    ),
  );
console.log(
  line(
    'fix',
    all.filter((r) => r.fix),
  ),
);
console.log(
  line(
    'feature',
    all.filter((r) => !r.fix),
  ),
);
for (const o of outs)
  console.log(line(`repo ${o.repo.split('/').pop()}`, o.rows));
