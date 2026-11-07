// One-command changed-files verify: biome --write, tsc and the related tests, one verdict line.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { join, posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import { check as checkBoundaries } from './boundaries.ts';

const LINTABLE = /\.(?:ts|mts|cts|js|mjs|cjs|json|jsonc|css)$/u;
const TEST_FILE = /^test\/.+\.test\.(?:ts|js|mjs|cjs)$/u;
const CODE = /^(?:src|scripts|bin)\/.+\.(?:ts|mts|js|mjs|cjs)$/u;

const SPECIFIER =
  /(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)(['"])(\.{1,2}\/[^'"]+)\1/gu;
const EXTENSIONS = ['', '.ts', '.mts', '.js', '.mjs', '/index.ts', '/index.js'];

/** Repo paths a test source imports by relative specifier, resolved from the test's directory. */
function importedPaths(testPath: string, source: string): Set<string> {
  const found = new Set<string>();
  const dir = posix.dirname(testPath);
  for (const match of source.matchAll(SPECIFIER)) {
    const target = posix.join(dir, match[2] ?? '');
    for (const ext of EXTENSIONS) found.add(target + ext);
    // A .js specifier may stand for a .ts source.
    if (target.endsWith('.js')) found.add(`${target.slice(0, -3)}.ts`);
  }
  return found;
}

/** Tests to run: changed tests, plus tests whose imports resolve to a changed file. */
export function selectTests(
  changed: string[],
  tests: Map<string, string>,
): string[] {
  const picked = new Set(changed.filter((file) => tests.has(file)));
  const code = new Set(changed.filter((name) => CODE.test(name)));
  if (code.size > 0)
    for (const [path, source] of tests)
      for (const target of importedPaths(path, source))
        if (code.has(target)) picked.add(path);
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
  const files = lintable(changed);
  const cache = join(root, '.krn/cache');
  mkdirSync(cache, { recursive: true });
  const related = selectTests(changed, listTests(root));
  const snapshot = (): string =>
    changed.map((file) => readFileSync(join(root, file), 'utf8')).join('\0');
  const verify = (): Promise<Step[]> =>
    Promise.all([
      run(root, 'tsc', bin('tsc'), [
        '--noEmit',
        '--incremental',
        '--tsBuildInfoFile',
        join(cache, 'fast.tsbuildinfo'),
      ]),
      ...(related.length > 0
        ? [
            run(root, 'test', process.execPath, [
              '--test',
              '--test-reporter=dot',
              ...related,
            ]),
          ]
        : []),
    ]);
  // tsc and tests start at once with biome; they are redone only if biome rewrote a file.
  const before = snapshot();
  const lint =
    files.length > 0
      ? run(root, 'biome', bin('biome'), [
          'check',
          '--write',
          '--no-errors-on-unmatched',
          ...files,
        ])
      : undefined;
  let verified = verify();
  const steps: Step[] = [];
  if (lint) {
    steps.push(await lint);
    if (snapshot() !== before) {
      await verified;
      verified = verify();
    }
  }
  const boundaryStart = performance.now();
  const violations = checkBoundaries(root);
  steps.push({
    name: 'boundaries',
    ok: violations.length === 0,
    seconds: (performance.now() - boundaryStart) / 1000,
    output: violations
      .map((v) => `${v.file}:${v.line}: forbidden import ${v.edge}`)
      .join('\n'),
  });
  steps.push(...(await verified));
  const failed = steps.filter((step) => !step.ok);
  for (const step of failed)
    process.stdout.write(
      `--- ${step.name} ---\n${step.output.trim().split('\n').slice(-60).join('\n')}\n`,
    );
  const timing = steps
    .map((step) => `${step.name} ${Math.round(step.seconds * 1000)}ms`)
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
