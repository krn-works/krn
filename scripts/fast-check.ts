// One-command changed-files verify: biome --write, tsc and the related tests, one verdict line.
import { AsyncLocalStorage } from 'node:async_hooks';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { availableParallelism } from 'node:os';
import { dirname, join, posix, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkedTree, writeFastPass } from '../src/ci/fast-pass.ts';
import { check as checkBoundaries } from './boundaries.ts';
import { withSlot } from './lib/slot-lock.ts';
import { testCeilingArguments } from './lib/test-timeout.ts';
import { refreshIndex } from './render-standards-index.ts';

const LINTABLE = /\.(?:ts|mts|cts|js|mjs|cjs|json|jsonc|css)$/u;
const TEST_FILE = /^test\/.+\.test\.(?:ts|js|mjs|cjs)$/u;

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

/** node argv for the related tests, under the suite's timeout ceiling. */
export function testRunnerArgs(
  files: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  return [
    '--test',
    '--test-reporter=dot',
    ...testCeilingArguments(env),
    ...files,
  ];
}

/** Repository-wide rule tests scan every tracked file; they cost ~0.5 s, so any change runs them. */
const RULE_TEST = /^test\/rules\//u;

/** Paths the instruction and documentation rule tests scan; a removed path always counts. */
const PROSE_PATHS =
  /^(?:AGENTS\.md|CLAUDE\.md|CONTEXT\.md|README\.md|docs\/|\.agents\/|\.claude\/|spec\/|tasks\/|\.github\/pull_request_template\.md$)/u;

/** Rule tests that read only prose paths: selected when the diff touches those, else CI runs them. */
const PROSE_RULE_TESTS = new Set([
  'test/rules/instruction-bytes.test.ts',
  'test/rules/instruction-references.test.ts',
  'test/rules/lead-traps.test.ts',
  'test/rules/one-owner-docs.test.ts',
  'test/rules/project-skills.test.ts',
  'test/rules/session-role.test.ts',
]);

/** Structure tests outside test/rules/ that preflight runs with the rule tests. */
const PREFLIGHT_EXTRA = ['test/evals/fr40-freeze.test.ts'];

/** The drift test file and its one test that reads this repository's skill copies; its other tests spawn adoptions and stay with the related stage. */
const DRIFT_TEST = 'test/adopt/drift.test.ts';
const DRIFT_NAME = 'this repository has no adoption drift';

/** The guard tests preflight runs first: every rule test the diff makes relevant (prose ones only for prose paths) and the structure tests beside them. */
export function preflightTests(
  changed: readonly string[],
  removed: readonly string[],
  tests: ReadonlyMap<string, string>,
): string[] {
  const prose = [...changed, ...removed].some((file) => PROSE_PATHS.test(file));
  return [...tests.keys()].filter(
    (path) =>
      (RULE_TEST.test(path) && (prose || !PROSE_RULE_TESTS.has(path))) ||
      PREFLIGHT_EXTRA.includes(path),
  );
}

