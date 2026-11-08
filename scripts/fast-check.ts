// One-command changed-files verify: biome --write, tsc and the related tests, one verdict line.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, posix, resolve } from 'node:path';
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

/** Repository-wide rule tests scan every tracked file; they cost ~0.5 s, so any change runs them. */
const RULE_TEST = /^test\/rules\//u;

/**
 * Tests to run: changed tests, tests whose imports resolve to a changed or removed file,
 * tests that name a changed or removed file by repository path, and the rule tests.
 * A removed file is also matched by its basename when no surviving file shares it, so
 * `join(root, 'scripts', 'gone.mjs')` and doc assertions still find the reference.
 */
export function selectTests(
  changed: string[],
  tests: Map<string, string>,
  removed: string[] = [],
  surviving: ReadonlySet<string> = new Set(),
): string[] {
  const picked = new Set(changed.filter((file) => tests.has(file)));
  if (changed.length + removed.length > 0)
    for (const path of tests.keys()) if (RULE_TEST.test(path)) picked.add(path);
  const targets = new Set(
    [...changed, ...removed].filter((name) => !tests.has(name)),
  );
  const names = [...targets];
  const taken = new Set([...surviving].map((file) => posix.basename(file)));
  for (const file of removed) {
    const base = posix.basename(file);
    if (!taken.has(base)) names.push(base);
  }
  if (targets.size > 0)
    for (const [path, source] of tests) {
      if (names.some((name) => source.includes(name))) picked.add(path);
      else
        for (const target of importedPaths(path, source))
          if (targets.has(target)) picked.add(path);
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

function mergeBase(root: string): string {
  let base = '';
  for (const ref of ['origin/main', 'main'])
    base ||= git(root, ['merge-base', 'HEAD', ref]).trim();
  return base || 'HEAD';
}

function lines(text: string): string[] {
  return text.split('\n').filter(Boolean);
}

export function changedFiles(root: string, base?: string): string[] {
  const tracked = git(root, [
    'diff',
    '--name-only',
    '--no-renames',
    '--diff-filter=d',
    base ?? mergeBase(root),
  ]);
  const fresh = git(root, ['ls-files', '--others', '--exclude-standard']);
  return [...new Set(lines(`${tracked}\n${fresh}`))]
    .filter((file) => existsSync(join(root, file)))
    .sort();
}

/** Tracked files the change deletes or renames away since the merge base. */
export function removedFiles(root: string, base?: string): string[] {
  const gone = git(root, [
    'diff',
    '--name-only',
    '--no-renames',
    '--diff-filter=D',
    base ?? mergeBase(root),
  ]);
  return lines(gone)
    .filter((file) => !existsSync(join(root, file)))
    .sort();
}

function survivingFiles(root: string): Set<string> {
  return new Set(
    lines(
      git(root, ['ls-files', '--cached', '--others', '--exclude-standard']),
    ).filter((file) => existsSync(join(root, file))),
  );
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

/** Directory holding tool binaries: this checkout's, else the main checkout's (fresh worktrees have none). */
export function toolBin(root: string): string | undefined {
  const own = join(root, 'node_modules/.bin');
  if (existsSync(join(own, 'tsc'))) return own;
  const common = git(root, ['rev-parse', '--git-common-dir']).trim();
  if (!common) return undefined;
  const main = join(dirname(resolve(root, common)), 'node_modules/.bin');
  return existsSync(join(main, 'tsc')) ? main : undefined;
}

type Step = { name: string; ok: boolean; seconds: number; output: string };

function run(
  root: string,
  name: string,
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
): Promise<Step> {
  const started = performance.now();
  return new Promise((resolve) => {
    let output = '';
    const child = spawn(command, args, {
      cwd: root,
      env,
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

/** Parses `--base <rev>` or `--base=<rev>`; a usage error names the problem. */
export function parseArgs(
  root: string,
  argv: string[],
): { base?: string } | { error: string } {
  let base: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? '';
    if (arg === '--base' || arg.startsWith('--base=')) {
      base = arg === '--base' ? argv[++i] : arg.slice('--base='.length);
      if (!base || base.startsWith('-'))
        return { error: '--base needs a commit' };
    } else
      return { error: `unknown argument ${arg}; usage: fast [--base <rev>]` };
  }
  if (base !== undefined) {
    const resolved = git(root, [
      'rev-parse',
      '--verify',
      '--quiet',
      `${base}^{commit}`,
    ]).trim();
    if (!resolved)
      return { error: `--base ${base} is not a commit in this repository` };
    return { base: resolved };
  }
  return {};
}

export async function main(root: string, argv: string[] = []): Promise<number> {
  const started = performance.now();
  const parsed = parseArgs(root, argv);
  if ('error' in parsed) {
    process.stderr.write(`fast: ${parsed.error}\n`);
    return 64;
  }
  const changed = changedFiles(root, parsed.base);
  const removed = removedFiles(root, parsed.base);
  if (changed.length + removed.length === 0) {
    process.stdout.write('fast PASS: no changed files\n');
    return 0;
  }
  const tools = toolBin(root);
  if (!tools) {
    process.stderr.write(
      `fast: no node_modules in ${root} or the main checkout; run \`npm ci\` or \`ln -s <main checkout>/node_modules node_modules\`\n`,
    );
    return 64;
  }
  const bin = (name: string): string => join(tools, name);
  const files = lintable(changed);
  const cache = join(root, '.krn/cache');
  mkdirSync(cache, { recursive: true });
  const related = selectTests(
    changed,
    listTests(root),
    removed,
    survivingFiles(root),
  );
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
            run(
              root,
              'test',
              process.execPath,
              ['--test', '--test-reporter=dot', ...related],
              // Tests start Node children (CLIs under test); like the suite
              // runner, they share its compile cache instead of recompiling
              // unchanged sources in every child.
              {
                ...process.env,
                NODE_COMPILE_CACHE:
                  process.env.NODE_COMPILE_CACHE ??
                  join(root, '.krn/tmp/node-compile-cache'),
              },
            ),
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
    `fast ${verdict}: ${changed.length} changed, ${removed.length} removed, ${files.length} linted, ${related.length} tests; ${timing}; total ${total}s\n`,
  );
  return failed.length === 0 ? 0 : 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url))
  process.exitCode = await main(process.cwd(), process.argv.slice(2));
