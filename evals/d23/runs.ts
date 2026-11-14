// Grade every run of every arm of the D23 v2 comparison and print the repeated-run report.
// Usage: node evals/d23/runs.ts --units-file <file> --results <dir holding run1..runN> --classify <dir of <pr>.classify.json> --out <dir>
//   [--confirmatory --prereg <file> --prereg-sha256 <hex>] [--arms K,P,PB] [--runs 3] [--harness-ref <sha>] [--jobs 8] [--work <dir>] [--no-full]
// Offline: reads <results>/run<r>/<pr>.<arm>.patch|files|claude.json, never starts a model session.
// Resumes from <out>/<pr>.<arm>.<r>.json; a run without a finished .meas is skipped, not graded as a failure.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type Observation, report } from './analysis.ts';
import {
  type ArmGrade,
  type Classified,
  gradeArm,
  hiddenChanges,
  type UnitSpec,
} from './grade.ts';
import {
  PreregistrationError,
  requirePreregistration,
} from './preregistration.ts';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const mainRoot = repoRoot.split('/.krn/worktrees/')[0] ?? repoRoot;

const arg = (name: string, fallback: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return (i > 0 ? process.argv[i + 1] : undefined) ?? fallback;
};

export interface RunFacts {
  finished: boolean;
  costUsd: number;
  /** The session ended normally with text. */
  endedNormally: boolean;
  /** The session ended on a usage limit, auth, API or overload error: infrastructure, never a graded outcome. */
  infraError: boolean;
}

const infraErrorText =
  /hit your .*limit|weekly limit|usage limit|API Error: \d{3}|Failed to authenticate|overloaded/i;

/** claude reports an infrastructure failure as is_error; a successful answer may quote the same words. */
export function isInfraError(d: {
  is_error?: unknown;
  result?: unknown;
  api_error_status?: unknown;
}): boolean {
  if (d.is_error !== true) return false;
  const status = Number(d.api_error_status);
  return status >= 400 || infraErrorText.test(String(d.result ?? ''));
}

/** What the arm's result files say about the session: finished, what it cost, whether it ended normally. */
export function runFacts(dir: string, tag: string): RunFacts {
  const meas = join(dir, `${tag}.meas`);
  const finished =
    existsSync(meas) && /^measured$/m.test(readFileSync(meas, 'utf8'));
  let costUsd = 0;
  let endedNormally = false;
  let infraError = false;
  try {
    const d = JSON.parse(readFileSync(join(dir, `${tag}.claude.json`), 'utf8'));
    costUsd = Number(d.total_cost_usd ?? 0) || 0;
    endedNormally =
      d.is_error === false && String(d.result ?? '').trim() !== '';
    infraError = isInfraError(d);
  } catch {
    // no readable session record: cost 0, not a normal end
  }
  return { finished, costUsd, endedNormally, infraError };
}

export function observation(
  unit: string,
  arm: string,
  run: number,
  grade: Pick<ArmGrade, 'ran' | 'functional' | 'scopeClean'>,
  facts: RunFacts,
): Observation {
  return {
    unit,
    arm,
    run,
    correct: grade.functional,
    scopeClean: grade.scopeClean,
    refusal: !grade.ran && facts.endedNormally,
    costUsd: facts.costUsd,
  };
}

async function main() {
  if (process.argv.includes('--confirmatory')) {
    try {
      requirePreregistration(arg('prereg', ''), arg('prereg-sha256', ''));
    } catch (e) {
      if (!(e instanceof PreregistrationError)) throw e;
      process.stderr.write(`${e.message}\n`);
      process.exit(64);
    }
  }
  const out = resolve(arg('out', ''));
  const results = resolve(arg('results', ''));
  const classifyDir = resolve(arg('classify', ''));
  const arms = arg('arms', 'K,P,PB').split(',');
  const runs = Number(arg('runs', '3'));
  const jobs = Number(arg('jobs', '8'));
  const work = resolve(arg('work', '/mnt/storage/tmp/d23-runs'));
  const harnessRef = arg('harness-ref', '');
  const units = readFileSync(resolve(arg('units-file', '')), 'utf8')
    .split('\n')
    .map((l) => l.trim().split(/\s+/)[0] ?? '')
    .filter(Boolean);
  mkdirSync(out, { recursive: true });
  const queue = units.flatMap((u) =>
    arms.flatMap((a) =>
      Array.from({ length: runs }, (_, i) => ({ u, a, r: i + 1 })),
    ),
  );
  const unitCache = new Map<
    string,
    Promise<{ spec: UnitSpec; cls: Classified }>
  >();
  const unitFor = (pr: string) => {
    let p = unitCache.get(pr);
    if (!p) {
      p = (async () => {
        const c = JSON.parse(
          readFileSync(join(classifyDir, `${pr}.classify.json`), 'utf8'),
        ) as Omit<Classified, 'changes'> & { merge: string; parent: string };
        const changes = await hiddenChanges(repoRoot, c.parent, c.merge);
        return {
          spec: {
            repo: repoRoot,
            workRoot: work,
            parent: c.parent,
            merge: c.merge,
            nodeModules: join(mainRoot, 'node_modules'),
            fullSuite: !process.argv.includes('--no-full'),
            ...(harnessRef ? { harnessRef } : {}),
          },
          cls: { ...c, changes },
        };
      })();
      unitCache.set(pr, p);
    }
    return p;
  };
  await Promise.all(
    Array.from({ length: jobs }, async () => {
      for (let job = queue.shift(); job; job = queue.shift()) {
        const tag = `${job.u}.${job.a}`;
        const dir = join(results, `run${job.r}`);
        const file = join(out, `${tag}.${job.r}.json`);
        if (existsSync(file)) continue;
        const facts = runFacts(dir, tag);
        if (!facts.finished || facts.infraError) continue;
        const { spec, cls } = await unitFor(job.u);
        const grade = await gradeArm(
          spec,
          cls,
          join(dir, `${tag}.patch`),
          join(dir, `${tag}.files`),
          `${tag}.r${job.r}`,
        );
        writeFileSync(
          file,
          `${JSON.stringify({ ...observation(job.u, job.a, job.r, grade, facts), grade }, null, 2)}\n`,
        );
      }
    }),
  );
  const obs: Observation[] = [];
  for (const u of units)
    for (const a of arms)
      for (let r = 1; r <= runs; r++) {
        const f = join(out, `${u}.${a}.${r}.json`);
        if (existsSync(f)) obs.push(JSON.parse(readFileSync(f, 'utf8')));
      }
  const text = report(obs, arms);
  writeFileSync(join(out, 'report.md'), text);
  process.stdout.write(text);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
