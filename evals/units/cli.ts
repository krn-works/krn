// Usage:
//   node evals/units/cli.ts build --repo-dir <clone> --repo <owner/name> --id <task> --merge <sha> --hidden <file> --dest <path> --install <cmd> --test <cmd> [--out evals/units]
//   node evals/units/cli.ts verify --sources <dir holding clones named by repo name> [--units evals/units] [--id <task>]
// verify exits 0 only when every unit is red on base and green on reference; no model runs.

import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildUnit, loadUnits, verifyUnit } from './unit.ts';

const [cmd, ...rest] = process.argv.slice(2);
const flag = (n: string) => {
  const i = rest.indexOf(`--${n}`);
  return i >= 0 ? rest[i + 1] : undefined;
};
const need = (n: string) => {
  const v = flag(n);
  if (!v) {
    console.error(`missing --${n}`);
    process.exit(64);
  }
  return v as string;
};
const here = fileURLToPath(new URL('.', import.meta.url));

if (cmd === 'build') {
  const u = buildUnit({
    repoDir: need('repo-dir'),
    repo: need('repo'),
    id: need('id'),
    merge: need('merge'),
    hiddenFile: need('hidden'),
    hiddenDest: need('dest'),
    install: need('install'),
    test: need('test'),
    out: flag('out') ?? here,
  });
  console.log(
    `built ${u.id} base ${u.base.slice(0, 7)} reference ${u.reference.slice(0, 7)}`,
  );
} else if (cmd === 'verify') {
  const sources = need('sources');
  const only = flag('id');
  let bad = 0;
  for (const { unit, dir } of loadUnits(flag('units') ?? here)) {
    if (only && unit.id !== only) continue;
    const v = verifyUnit(
      join(sources, unit.repo.split('/')[1] as string),
      unit,
      dir,
    );
    if (!v.ok) bad++;
    console.log(
      `${v.id} base=${v.base} reference=${v.reference} ${v.ok ? 'ok' : 'BAD'}`,
    );
  }
  console.log(`verdict: ${bad === 0 ? 'PASS' : 'FAIL'} (${bad} bad)`);
  process.exit(bad === 0 ? 0 : 1);
} else {
  console.error('usage: build | verify');
  process.exit(64);
}
