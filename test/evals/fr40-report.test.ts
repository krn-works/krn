import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { importClosure } from '../../evals/fr40/freeze.ts';
import { generate } from '../../evals/fr40/tasks.ts';
import {
  fr40Manifest,
  loadManifest,
  wozManifest,
} from '../../src/evals/manifest.ts';
import { planExperiment } from '../../src/evals/plan.ts';
import { analyse, type Outcome } from '../../src/evals/report.ts';
import {
  bonettPrice,
  mcnemarOneSided,
  normalQuantile,
} from '../../src/evals/stats.ts';

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
const frozen = join(repoRoot, 'evals/fr40');
const krn = join(repoRoot, 'src/cli/main.ts');

const near = (actual: number, expected: number, tolerance = 1e-4) =>
  assert.ok(
    Math.abs(actual - expected) < tolerance,
    `${actual} != ${expected}`,
  );

test('exact one-sided McNemar and Bonett-Price match hand computation', () => {
  near(mcnemarOneSided(10, 10), 1 / 1024, 1e-12);
  near(mcnemarOneSided(5, 0), 1, 1e-12);
  assert.equal(mcnemarOneSided(0, 0), 1);
  near(mcnemarOneSided(12, 10), (66 + 12 + 1) / 4096, 1e-12);
  near(normalQuantile(0.95), 1.6448536, 1e-5);
  // wins 10, losses 2, 40 units: (11−3)/42 ± 1.6449·sqrt((14/42 − (8/42)²)/42).
  const ci = bonettPrice(10, 2, 40, 0.9);
  near(ci.lower, 0.05215);
  near(ci.upper, 0.3288);
});

const strata = ['s1', 's2'];
function design(count: number, stopAfter = 20) {
  return {
    id: 'fixture',
    frozen: true,
    tasks: Array.from({ length: count }, (_, i) => ({
      id: `t${i}`,
      stratum: strata[i % 2] ?? 's1',
    })),
    analysis: {
      alpha: 0.05,
      level: 0.9,
      goPacket: 0.15,
      goRetrieval: 0.1,
      killUpper: 0.1,
      tokenRatio: 1.25,
      stopAfter,
    },
  };
}
function outcomes(
  count: number,
  pass: (i: number, arm: 'A' | 'B' | 'S') => boolean,
  tokens: Record<'A' | 'B' | 'S', number> = { A: 100, B: 110, S: 110 },
): Outcome[] {
  return Array.from({ length: count }).flatMap((_, i) =>
    (['A', 'B', 'S'] as const).map((arm) => ({
      task: `t${i}`,
      arm,
      status: pass(i, arm) ? ('pass' as const) : ('fail' as const),
      tokens: tokens[arm],
    })),
  );
}

test('verdicts follow the D20 thresholds', () => {
  // B wins 20 of 40 against A and S: +50 pp, p < 0.05, ratio 1.1.
  const go = analyse(
    design(40),
    outcomes(40, (i, arm) => arm === 'B' || i % 2 === 0),
  );
  assert.equal(go.verdict, 'GO');
  assert.equal(go.retrieval, true);
  assert.equal(go.bMinusA.wins, 20);
  assert.deepEqual(go.strata[0]?.passes, { A: 20, B: 20, S: 20 });
  const costly = analyse(
    design(40),
    outcomes(40, (i, arm) => arm === 'B' || i % 2 === 0, {
      A: 100,
      B: 130,
      S: 100,
    }),
  );
  assert.equal(costly.verdict, 'INCONCLUSIVE');
  const kill = analyse(
    design(40),
    outcomes(40, () => true),
  );
  assert.equal(kill.verdict, 'KILL');
  const partial = outcomes(40, () => false).filter(
    (o) => Number(o.task.slice(1)) < 20,
  );
  assert.equal(analyse(design(40), partial).verdict, 'STOP');
  assert.equal(analyse(design(40), partial.slice(0, 30)).verdict, 'CONTINUE');
  const errored = outcomes(2, () => true).map((o, i) =>
    i === 0 ? { ...o, status: 'error' as const } : o,
  );
  const report = analyse(design(2), errored);
  assert.equal(report.units, 1);
  assert.equal(report.errors, 1);
});

test('the frozen FR-40 manifest loads, plans 3 arms x 133 tasks and matches its generator', async () => {
  const manifest = fr40Manifest(await loadManifest(frozen));
  assert.equal(manifest.frozen, true);
  assert.equal(manifest.tasks.length, generate().length);
  assert.equal(new Set(manifest.tasks.map((t) => t.stratum)).size, 7);
  const plan = planExperiment(manifest);
  assert.equal(plan.runs.length, 3 * manifest.tasks.length);
  assert.throws(() => wozManifest(manifest), /use krn eval score/u);
  const drift = spawnSync(
    process.execPath,
    [join(frozen, 'freeze.ts'), '--check'],
    { encoding: 'utf8' },
  );
  assert.equal(drift.status, 0, drift.stderr);
});

