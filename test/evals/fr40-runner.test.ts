import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  campaignOrder,
  composePrompt,
  prepareSlot,
} from '../../evals/fr40/run.ts';
import { type ConventionTask, TEMPLATES } from '../../evals/fr40/tasks.ts';
import { fr40Manifest, loadManifest } from '../../src/evals/manifest.ts';
import { planExperiment } from '../../src/evals/plan.ts';

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
const frozen = join(repoRoot, 'evals/fr40');
const krn = join(repoRoot, 'src/cli/main.ts');
const read = async (name: string) =>
  JSON.parse(await readFile(join(frozen, name), 'utf8'));
const git = (repo: string, ...args: string[]) =>
  execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();

test('arm A gets the bare task prompt; B and S put their material first', async () => {
  const tasks: ConventionTask[] = await read('tasks.json');
  const material = await read('material.json');
  const task = tasks[0];
  assert.ok(task);
  assert.equal(composePrompt(task, 'A', material), `${task.prompt}\n`);
  for (const [arm, key] of [
    ['B', 'packet'],
    ['S', 'standards'],
  ] as const) {
    const prompt = composePrompt(task, arm, material);
    assert.ok(prompt.startsWith(material[task.id][key].trim()));
    assert.ok(prompt.endsWith(`\n\n${task.prompt}\n`));
  }
});

test('the campaign order samples every stratum in each prefix and keeps planned arm order', async () => {
  const tasks: ConventionTask[] = await read('tasks.json');
  const manifest = fr40Manifest(await loadManifest(frozen));
  const runs = planExperiment(manifest).runs;
  const order = campaignOrder(runs, tasks);
  assert.equal(order.length, runs.length);
  const byId = new Map(tasks.map((t) => [t.id, t.template]));
  const firstUnits = [...new Set(order.map((r) => r.task))].slice(0, 7);
  assert.deepEqual(
    new Set(firstUnits.map((id) => byId.get(id))),
    new Set(TEMPLATES),
  );
  for (const id of firstUnits)
    assert.deepEqual(
      order.filter((r) => r.task === id).map((r) => r.arm),
      runs.filter((r) => r.task === id).map((r) => r.arm),
    );
});

// Regression: setup files committed after the frozen base made every
// tracker-untouched run fail; krn eval score --base scores from the setup commit.
test('prepareSlot commits task setup and krn eval score --base scores against it', async () => {
  const temp = await mkdtemp(join(process.env.TMPDIR ?? tmpdir(), 'fr40run-'));
  try {
    const source = join(temp, 'source');
    await mkdir(source);
    git(source, 'init', '-q', '-b', 'main');
    git(source, 'config', 'user.email', 'fixture@example.invalid');
    git(source, 'config', 'user.name', 'fixture');
    git(source, 'commit', '-q', '--allow-empty', '-m', 'base');
    const base = git(source, 'rev-parse', 'HEAD');
    const tasks: ConventionTask[] = await read('tasks.json');
    const picked = tasks.find((t) => t.template === 'tracker-untouched');
    assert.ok(picked);
    const task = { ...picked, base };
    const experiment = join(temp, 'experiment');
    await mkdir(experiment);
    const text = `${JSON.stringify([task])}\n`;
    await writeFile(join(experiment, 'tasks.json'), text);
    const material = `${JSON.stringify({ [task.id]: (await read('material.json'))[picked.id] })}\n`;
    await writeFile(join(experiment, 'material.json'), material);
    const manifest = await read('manifest.json');
    await writeFile(
      join(experiment, 'manifest.json'),
      JSON.stringify({
        ...manifest,
        id: 'fr40-runner',
        tasks: [{ id: task.id, stratum: task.template }],
        check: manifest.check.map((part: string) =>
          part.replace('{experiment}/scorers.ts', join(frozen, 'scorers.ts')),
        ),
        inputs: {
          'tasks.json': createHash('sha256').update(text).digest('hex'),
          'material.json': createHash('sha256').update(material).digest('hex'),
        },
      }),
    );
    const root = join(temp, 'evidence');
    await mkdir(root);
    const runs = planExperiment(
      fr40Manifest(await loadManifest(experiment)),
    ).runs;
    for (const [index, run] of runs.entries()) {
      const slot = join(temp, `slot-${index}`);
      const setupBase = await prepareSlot(source, slot, task);
      const repo = join(slot, 'repo');
      assert.notEqual(setupBase, base);
      assert.equal(
        git(repo, 'show', '--format=', '--name-only', 'HEAD'),
        task.setup[0]?.path,
      );
      git(repo, 'commit', '-q', '--allow-empty', '-m', 'Add helper');
      // The last run omits --base and shows the defect the flag fixes.
      const withBase = index < runs.length - 1;
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
          ...(withBase ? ['--base', setupBase] : []),
          '--json',
        ],
        { encoding: 'utf8' },
      );
      assert.equal(scored.status, 0, scored.stderr);
      const record = JSON.parse(scored.stdout);
      assert.equal(record.status, withBase ? 'pass' : 'fail', record.reason);
    }
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});
