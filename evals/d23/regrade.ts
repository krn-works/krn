// Re-grade the replayed D23 patches against the tests the original pull requests merged.
// Usage: node evals/d23/regrade.ts [--runs <d23-comparison dir>] [--results-dir results] [--harness-ref <sha>] [--out <dir>] [--units 473,476] [--jobs 2] [--no-full] [--units-file <file>] [--classify-only]
// --classify-only writes <out>/<pr>.classify.json (failToPass, validOnMerge) for each unit and grades no arm.
// Offline: reads results/<pr>.<K|P>.patch|files, never starts a model session. Resumes from <out>/<pr>.json.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  type ArmGrade,
  type Classified,
  classify,
  exec,
  gradeArm,
} from './grade.ts';

export interface UnitGrade {
  pr: string;
  parent: string;
  merge: string;
  failToPass: string[];
  passToPassHidden: string[];
  validOnMerge: boolean;
  K: ArmGrade;
  P: ArmGrade;
}

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
// Run state lives in the main checkout even when this file runs from a lane worktree.
const mainRoot = repoRoot.split('/.krn/worktrees/')[0] ?? repoRoot;

const arg = (name: string, fallback: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return (i > 0 ? process.argv[i + 1] : undefined) ?? fallback;
};

/** Exact two-sided binomial p over discordant pairs (b, c), rounded half to even at 3 decimals. */
export function mcnemarP(b: number, c: number): string {
  const n = b + c;
  if (n === 0) return '1.000';
  let tail = 0;
  let term = 0.5 ** n;
  for (let k = 0; k <= Math.min(b, c); k++) {
    tail += term;
    term = (term * (n - k)) / (k + 1);
  }
  const p = Math.min(1, 2 * tail) * 1000;
  const down = Math.floor(p);
  const rest = p - down;
  const even = rest === 0.5 ? down + (down % 2) : Math.round(p);
  return (even / 1000).toFixed(3);
}

export function summaryLine(grades: UnitGrade[]): string {
  const count = (arm: 'K' | 'P', key: 'functional' | 'scopeClean') =>
    grades.filter((g) => g[arm][key]).length;
  const n = grades.length;
  // Paired: units valid on the merge where both arms produced a patch, so a crashed session counts for neither arm.
  const paired = grades.filter((g) => g.validOnMerge && g.K.ran && g.P.ran);
  const pairedCount = (arm: 'K' | 'P') =>
    paired.filter((g) => g[arm].functional).length;
  return `K functional ${count('K', 'functional')}/${n}, P functional ${count('P', 'functional')}/${n}, K scope-clean ${count('K', 'scopeClean')}/${n}, P scope-clean ${count('P', 'scopeClean')}/${n}; paired K ${pairedCount('K')}/${paired.length}, P ${pairedCount('P')}/${paired.length}; McNemar p=${mcnemarP(
    paired.filter((g) => g.K.functional && !g.P.functional).length,
    paired.filter((g) => g.P.functional && !g.K.functional).length,
  )}`;
}

export function table(grades: UnitGrade[]): string {
  const yn = (b: boolean) => (b ? 'Y' : 'N');
  const rows = grades.map(
    (g) =>
      `| ${g.pr} | ${g.failToPass.length} | ${yn(g.K.functional)} | ${yn(g.P.functional)} | ${yn(g.K.scopeClean)} | ${yn(g.P.scopeClean)} | ${g.K.outOfScope.join(' ')} | ${g.P.outOfScope.join(' ')} |`,
  );
  return [
    '| PR | F2P files | K functional | P functional | K scope-clean | P scope-clean | K out of scope | P out of scope |',
    '|--|--|--|--|--|--|--|--|',
    ...rows,
  ].join('\n');
}

async function shaFor(repo: string, ref: string, pr: string) {
  const log = await exec(
    'git',
    ['log', '--first-parent', '--format=%H %s', ref],
    repo,
  );
  const line = log.out.split('\n').find((l) => l.endsWith(`(#${pr})`));
  const merge = line?.split(' ')[0];
  if (!merge) throw new Error(`no merge commit for PR ${pr} on ${ref}`);
  const parent = (
    await exec('git', ['rev-parse', `${merge}^`], repo)
  ).out.trim();
  return { merge, parent };
}

