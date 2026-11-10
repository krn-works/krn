import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import {
  countTouches,
  frameClass,
  gateManifest,
  gitLog,
  touches,
} from '../../src/outcome/gate-manifest.ts';

// `git log --first-parent -n 100 --name-only --format=@@%h 892dde7`, verbatim.
const log = readFileSync(
  new URL('../fixtures/gate-manifest/log-892dde7.txt', import.meta.url),
  'utf8',
).replaceAll('@@', '\0');
// `gateManifest` at 892dde7 without `scripts/lib/shard-weights.mjs`, which held the
// per-file weights then; they are data now (`scripts/lib/shard-weights.json`).
const runnerAt892dde7 = [
  'scripts/ci-changes.mjs',
  'scripts/lib/test-shards.mjs',
  'scripts/lib/test-timeout.ts',
  'scripts/lib/test-timings.mjs',
  'scripts/probe-isolation.mjs',
  'scripts/test-suite.mjs',
  'scripts/test-summary-policy.mjs',
  'scripts/weak-tests.mjs',
];

test('the last 100 commits at 892dde7 touch the frame 7, 9 and 18 times', () => {
  const counts = countTouches(touches(log, { runner: runnerAt892dde7 }));
  assert.equal(counts.commits, 100);
  assert.equal(counts.runner, 7);
  assert.equal(counts.frame, 9);
  assert.equal(counts.withTaskCheck, 18);
});

test('with the weights module in the closure the count is 32', () => {
  const runner = [...runnerAt892dde7, 'scripts/lib/shard-weights.mjs'];
  assert.equal(countTouches(touches(log, { runner })).runner, 32);
});

test('each path falls in one class', () => {
  const manifest = { runner: ['scripts/lib/test-shards.mjs'] };
  const cases: [string, ReturnType<typeof frameClass>][] = [
    ['.github/workflows/ci.yml', 'runner'],
    ['.github/actions/setup-ci/action.yml', 'runner'],
    ['package.json', 'runner'],
    ['scripts/lib/test-shards.mjs', 'runner'],
    ['scripts/lib/shard-weights.json', null],
    ['biome.json', 'validators'],
    ['.gitignore', 'validators'],
    ['tsconfig.json', 'validators'],
    ['mise.toml', 'validators'],
    ['scripts/boundaries.ts', 'validators'],
    ['src/ci/commit-title.ts', 'validators'],
    ['src/task/check.ts', 'taskCheck'],
    ['src/cli/main.ts', 'taskCheck'],
    ['test/cli.test.ts', 'tests'],
    ['docs/adr/0014-operator-decisions-2026-10-23.md', null],
  ];
  for (const [path, expected] of cases)
    assert.equal(frameClass(path, manifest), expected, path);
});

test('the current gate entry points hold no dynamic import and not the weights data', () => {
  const root = resolve(import.meta.dirname, '../..');
  const manifest = gateManifest(root);
  assert.ok(manifest.runner.includes('scripts/test-suite.mjs'));
  assert.ok(manifest.runner.includes('scripts/lib/test-shards.mjs'));
  assert.equal(
    manifest.runner.includes('scripts/lib/shard-weights.json'),
    false,
  );
  assert.deepEqual(manifest.dynamicImports, []);
});

test('a gate entry point that gains a dynamic import is reported', () => {
  const root = mkdtempSync(join(tmpdir(), 'gate-manifest-'));
  mkdirSync(join(root, 'scripts/lib'), { recursive: true });
  writeFileSync(
    join(root, 'scripts/test-suite.mjs'),
    "import './lib/a.mjs';\n",
  );
  writeFileSync(
    join(root, 'scripts/lib/a.mjs'),
    "export const load = () => import('./b.mjs');\n",
  );
  writeFileSync(join(root, 'scripts/lib/b.mjs'), 'export {};\n');
  const manifest = gateManifest(root);
  assert.deepEqual(manifest.dynamicImports, ['scripts/lib/a.mjs']);
  assert.ok(manifest.runner.includes('scripts/lib/b.mjs'));
});

test('the real git log reads back as commits with their frame classes', () => {
  const root = mkdtempSync(join(tmpdir(), 'gate-manifest-git-'));
  const git = (...args: string[]) =>
    execFileSync('git', ['-C', root, ...args], { stdio: 'pipe' });
  git('init', '-q');
  git('config', 'user.email', 'a@b.c');
  git('config', 'user.name', 'a');
  git('config', 'commit.gpgsign', 'false');
  writeFileSync(join(root, 'package.json'), '{}');
  writeFileSync(join(root, 'README.md'), 'x');
  git('add', '.');
  git('commit', '-q', '-m', 'one');
  writeFileSync(join(root, 'README.md'), 'y');
  git('commit', '-qam', 'two');
  const found = touches(gitLog(root, 'HEAD'), { runner: [] });
  assert.deepEqual(
    found.map((t) => t.classes),
    [[], ['runner']],
  );
});
