import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import {
  effectiveUnits,
  goPower,
  maxIcc,
  round3,
  unitsForPower,
} from '../../evals/fr40/power.ts';
import { score } from '../../evals/fr40/scorers.ts';
import {
  type ConventionTask,
  generate,
  TEMPLATES,
  type Template,
} from '../../evals/fr40/tasks.ts';

const dir = new URL('../../evals/fr40/', import.meta.url);
const record = JSON.parse(
  await readFile(new URL('convention-power.json', dir), 'utf8'),
);
const validity = JSON.parse(
  await readFile(new URL('validity.json', dir), 'utf8'),
);
const tasks = generate();

test('generator emits at least 74 tasks with template ids, deterministically', () => {
  assert.ok(tasks.length >= 74, `${tasks.length} tasks`);
  assert.equal(new Set(tasks.map((t) => t.id)).size, tasks.length);
  assert.deepEqual([...new Set(tasks.map((t) => t.template))], [...TEMPLATES]);
  assert.deepEqual(generate(), tasks);
  for (const t of tasks) assert.match(t.taskId, /^t-[0-9a-z]{7}$/u);
});

test('generated tasks cite no exemplar base or fix commit', () => {
  const text = JSON.stringify(tasks).toLowerCase();
  for (const c of validity.inventory.usableClusters)
    for (const sha of [c.base, c.fix])
      assert.ok(!text.includes(sha.slice(0, 7)), `cites ${sha}`);
});

test('recorded convention power matches the exact computation', () => {
  const clusters = new Set(tasks.map((t) => t.template)).size;
  assert.equal(record.units, tasks.length);
  assert.equal(record.clusters, clusters);
  const { effect, alpha, target, discordance } = record.design;
  const needed = discordance.map((d: number) =>
    unitsForPower(d, effect, alpha, target, 400),
  );
  assert.deepEqual(record.unitsForTargetPower, needed);
  assert.deepEqual(validity.unitsForTargetPower, needed);
  for (const row of record.byIcc) {
    const n = effectiveUnits(tasks.length, clusters, row.icc);
    assert.equal(row.effectiveUnits, n);
    assert.deepEqual(
      row.goPower,
      discordance.map((d: number) => round3(goPower(n, d, effect, alpha))),
    );
  }
  assert.deepEqual(
    record.maxIccForTarget,
    needed.map((n: number) => maxIcc(tasks.length, clusters, n)),
  );
  const atOne = record.byIcc.find((r: { icc: number }) => r.icc === 1);
  assert.equal(
    record.verdict,
    Math.min(...atOne.goPower) >= target ? 'powered' : 'below-power',
  );
});

test('effective units follow the design effect', () => {
  assert.equal(effectiveUnits(100, 10, 0), 100);
  assert.equal(effectiveUnits(100, 10, 1), 10);
  assert.equal(maxIcc(50, 5, 74), null);
  assert.equal(maxIcc(10, 10, 5), 1);
});

// Hand-made scratch repositories: one passing and one failing case per template.

type Change = {
  files?: Record<string, string>;
  message?: string;
};

function git(repo: string, ...args: string[]): string {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' });
}

const CORE = `export const answer = 42;\n`;
const HELPER = `export function clamp(value: number, min: number, max: number): number {\n  return Math.min(Math.max(value, min), max);\n}\n`;

async function put(repo: string, files: Record<string, string>): Promise<void> {
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(repo, path)), { recursive: true });
    await writeFile(join(repo, path), content);
  }
}

async function scratch(
  task: ConventionTask,
  change: Change,
): Promise<{ repo: string; base: string }> {
  const repo = await mkdtemp(join(process.env.TMPDIR ?? tmpdir(), 'fr40-'));
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.email', 'fixture@example.invalid');
  git(repo, 'config', 'user.name', 'fixture');
  await put(repo, {
    '.gitignore': '.krn/\n',
    'biome.json': '{ "formatter": { "indentStyle": "space" } }\n',
    'src/core/index.ts': CORE,
    'src/fs/read.ts': `export const read = (): string => '';\n`,
    'src/cli/main.ts': `export const main = (): number => 0;\n`,
    ...Object.fromEntries(task.setup.map((f) => [f.path, f.content])),
  });
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'base');
  const base = git(repo, 'rev-parse', 'HEAD').trim();
  if (change.files) await put(repo, change.files);
  if (change.message !== undefined) {
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', change.message);
  }
  return { repo, base };
}