export interface UnitOpts {
  repo: string;
  ref: string;
  results: string;
  work: string;
  fullSuite: boolean;
  harnessRef?: string;
}

export type UnitClassification = Pick<
  UnitGrade,
  'pr' | 'parent' | 'merge' | 'failToPass' | 'passToPassHidden' | 'validOnMerge'
>;

async function classifyWith(pr: string, opts: UnitOpts) {
  const { merge, parent } = await shaFor(opts.repo, opts.ref, pr);
  const spec = {
    repo: opts.repo,
    workRoot: opts.work,
    parent,
    merge,
    nodeModules: join(mainRoot, 'node_modules'),
    fullSuite: opts.fullSuite,
    ...(opts.harnessRef ? { harnessRef: opts.harnessRef } : {}),
  };
  const cls: Classified = await classify(spec, `${pr}.classify`);
  return { merge, parent, spec, cls };
}

/** Validity only: which hidden test files fail on parent and pass on merge. Grades no arm. */
export async function classifyUnit(
  pr: string,
  opts: UnitOpts,
): Promise<UnitClassification> {
  const { merge, parent, cls } = await classifyWith(pr, opts);
  return {
    pr,
    parent,
    merge,
    failToPass: cls.failToPass,
    passToPassHidden: cls.passToPassHidden,
    validOnMerge: cls.validOnMerge,
  };
}

export async function regradeUnit(
  pr: string,
  opts: UnitOpts,
): Promise<UnitGrade> {
  const { merge, parent, spec, cls } = await classifyWith(pr, opts);
  const arm = (a: 'K' | 'P') =>
    gradeArm(
      spec,
      cls,
      join(opts.results, `${pr}.${a}.patch`),
      join(opts.results, `${pr}.${a}.files`),
      `${pr}.${a}`,
    );
  return {
    pr,
    parent,
    merge,
    failToPass: cls.failToPass,
    passToPassHidden: cls.passToPassHidden,
    validOnMerge: cls.validOnMerge,
    K: await arm('K'),
    P: await arm('P'),
  };
}

async function main() {
  const runs = resolve(arg('runs', join(mainRoot, '.krn/runs/d23-comparison')));
  const out = resolve(arg('out', join(runs, 'regrade')));
  const work = resolve(arg('work', '/mnt/storage/tmp/d23-regrade'));
  const jobs = Number(arg('jobs', '2'));
  const fullSuite = !process.argv.includes('--no-full');
  const only = arg('units', '');
  const units = readFileSync(
    resolve(arg('units-file', join(runs, 'units.txt'))),
    'utf8',
  )
    .split('\n')
    .map((l) => l.trim().split(/\s+/)[0] ?? '')
    .filter((u) => u && (!only || only.split(',').includes(u)));
  mkdirSync(out, { recursive: true });
  const classifyOnly = process.argv.includes('--classify-only');
  const queue = [...units];
  await Promise.all(
    Array.from({ length: jobs }, async () => {
      for (let pr = queue.shift(); pr; pr = queue.shift()) {
        const file = join(
          out,
          classifyOnly ? `${pr}.classify.json` : `${pr}.json`,
        );
        if (existsSync(file)) continue;
        const opts = {
          repo: repoRoot,
          ref: arg('ref', 'origin/main'),
          results: join(runs, arg('results-dir', 'results')),
          work,
          fullSuite,
          ...(arg('harness-ref', '')
            ? { harnessRef: arg('harness-ref', '') }
            : {}),
        };
        const result = classifyOnly
          ? await classifyUnit(pr, opts)
          : await regradeUnit(pr, opts);
        writeFileSync(file, `${JSON.stringify(result, null, 2)}\n`);
      }
    }),
  );
  if (classifyOnly) return;
  const grades = units.map(
    (u) =>
      JSON.parse(readFileSync(join(out, `${u}.json`), 'utf8')) as UnitGrade,
  );
  const report = `${table(grades)}\n\n${summaryLine(grades)}\n`;
  writeFileSync(join(out, 'table.md'), report);
  process.stdout.write(report);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