/** The first failing rule line of a node test report, else its last lines. */
function ruleNamed(output: string): string {
  const names = [...output.matchAll(/^\s*[✖x] (.+?)(?: \(\d.*)?$/gmu)].map(
    (m) => m[1] ?? '',
  );
  return names.length > 0 ? `rule: ${names.join('; ')}\n${output}` : output;
}

/**
 * Tree-wide tests outside test/rules/ that read every file of an area: each is selected
 * when a changed or removed path matches its trigger, so a new module, hook or setting
 * runs them locally instead of costing a red CI round.
 */
const TREE_TESTS: ReadonlyArray<readonly [string, RegExp]> = [
  ['test/import-boundary.test.ts', /^(?:src|scripts)\/.+\.(?:ts|mjs)$/u],
  [
    'test/tool-scope.test.ts',
    /^(?:src\/|scripts\/|package\.json$|tsconfig.*\.json$|biome\.jsonc?$)/u,
  ],
  ['test/cli/hook.test.ts', /^src\/(?:cli|hook)\//u],
  // CI maps every test/rules file to a rule record; a new or renamed one must pass that map.
  ['test/brain/ci-rule-coverage.test.ts', /^test\/rules\/[^/]+\.test\.ts$/u],
];

/**
 * A test that exercises modules only through a child process (a CLI fixture) names the
 * path prefixes it covers in a `// fast-covers: <prefix> [<prefix>...]` comment.
 */
const COVERS = /^\/\/ fast-covers:(.+)$/mu;

/**
 * A slow test whose result depends only on named inputs declares them in a
 * `// fast-only: <prefix> [<prefix>...]` comment: fast runs it only when the diff touches one
 * of them (or the test itself), whatever else imports it. CI still runs it on every change.
 */
const FAST_ONLY = /^\/\/ fast-only:(.+)$/mu;

/** The fast-only prefixes a test declares; empty when it has none. */
export function fastOnlyPrefixes(source: string): string[] {
  return (FAST_ONLY.exec(source)?.[1] ?? '')
    .trim()
    .split(/\s+/u)
    .filter(Boolean);
}

const CLI_SPAWN = /bin\/krn|cli\/main\.ts|'bin',\s*'krn'|krn\.mjs/u;
const ROUTE = /^(?:command === '([\w-]+)'| {2}'?([\w-]+)'?: )/u;

/** Repo modules reached from an entry through relative imports, transitively. */
function importClosure(root: string, entry: string): Set<string> {
  const seen = new Set<string>();
  const queue = [entry];
  for (let path = queue.pop(); path !== undefined; path = queue.pop()) {
    if (seen.has(path)) continue;
    const file = join(root, path);
    if (!existsSync(file) || !lstatSync(file).isFile()) continue;
    seen.add(path);
    for (const target of importedPaths(path, readFileSync(file, 'utf8')))
      if (!seen.has(target)) queue.push(target);
  }
  return seen;
}

/** Every repo path a source reaches through relative imports, any number of hops; `readSource` returns a module's text or undefined when it is not a file. */
function transitiveImports(
  path: string,
  source: string,
  readSource: (path: string) => string | undefined,
): Set<string> {
  const reached = importedPaths(path, source);
  const visited = new Set<string>();
  const queue = [...reached];
  for (let next = queue.pop(); next !== undefined; next = queue.pop()) {
    if (visited.has(next)) continue;
    visited.add(next);
    const text = readSource(next);
    if (text === undefined) continue;
    for (const target of importedPaths(next, text)) {
      reached.add(target);
      if (!visited.has(target)) queue.push(target);
    }
  }
  return reached;
}

/** CLI command name -> src modules its entry in src/cli/index.ts imports, transitively. */
export function cliCommandModules(root: string): Map<string, Set<string>> {
  const modules = new Map<string, Set<string>>();
  const index = 'src/cli/index.ts';
  const file = join(root, index);
  if (!existsSync(file)) return modules;
  for (const branch of readFileSync(file, 'utf8').split(
    /(?=command === ')|(?=^ {2}'?[\w-]+'?: )/mu,
  )) {
    const hit = ROUTE.exec(branch);
    const name = hit?.[1] ?? hit?.[2];
    if (name === undefined) continue;
    const closure = modules.get(name) ?? new Set<string>();
    for (const entry of importedPaths(index, branch))
      for (const path of importClosure(root, entry)) closure.add(path);
    modules.set(name, closure);
  }
  return modules;
}

function coveredPrefixes(source: string): string[] {
  return (COVERS.exec(source)?.[1] ?? '').trim().split(/\s+/u).filter(Boolean);
}

/** A test that spawns bin/krn with a command name covers that command's modules. */
function spawnsCoveredModule(
  source: string,
  targets: ReadonlySet<string>,
  cliModules: ReadonlyMap<string, ReadonlySet<string>>,
): boolean {
  if (!CLI_SPAWN.test(source)) return false;
  for (const [command, modules] of cliModules)
    if (
      new RegExp(`['"\`]${command}['"\`]`, 'u').test(source) &&
      [...targets].some((target) => modules.has(target))
    )
      return true;
  return false;
}

/** The test that resolves every standards evidence anchor (`path#text`) against the repository. */
export const STANDARDS_TEST = 'test/brain/standards.test.ts';

/**
 * The standards test when a changed or removed file is named in a standards record's evidence:
 * moving the anchored text out of that file breaks the test, though nothing imports the file.
 */
export function evidenceTests(touched: string[], records: string): string[] {
  const paths = new Set<string>();
  for (const match of records.matchAll(/"([^"#:\s]+\.[a-z]+)#[^"]*"/gu))
    if (match[1]) paths.add(match[1]);
  return touched.some((file) => paths.has(file)) ? [STANDARDS_TEST] : [];
}

/**
 * Tests to run: changed tests, tests whose `fast-covers` prefixes match a changed path, tests whose imports resolve to a changed or removed file directly or through any chain of imported modules,
 * tests that name a changed or removed file by repository path, and the rule tests
 * (prose rule tests only when the diff touches the prose paths they scan).
 * A removed file is also matched by its basename when no surviving file shares it, so
 * `join(root, 'scripts', 'gone.mjs')` and doc assertions still find the reference.
 */
export function selectTests(
  changed: string[],
  tests: Map<string, string>,
  removed: string[] = [],
  surviving: ReadonlySet<string> = new Set(),
  cliModules: ReadonlyMap<string, ReadonlySet<string>> = new Map(),
  readSource: (path: string) => string | undefined = () => undefined,
): string[] {
  const picked = new Set(changed.filter((file) => tests.has(file)));
  const touched = [...changed, ...removed];
  const prose = touched.some((file) => PROSE_PATHS.test(file));
  if (touched.length > 0)
    for (const path of tests.keys())
      if (RULE_TEST.test(path) && (prose || !PROSE_RULE_TESTS.has(path)))
        picked.add(path);
  for (const [path, trigger] of TREE_TESTS)
    if (tests.has(path) && touched.some((file) => trigger.test(file)))
      picked.add(path);
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
      const covers = coveredPrefixes(source);
      if (
        names.some((name) => source.includes(name)) ||
        spawnsCoveredModule(source, targets, cliModules) ||
        [...targets].some((target) =>
          covers.some((prefix) => target.startsWith(prefix)),
        )
      )
        picked.add(path);
      else
        for (const target of transitiveImports(path, source, readSource))
          if (targets.has(target)) picked.add(path);
    }
  // A fast-only test runs exactly when the diff touches it or one of its declared inputs.
  for (const [path, source] of tests) {
    const only = fastOnlyPrefixes(source);
    if (only.length === 0) continue;
    if (
      touched.some(
        (file) =>
          file === path || only.some((prefix) => file.startsWith(prefix)),
      )
    )
      picked.add(path);
    else picked.delete(path);
  }
  return [...picked].sort();
}

export function lintable(changed: string[]): string[] {
  return changed.filter(
    (file) => LINTABLE.test(file) && !file.startsWith('tasks/'),
  );
}

/** A git command that failed; main() reports it and exits 2 instead of treating it as "no changes". */
export class GitError extends Error {}

/** Strict git: any non-zero exit throws a GitError naming the command and git's stderr. */
function git(root: string, args: string[]): string {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  if (result.status === 0) return result.stdout;
  const detail = (result.stderr || result.error?.message || '').trim();
  throw new GitError(
    `\`git ${args.join(' ')}\` failed (exit ${result.status ?? 'none'})${detail ? `: ${detail}` : ''}`,
  );
}

/** Tolerant probe: only for questions whose "no" is an answer (merge base, ref lookup). */
function probe(root: string, args: string[]): string {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  return result.status === 0 ? result.stdout.trim() : '';
}

function mergeBase(root: string): string {
  git(root, ['rev-parse', '--verify', 'HEAD']);
  for (const ref of ['origin/main', 'main']) {
    const base = probe(root, ['merge-base', 'HEAD', ref]);
    if (base) return base;
  }
  throw new GitError(
    'no merge base between HEAD and origin/main or main; pass --base <rev>',
  );
}

/** What a repo path is on disk: absent (deleted), content git can hold, or a device, pipe or socket. */
function entryKind(root: string, file: string): 'absent' | 'content' | 'other' {
  try {
    const kind = lstatSync(join(root, file));
    return kind.isFile() || kind.isSymbolicLink() || kind.isDirectory()
      ? 'content'
      : 'other';
  } catch {
    return 'absent';
  }
}

/**
 * Key of the exact working tree (tracked and untracked non-ignored content, `.krn/` excluded)
 * plus the base it diffs against: the tree is staged into a throwaway index and written out.
 */
export function treeKey(root: string, base?: string): string {
  const cache = join(root, '.krn/cache');
  mkdirSync(cache, { recursive: true });
  const index = join(cache, `fast-index-${process.pid}`);
  const env = { ...process.env, GIT_INDEX_FILE: index };
  try {
    // Not `git add -A`: it aborts on any entry that is not a regular file, symlink or
    // directory, and the harness sandbox mounts such placeholders into the clone root.
    const listed = spawnSync(
      'git',
      ['ls-files', '-z', '--cached', '--others', '--exclude-standard'],
      { cwd: root, encoding: 'utf8', maxBuffer: 1 << 28 },
    );
    if (listed.status !== 0) {
      throw new GitError(
        `\`git ls-files\` failed: ${listed.stderr.trim() || 'no detail'}`,
      );
    }
    const paths = listed.stdout
      .split('\0')
      .filter((path) => entryKind(root, path) === 'content');
    const staged = spawnSync(
      'git',
      ['update-index', '--add', '-z', '--stdin'],
      {
        cwd: root,
        env,
        input: paths.join('\0'),
        encoding: 'utf8',
        maxBuffer: 1 << 28,
      },
    );
    if (staged.status !== 0) {
      throw new GitError(
        `\`git update-index\` failed: ${staged.stderr.trim() || 'no detail'}`,
      );
    }
    // Agent state is not part of the tree, even where .gitignore does not hide it.
    spawnSync('git', ['rm', '-rq', '--cached', '--ignore-unmatch', '.krn'], {
      cwd: root,
      env,
    });
    const tree = spawnSync('git', ['write-tree'], {
      cwd: root,
      env,
      encoding: 'utf8',
    });
    if (tree.status !== 0) throw new GitError('`git write-tree` failed');
    return createHash('sha256')
      .update(`${tree.stdout.trim()}\0${base ?? mergeBase(root)}`)
      .digest('hex');
  } finally {
    rmSync(index, { force: true });
  }
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
    .filter((file) => entryKind(root, file) === 'content')
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
  const common = probe(root, ['rev-parse', '--git-common-dir']);
  if (!common) return undefined;
  const main = join(dirname(resolve(root, common)), 'node_modules/.bin');
  return existsSync(join(main, 'tsc')) ? main : undefined;
}

/** Records the PASS for the tree fast checked, uncommitted edits and Biome rewrites included, so committing exactly that content lets ship reuse it. */
function recordPass(root: string, passed: boolean): void {
  writeFastPass(root, passed ? checkedTree(root) : undefined);
}

/** The main checkout shared by every worktree, else the root itself. */
function sharedRoot(root: string): string {
  const common = probe(root, ['rev-parse', '--git-common-dir']);
  return common ? dirname(resolve(root, common)) : root;
}

/** Default holders: one per eight cores, so a 16-core host runs two fast checks at once instead of serialising every lane. */
export function defaultTestSlots(
  cores: number = availableParallelism(),
): number {
  return Math.max(1, Math.floor(cores / 8));
}

/** Slot lock options: one lock under the shared checkout's .krn/tmp, KRN_FAST_SLOTS holders at once. */
export function testSlotOptions(
  root: string,
  env: NodeJS.ProcessEnv = process.env,
  cores: number = availableParallelism(),
): { dir: string; slots: number } {
  const slots = Number(env.KRN_FAST_SLOTS);
  return {
    dir: env.KRN_FAST_SLOT_DIR ?? join(sharedRoot(root), '.krn/tmp/fast-slots'),
    slots:
      Number.isInteger(slots) && slots > 0 ? slots : defaultTestSlots(cores),
  };
}

/** Marks work that already holds a slot: a nested inTestSlot call runs inside it instead of queueing again. */
const slotHeld = new AsyncLocalStorage<true>();
/** Seconds this process waited for its slot; reported as its own timing, never inside a step's. */
export let slotWaitSeconds = 0;

/** Runs the heavy work under the host-wide slot lock and prints the wait when another fast run holds every slot. */
export function inTestSlot<T>(
  root: string,
  work: () => Promise<T>,
  env: NodeJS.ProcessEnv = process.env,
  write: (text: string) => void = (text) => process.stderr.write(text),
): Promise<T> {
  if (slotHeld.getStore()) return work();
  const waitStarted = performance.now();
  return withSlot(
    {
      ...testSlotOptions(root, env),
      onWait: (pid) =>
        write(
          `fast: waiting for a host test slot${pid ? ` (held by pid ${pid})` : ''}\n`,
        ),
    },
    () => {
      const waited = (performance.now() - waitStarted) / 1000;
      slotWaitSeconds += waited;
      if (waited >= 1)
        write(`fast: got a test slot after ${waited.toFixed(1)}s\n`);
      return slotHeld.run(true, work);
    },
  );
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
    const resolved = probe(root, [
      'rev-parse',
      '--verify',
      '--quiet',
      `${base}^{commit}`,
    ]);
    if (!resolved)
      return { error: `--base ${base} is not a commit in this repository` };
    // A base that moved past the branch point would diff other PRs' changes reversed: the
    // diff starts at the merge base, as the default path does. Unrelated histories keep the commit.
    return {
      base: probe(root, ['merge-base', 'HEAD', resolved]) || resolved,
    };
  }
  return {};
}

const gitNames = (root: string, args: string[]): string[] =>
  spawnSync('git', ['diff', '--name-only', ...args], {
    cwd: root,
    encoding: 'utf8',
  })
    .stdout.split('\n')
    .filter(Boolean);

/** Files whose whole change is staged: Biome fixes to them belong in the commit. */
export function fullyStaged(root: string): string[] {
  const unstaged = new Set(gitNames(root, []));
  return gitNames(root, ['--cached']).filter((file) => !unstaged.has(file));
}

/** Re-stages Biome fixes so `git add` before `npm run fast` keeps them (t-5350d6g). */
export function restage(root: string, staged: string[]): string[] {
  const fixed = staged.length > 0 ? gitNames(root, ['--', ...staged]) : [];
  if (fixed.length > 0)
    spawnSync('git', ['add', '--', ...fixed], { cwd: root });
  return fixed;
}

/** Fast structure and rule checks, in order, stopping at the first red: boundaries, weak-tests, then the guard tests (receiver evidence, drift, rules). */
async function preflight(
  root: string,
  base: string | undefined,
  guard: string[],
  drift: boolean,
): Promise<{ steps: Step[]; failed?: Step | undefined }> {
  const steps: Step[] = [];
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
  const stages: Array<() => Promise<Step>> = [
    // CI's Lint step runs the same floor on the PR diff; here it reads the working tree too.
    () =>
      run(root, 'weak-tests', process.execPath, [
        fileURLToPath(new URL('./weak-tests.mjs', import.meta.url)),
        base ?? mergeBase(root),
        '--worktree',
      ]),
    ...(guard.length > 0 || drift
      ? [
          async () => {
            const started = performance.now();
            const node = (name: string, ...rest: string[]): Promise<Step> =>
              run(root, name, process.execPath, [
                '--test',
                '--test-reporter=spec',
                ...testCeilingArguments(),
                ...rest,
              ]);
            const parts = await inTestSlot(root, () =>
              Promise.all([
                ...(guard.length > 0 ? [node('guard', ...guard)] : []),
                ...(drift
                  ? [
                      node(
                        'guard',
                        `--test-name-pattern=${DRIFT_NAME}`,
                        DRIFT_TEST,
                      ),
                    ]
                  : []),
              ]),
            );
            return {
              name: 'guard',
              ok: parts.every((part) => part.ok),
              seconds: (performance.now() - started) / 1000,
              output: parts.map((part) => part.output).join('\n'),
            };
          },
        ]
      : []),
  ];
  for (let i = 0; steps.at(-1)?.ok !== false && i < stages.length; i++)
    steps.push(await (stages[i] as () => Promise<Step>)());
  return { steps, failed: steps.find((step) => !step.ok) };
}

/** The stage check() is in, named by the verdict line when it stops without one. */
let stage = 'args';

/**
 * Runs the check so a crash still ends in a verdict: an uncaught error prints
 * `fast FAIL (<stage>): crashed: ...` instead of exiting 1 with only the npm banner.
 * Usage and setup exits (64, 2) keep their `fast: ...` line on stderr and no verdict.
 */
export async function main(
  root: string,
  argv: string[] = [],
  write: (text: string) => void = (text) => process.stdout.write(text),
): Promise<number> {
  stage = 'args';
  try {
    return await check(root, argv);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    write(`fast FAIL (${stage}): crashed: ${message.split('\n')[0]}\n`);
    return 1;
  }
}

async function check(root: string, argv: string[]): Promise<number> {
  const started = performance.now();
  const parsed = parseArgs(root, argv);
  if ('error' in parsed) {
    process.stderr.write(`fast: ${parsed.error}\n`);
    return 64;
  }
  // The standards index is generated from the pack: regenerate it so the diff below carries it.
  stage = 'index';
  refreshIndex(root);
  stage = 'git';
  let changed: string[];
  let removed: string[];
  let surviving: Set<string>;
  try {
    changed = changedFiles(root, parsed.base);
    removed = removedFiles(root, parsed.base);
    surviving = survivingFiles(root);
  } catch (error) {
    if (!(error instanceof GitError)) throw error;
    process.stderr.write(`fast: ${error.message}\n`);
    return 2;
  }
  if (changed.length + removed.length === 0) {
    process.stdout.write('fast PASS: no changed files\n');
    return 0;
  }
  const passMarker = join(root, '.krn/cache/fast-pass');
  let key: string;
  try {
    key = treeKey(root, parsed.base);
  } catch (error) {
    if (!(error instanceof GitError)) throw error;
    process.stderr.write(`fast: ${error.message}\n`);
    return 2;
  }
  if (existsSync(passMarker) && readFileSync(passMarker, 'utf8') === key) {
    recordPass(root, true);
    process.stdout.write(
      `fast PASS (cached): ${changed.length} changed, ${removed.length} removed; tree unchanged since the last pass\n`,
    );
    return 0;
  }
  stage = 'tools';
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
  stage = 'select';
  const tests = listTests(root);
  const recordsFile = join(root, 'standards/records.json');
  const related = [
    ...new Set([
      ...selectTests(
        changed,
        tests,
        removed,
        surviving,
        cliCommandModules(root),
        (path) => {
          const file = join(root, path);
          return existsSync(file) && lstatSync(file).isFile()
            ? readFileSync(file, 'utf8')
            : undefined;
        },
      ),
      ...(tests.has(STANDARDS_TEST) && existsSync(recordsFile)
        ? evidenceTests(
            [...changed, ...removed],
            readFileSync(recordsFile, 'utf8'),
          )
        : []),
    ]),
  ];
  const guard = new Set(preflightTests(changed, removed, tests));
  for (let i = related.length - 1; i >= 0; i--)
    if (guard.has(related[i] ?? '')) related.splice(i, 1);
  // One slot for the whole check: the guard, tsc and tests (and a Biome redo) never queue twice.
  return inTestSlot(root, async () => {
    stage = 'preflight';
    const pre = await preflight(
      root,
      parsed.base,
      [...guard],
      tests.has(DRIFT_TEST),
    );
    if (pre.failed) {
      process.stdout.write(
        `--- ${pre.failed.name} ---\n${ruleNamed(pre.failed.output).trim().split('\n').slice(-60).join('\n')}\n`,
      );
      const total = ((performance.now() - started) / 1000).toFixed(1);
      rmSync(passMarker, { force: true });
      recordPass(root, false);
      process.stdout.write(
        `fast FAIL (${pre.failed.name}): preflight stopped before lint, tsc and the related tests; ${pre.steps.map((step) => `${step.name} ${Math.round(step.seconds * 1000)}ms`).join(', ')}; total ${total}s\n`,
      );
      return 1;
    }
    const snapshot = (): string =>
      changed.map((file) => readFileSync(join(root, file), 'utf8')).join('\0');
    // tsc and the related tests hold one host-wide slot together: concurrent lanes queue instead of thrashing.
    const verify = (): Promise<Step[]> =>
      inTestSlot(root, () =>
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
                  testRunnerArgs(related),
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
        ]),
      );
    // tsc and tests start at once with biome; they are redone only if biome rewrote a file.
    const before = snapshot();
    const staged = fullyStaged(root).filter((file) => files.includes(file));
    const lint =
      files.length > 0
        ? run(root, 'biome', bin('biome'), [
            'check',
            '--write',
            '--error-on-warnings',
            '--no-errors-on-unmatched',
            ...files,
          ])
        : undefined;
    stage = 'verify';
    let verified = verify();
    const steps: Step[] = [...pre.steps];
    if (lint) {
      steps.push(await lint);
      if (snapshot() !== before) {
        const fixed = restage(root, staged);
        if (fixed.length > 0)
          process.stdout.write(
            `fast: re-staged Biome fixes to ${fixed.join(', ')}\n`,
          );
        await verified;
        verified = verify();
      }
    }
    steps.push(...(await verified));
    const failed = steps.filter((step) => !step.ok);
    for (const step of failed)
      process.stdout.write(
        `--- ${step.name} ---\n${step.output.trim().split('\n').slice(-60).join('\n')}\n`,
      );
    const timing = [
      ...(slotWaitSeconds >= 1
        ? [`slot-wait ${Math.round(slotWaitSeconds * 1000)}ms`]
        : []),
      ...steps.map(
        (step) => `${step.name} ${Math.round(step.seconds * 1000)}ms`,
      ),
    ].join(', ');
    const total = ((performance.now() - started) / 1000).toFixed(1);
    const verdict =
      failed.length === 0
        ? 'PASS'
        : `FAIL (${failed.map((step) => step.name).join(', ')})`;
    // Biome may have rewritten files, so the key is taken after the run; a FAIL clears the marker.
    rmSync(passMarker, { force: true });
    if (failed.length === 0)
      writeFileSync(passMarker, treeKey(root, parsed.base));
    recordPass(root, failed.length === 0);
    process.stdout.write(
      `fast ${verdict}: ${changed.length} changed, ${removed.length} removed, ${files.length} linted, ${related.length} tests; ${timing}; total ${total}s\n`,
    );
    return failed.length === 0 ? 0 : 1;
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url))
  process.exitCode = await main(process.cwd(), process.argv.slice(2));