test('the frozen FR-40 manifest hashes every local file the scorer imports', async () => {
  const manifest = fr40Manifest(await loadManifest(frozen));
  const imports = JSON.parse(
    await readFile(join(frozen, 'scorer-imports.json'), 'utf8'),
  ) as Record<string, string>;
  assert.ok(Object.hasOwn(manifest.inputs as object, 'scorer-imports.json'));
  for (const file of importClosure(['scorers.ts', 'tasks.ts'])) {
    const path = relative(frozen, file);
    if (!path.startsWith('..'))
      assert.ok(Object.hasOwn(manifest.inputs as object, path), path);
    else
      assert.equal(
        imports[relative(repoRoot, file)],
        sha256(await readFile(file, 'utf8')),
        `${relative(repoRoot, file)} is not hashed`,
      );
  }
  assert.ok(Object.hasOwn(imports, 'scripts/boundaries.ts'));
});

function git(repo: string, ...args: string[]): string {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' });
}

const sha256 = (text: string) =>
  createHash('sha256').update(text).digest('hex');

test('krn eval score runs the real scorer in each slot and krn eval report reads the runs', async () => {
  const temp = await mkdtemp(join(process.env.TMPDIR ?? tmpdir(), 'fr40r-'));
  try {
    // Two commit-title tasks whose base is a synthetic commit in each slot.
    const picked = generate()
      .filter((t) => t.template === 'commit-title-id')
      .slice(0, 2);
    const experiment = join(temp, 'experiment');
    await mkdir(experiment);
    const material = JSON.parse(
      await readFile(join(frozen, 'material.json'), 'utf8'),
    );
    const slots: Record<string, string> = {};
    const tasks = [];
    for (const task of picked) {
      const seed = join(temp, `seed-${task.id}`);
      await mkdir(seed);
      git(seed, 'init', '-q', '-b', 'main');
      git(seed, 'config', 'user.email', 'fixture@example.invalid');
      git(seed, 'config', 'user.name', 'fixture');
      git(seed, 'commit', '-q', '--allow-empty', '-m', 'base');
      tasks.push({ ...task, base: git(seed, 'rev-parse', 'HEAD').trim() });
      slots[task.id] = seed;
    }
    const files: Record<string, string> = {
      'tasks.json': `${JSON.stringify(tasks)}\n`,
      'material.json': `${JSON.stringify(
        Object.fromEntries(picked.map((t) => [t.id, material[t.id]])),
      )}\n`,
    };
    for (const [path, text] of Object.entries(files))
      await writeFile(join(experiment, path), text);
    const frozenManifest = JSON.parse(
      await readFile(join(frozen, 'manifest.json'), 'utf8'),
    );
    await writeFile(
      join(experiment, 'manifest.json'),
      JSON.stringify({
        ...frozenManifest,
        id: 'fr40-fixture',
        tasks: picked.map((t) => ({ id: t.id, stratum: t.template })),
        check: [
          'node',
          join(frozen, 'scorers.ts'),
          '{experiment}/tasks.json',
          '{repo}',
          '--task',
          '{task}',
        ],
        inputs: Object.fromEntries(
          Object.entries(files).map(([path, text]) => [path, sha256(text)]),
        ),
      }),
    );
    const manifest = fr40Manifest(await loadManifest(experiment));
    const root = join(temp, 'evidence');
    await mkdir(root);
    // Task 0: only B titles its commit with the task id; task 1: every arm does.
    for (const run of planExperiment(manifest).runs) {
      const task = tasks.find((t) => t.id === run.task);
      assert.ok(task);
      const slot = join(temp, `slot-${run.runId}`);
      await mkdir(slot);
      const repo = join(slot, 'repo');
      execFileSync('git', ['clone', '-q', slots[run.task] ?? '', repo]);
      git(repo, 'config', 'user.email', 'fixture@example.invalid');
      git(repo, 'config', 'user.name', 'fixture');
      const titled = run.arm === 'B' || run.task === picked[1]?.id;
      git(
        repo,
        'commit',
        '-q',
        '--allow-empty',
        '-m',
        titled ? `Add helper (${task.taskId})` : 'Add helper',
      );
      const scored = spawnSync(
        process.execPath,
        [
          krn,
          'eval',
          'score',
          '--experiment',
          experiment,
          '--root',
          root,
          '--run',
          run.runId,
          '--slot',
          slot,
          '--json',
        ],
        { encoding: 'utf8' },
      );
      assert.equal(scored.status, 0, scored.stderr);
      assert.equal(JSON.parse(scored.stdout).status, titled ? 'pass' : 'fail');
      await writeFile(
        join(root, manifest.id, 'runs', run.runId, 'session.json'),
        JSON.stringify({
          runId: run.runId,
          usage: {
            status: 'complete',
            total_tokens: run.arm === 'B' ? 1200 : 1000,
          },
        }),
      );
    }
    const report = spawnSync(
      process.execPath,
      [krn, 'eval', 'report', '--experiment', experiment, '--root', root],
      { encoding: 'utf8' },
    );
    assert.equal(report.status, 0, report.stderr);
    assert.match(
      report.stdout,
      /2\/2 units scored in every arm, 0 scorer errors/u,
    );
    assert.match(report.stdout, /^B-A\t2\t1\t0\t\+50\.0 pp\t0\.5000\t/mu);
    assert.match(report.stdout, /token ratio B\/A: 1\.200 over 2 units/u);
    assert.match(report.stdout, /thresholds: GO packets if B-A >= \+15\.0 pp/u);
    assert.match(report.stdout, /^verdict: INCONCLUSIVE$/mu);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});