function taskFor(template: Template): ConventionTask {
  const task = tasks.find((t) => t.template === template);
  assert.ok(task);
  return task;
}

const ok = (task: ConventionTask): string =>
  `feat: add clamp helper (${task.taskId})\n\n${task.closes ? 'Ticket' : 'Refs'}: ${task.taskId}`;

const CASES: Record<Template, (task: ConventionTask) => [Change, Change]> = {
  'commit-title-id': (task) => [
    { files: { 'src/cli/clamp.ts': HELPER }, message: ok(task) },
    {
      files: { 'src/cli/clamp.ts': HELPER },
      message: 'feat: add clamp helper',
    },
  ],
  trailer: (task) => [
    { files: { 'src/cli/clamp.ts': HELPER }, message: ok(task) },
    {
      files: { 'src/cli/clamp.ts': HELPER },
      message: `feat: add clamp helper (${task.taskId})\n\n${task.closes ? 'Refs' : 'Ticket'}: ${task.taskId}`,
    },
  ],
  'agent-state': (task) => [
    {
      files: {
        'src/cli/clamp.ts': HELPER,
        '.krn/runs/worker/plan.md': '# plan\n',
      },
      message: ok(task),
    },
    {
      files: { 'src/cli/clamp.ts': HELPER, 'NOTES.md': '# plan\n' },
      message: ok(task),
    },
  ],
  'tracker-untouched': (task) => [
    { files: { 'src/cli/clamp.ts': HELPER }, message: ok(task) },
    {
      files: {
        'src/cli/clamp.ts': HELPER,
        [`tasks/${task.taskId}.json`]: '{"status":"closed"}\n',
      },
      message: ok(task),
    },
  ],
  'core-imports': (task) => [
    { files: { 'src/core/clamp.ts': HELPER }, message: ok(task) },
    {
      files: {
        'src/core/clamp.ts': `import { read } from '../fs/read.ts';\n${HELPER}export const raw = read;\n`,
      },
      message: ok(task),
    },
  ],
  'role-names': (task) => [
    { files: { 'src/cli/clamp.ts': HELPER }, message: ok(task) },
    {
      files: {
        [`src/cli/${task.taskId}.ts`]: HELPER,
      },
      message: ok(task),
    },
  ],
  'biome-clean': (task) => [
    { files: { 'src/cli/clamp.ts': HELPER }, message: ok(task) },
    {
      files: {
        'src/cli/clamp.ts':
          'export function clamp(v:number){var x=v;return x}\n',
      },
      message: ok(task),
    },
  ],
};

for (const template of TEMPLATES) {
  test(`${template} scorer passes a compliant repo and fails a violating one`, async () => {
    const task = taskFor(template);
    const [good, bad] = CASES[template](task);
    for (const [change, expected] of [
      [good, true],
      [bad, false],
    ] as const) {
      const { repo, base } = await scratch(task, change);
      try {
        const verdict = score(task, repo, base);
        assert.equal(verdict.pass, expected, verdict.reason);
      } finally {
        await rm(repo, { recursive: true, force: true });
      }
    }
  });
}

test('a repo without a commit after base fails every template', async () => {
  for (const template of TEMPLATES) {
    const task = taskFor(template);
    const { repo, base } = await scratch(task, {});
    try {
      assert.equal(score(task, repo, base).pass, false);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  }
});

test('role-names catches a dated identifier inside the diff', async () => {
  const task = taskFor('role-names');
  const { repo, base } = await scratch(task, {
    files: {
      'src/cli/clamp.ts': `export const clamp${task.date.replaceAll('-', '')} = 1;\n`,
    },
    message: ok(task),
  });
  try {
    assert.equal(score(task, repo, base).pass, false);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});
