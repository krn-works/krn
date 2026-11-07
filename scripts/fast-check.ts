// One-command changed-files verify: biome --write, tsc and the related tests, one verdict line.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const LINTABLE = /\.(?:ts|mts|cts|js|mjs|cjs|json|jsonc|css)$/u;
const TEST_FILE = /^test\/.+\.test\.(?:ts|js|mjs|cjs)$/u;
const CODE = /^(?:src|scripts|bin)\/.+\.(?:ts|mts|js|mjs|cjs)$/u;

const stem = (file: string): string => basename(file).replace(/\..+$/u, '');

/** Tests to run: changed tests, same-stem tests, and tests importing a changed module. */
export function selectTests(
  changed: string[],
  tests: Map<string, string>,
): string[] {
  const picked = new Set(changed.filter((file) => tests.has(file)));
  for (const file of changed.filter((name) => CODE.test(name))) {
    const name = stem(file);
    const spec = new RegExp(
      `['"][^'"]*/${name.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}(?:\\.[a-z]+)?['"]`,
      'u',
    );
    for (const [path, source] of tests)
      if (stem(path) === name || spec.test(source)) picked.add(path);
  }
  return [...picked].sort();
}

export function lintable(changed: string[]): string[] {
  return changed.filter(
    (file) => LINTABLE.test(file) && !file.startsWith('tasks/'),
  );
}

function git(root: string, args: string[]): string {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  return result.status === 0 ? result.stdout : '';
}

export function changedFiles(root: string): string[] {
  let base = '';
  for (const ref of ['origin/main', 'main'])
    base ||= git(root, ['merge-base', 'HEAD', ref]).trim();
  const tracked = git(root, [
    'diff',
    '--name-only',
    '--diff-filter=d',
    base || 'HEAD',
  ]);
  const fresh = git(root, ['ls-files', '--others', '--exclude-standard']);
  return [...new Set(`${tracked}\n${fresh}`.split('\n').filter(Boolean))]
    .filter((file) => existsSync(join(root, file)))
    .sort();
}

function listTests(root: string): Map<string, string> {
  const tests = new Map<string, string>();
  const walk = (dir: string): void => {
    for (const entry of readdirSync(join(root, dir), { withFileTypes: true })) {
      const path = `${dir}/${entry.name}`;
      if (entry.isDirectory()) walk(path);
      else if (TEST_FILE.test(path))
        tests.set(path, readFileSync(join(root, path), 'utf8'));
    }
  };
  walk('test');
  return tests;
}

type Step = { name: string; ok: boolean; seconds: number; output: string };

function run(
  root: string,
  name: string,
  command: string,
  args: string[],
): Promise<Step> {
  const started = performance.now();
  return new Promise((resolve) => {
    let output = '';
    const child = spawn(command, args, {
      cwd: root,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.on('data', (chunk) => {
      output += chunk;
    });
    child.stderr.on('data', (chunk) => {
      output += chunk;
    });
    const done = (ok: boolean): void =>
      resolve({
        name,
        ok,
        seconds: (performance.now() - started) / 1000,
        output,
      });
    child.once('error', () => done(false));
    child.once('close', (code) => done(code === 0));
  });
}

export async function main(root: string): Promise<number> {
  const started = performance.now();
  const changed = changedFiles(root);
  if (changed.length === 0) {
    process.stdout.write('fast PASS: no changed files\n');
    return 0;
  }
  const bin = (name: string): string => join(root, 'node_modules/.bin', name);
  const steps: Step[] = [];
  const files = lintable(changed);
  if (files.length > 0)
    steps.push(
      await run(root, 'biome', bin('biome'), [
        'check',
        '--write',
        '--no-errors-on-unmatched',
        ...files,
      ]),
    );
  const cache = join(root, '.krn/cache');
  mkdirSync(cache, { recursive: true });
  const related = selectTests(changed, listTests(root));
  const parallel = [
    run(root, 'tsc', bin('tsc'), [
      '--noEmit',
      '--incremental',
      '--tsBuildInfoFile',
      join(cache, 'fast.tsbuildinfo'),
    ]),
  ];
  if (related.length > 0)
    parallel.push(
      run(root, 'test', process.execPath, [
        '--test',
        '--test-reporter=dot',
        ...related,
      ]),
    );
  steps.push(...(await Promise.all(parallel)));
  const failed = steps.filter((step) => !step.ok);
  for (const step of failed)
    process.stdout.write(
      `--- ${step.name} ---\n${step.output.trim().split('\n').slice(-60).join('\n')}\n`,
    );
  const timing = steps
    .map((step) => `${step.name} ${step.seconds.toFixed(1)}s`)
    .join(', ');
  const total = ((performance.now() - started) / 1000).toFixed(1);
  const verdict =
    failed.length === 0
      ? 'PASS'
      : `FAIL (${failed.map((step) => step.name).join(', ')})`;
  process.stdout.write(
    `fast ${verdict}: ${changed.length} changed, ${files.length} linted, ${related.length} tests; ${timing}; total ${total}s\n`,
  );
  return failed.length === 0 ? 0 : 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url))
  process.exitCode = await main(process.cwd());
