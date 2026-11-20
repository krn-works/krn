import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  type Dirent,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, posix, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  BOUNDARY_WORDS,
  characterizingTests,
  clauseProof,
  isTestFile,
  LEGACY_TEST,
  markedTests,
  missingBoundary,
  splitClauses,
  TEST_FILE,
} from '../brain/acceptance-clauses.ts';
import {
  appendExposure,
  exposureOf,
  readExposures,
} from '../brain/exposures.ts';
import { recordChecks, standardsBlockers } from '../brain/standards-cli.ts';
import { hookStdin } from '../harness/claude.ts';
import {
  armOn,
  ContractError,
  type RepoContract,
  relatedCommand,
  rerunCommand,
  resolveContract,
  withinPackage,
} from '../repo/contract.ts';

export { withinPackage };

import { statesBlocker } from '../brain/proof-line.ts';
import { ghApiSync } from '../repo/gh.ts';
import { laneMergeVerdict } from '../repo/merge-verdict.ts';
import { receiverEnv } from '../repo/receiver-env.ts';
import { shipRecordDir } from '../repo/ship-record.ts';
import { SlotTimeoutError, withSlotSync } from '../repo/slot-lock.ts';
import { SLOT_HELD_ENV, testSlotOptions } from '../repo/test-slot.ts';
import {
  clearSandboxPlaceholders,
  isSandboxPlaceholder,
} from '../state/sandbox-placeholders.ts';
import { inspectClaim, type TaskClaim } from '../task/claims.ts';
import { isTaskPath } from '../task/paths.ts';
import {
  claudeJudge,
  type JudgeCall,
  outcomeRefusal,
} from './outcome-judge.ts';
import { isLaneSubagent, UNIDENTIFIED_LANE, worker } from './scope.ts';
import { stuckInStopLoop } from './stop-loop.ts';

// Stop hook for worker sessions, and the related-test command a lane brief names:
//   krn hook stop --related    prints the tests (or Go packages) this branch's change selects
//   krn hook stop --red        prints the changed test files that fail against the base (the lane proof line's red-first)
//   krn hook stop --check      runs them; exit 0 only with a commit and green tests
// D23 arm K ended 7 of 20 n100 runs without a commit (four in under 40 s), and a scoped test list given to the
// agent measured +5 pp at lower cost. A worker session (KRN_SESSION_CLASS=lane or KRN_ROLE=worker) is refused
// the end of its turn while its branch has no commit past the base or the selected tests are red.
// The repo contract (src/repo/contract.ts, krn.json or detected) names the base, the related-test command, the
// full test command and the guard tests, so the check runs in any stack:
// - selection: tests importing a changed file (JS import graph), tests naming its path, tests whose name matches
//   a changed file's stem (test_calc.py, calc_test.go, calc.spec.ts), and the package directory of a changed
//   .go file; guard tests run on every change. A change that selects nothing but guards runs the guards, and
//   one that selects nothing at all runs the full test command, never nothing.
// - running: `node --test {files}` keeps the per-test reporter; any other command runs in sh and its failures
//   are read from pytest, unittest, go, cargo and jest/vitest output, else keyed by the exit status.
// A worker whose clone has no base ref, or whose krn.json is invalid, is refused once, naming the cause.
// One explicit escape: a final message with a line starting `BLOCKER:` that states the blocker.
// The lead sets neither variable, so it is never held here. A crash refuses (exit 2), never allows.

/** One failure line of the node test runner's JSON reporter. */
export function failureLine(
  value: unknown,
): { file: string; name: string } | undefined {
  // Hand-checked, not zod: the Stop hook runs in replay clones that have no node_modules.
  if (typeof value !== 'object' || value === null) return undefined;
  const { file, name } = value as { file?: unknown; name?: unknown };
  return typeof file === 'string' && typeof name === 'string'
    ? { file, name }
    : undefined;
}

const SPECIFIER =
  /(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)(['"])(\.{1,2}\/[^'"]+)\1/gu;
const EXTENSIONS = ['', '.ts', '.mts', '.js', '.mjs', '/index.ts', '/index.js'];
const NODE_RELATED = 'node --test {files}';

export { statesBlocker };

/** Repo paths a test source imports by relative specifier. */
function imported(testPath: string, source: string): Set<string> {
  const found = new Set<string>();
  const dir = posix.dirname(testPath);
  for (const match of source.matchAll(SPECIFIER)) {
    const target = posix.join(dir, match[2] ?? '');
    for (const ext of EXTENSIONS) found.add(target + ext);
    if (target.endsWith('.js')) found.add(`${target.slice(0, -3)}.ts`);
  }
  return found;
}

/** Whether the source holds the repository path as a quoted string literal. */
function namesPath(source: string, file: string): boolean {
  return ["'", '"', '`'].some((quote) => source.includes(quote + file + quote));
}

/** A test that runs the whole project's tools (`npm test`, `npm run check`) on a probe: it reads every config by path without naming one. */
function runsProjectTools(source: string): boolean {
  return /\[\s*(['"])npm\1\s*,\s*\[\s*(['"])(?:test|run)\2/u.test(source);
}

/** A changed file that configures tools rather than being code or prose: .claude/settings.json, package.json, tsconfig.json. */
const isToolConfig = (file: string) =>
  /\.(?:json|ya?ml|toml)$/u.test(file) && !isTaskPath(file);

const isGuard = (path: string, guard: readonly string[]) =>
  guard.some((prefix) => path === prefix || path.startsWith(prefix));

/** A file name without directory, extensions and test affixes: src/calc.py, tests/test_calc.py and calc_test.go are all `calc`. */
function stem(path: string): string {
  return (posix.basename(path).split('.')[0] ?? '')
    .replace(/^test_/u, '')
    .replace(/_(?:test|spec)$/u, '');
}

/**
 * Tests among `tests` (path to source) sorted that are changed, import a changed file, name a changed
 * file's repository path as a string literal (data files read by path), share a changed file's stem, or are
 * a guard (a path under one of the `guard` prefixes, selected whenever any file changed).
 */
export function relatedTests(
  changed: string[],
  tests: Map<string, string>,
  guard: readonly string[] = [],
): string[] {
  const picked = new Set(changed.filter((file) => tests.has(file)));
  const targets = new Set(changed.filter((file) => !tests.has(file)));
  const stems = new Set([...targets].map(stem).filter(Boolean));
  for (const [path, source] of tests) {
    for (const target of imported(path, source))
      if (targets.has(target)) picked.add(path);
    if (!LEGACY_TEST.test(path) && stems.has(stem(path))) picked.add(path);
  }
  if (changed.length > 0)
    for (const [path, source] of tests) {
      if (isGuard(path, guard)) picked.add(path);
      else if ([...targets].some((file) => namesPath(source, file)))
        picked.add(path);
      else if (runsProjectTools(source) && [...targets].some(isToolConfig))
        picked.add(path);
    }
  return [...picked].sort();
}

/** What one Stop check runs: chosen test files (or Go package directories), or the full test command. */
export interface Selection {
  readonly files: readonly string[];
  readonly full: boolean;
}

/**
 * The selection for a change: related tests plus guards; guards alone when nothing else relates; the full
 * test command when nothing at all relates. Go selects the package directory of every changed .go file.
 */
export function selectTests(
  changed: string[],
  tests: Map<string, string>,
  guard: readonly string[] = [],
  go = false,
  exists: (path: string) => boolean = () => true,
): Selection {
  if (changed.length === 0) return { files: [], full: false };
  const picked = relatedTests(changed, tests, guard);
  const guards = picked.filter((path) => isGuard(path, guard));
  const related = go
    ? [
        ...new Set(
          changed
            .filter((file) => file.endsWith('.go'))
            .map((file) => posix.dirname(file))
            .filter(exists)
            .map((dir) => (dir === '.' ? '.' : `./${dir}`)),
        ),
      ].sort()
    : picked.filter((path) => !isGuard(path, guard));
  if (related.length === 0 && guards.length === 0)
    return { files: [], full: true };
  return { files: [...new Set([...related, ...guards])], full: false };
}

const git = (root: string, args: string[]) =>
  spawnSync('git', args, { cwd: root, encoding: 'utf8' });

/** Test files in the tree, tracked or untracked, that exist now. */
function listTests(root: string): Map<string, string> {
  const tests = new Map<string, string>();
  const listed = git(root, [
    'ls-files',
    '--cached',
    '--others',
    '--exclude-standard',
  ]).stdout;
  for (const path of listed.split('\n'))
    if (TEST_FILE.some((pattern) => pattern.test(path)))
      try {
        tests.set(path, readFileSync(join(root, path), 'utf8'));
      } catch (error) {
        // A path git lists but the tree no longer has (deleted, unstaged) is not a test to run.
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
  return tests;
}

/** The contract, or the reason it cannot be read; no contract at all is undefined (legacy JS layout). */
function loadContract(root: string): {
  contract?: RepoContract;
  error?: string;
} {
  try {
    return { contract: resolveContract(root).contract };
  } catch (error) {
    if (!(error instanceof ContractError)) throw error;
    // A tree with no recognised test command falls back to node --test over test/; a broken krn.json does not.
    return existsSync(join(root, 'krn.json')) ? { error: error.message } : {};
  }
}

const guardOf = (contract?: RepoContract): string[] =>
  contract?.guard?.split(/\s+/u).filter(Boolean) ?? [];

function base(root: string, contract?: RepoContract): string {
  const named = contract?.base ?? 'main';
  for (const ref of new Set([
    `origin/${named}`,
    named,
    'origin/main',
    'main',
  ])) {
    const found = git(root, ['merge-base', 'HEAD', ref]);
    if (found.status === 0 && found.stdout.trim()) return found.stdout.trim();
  }
  return '';
}

/** Files the branch changed past its base, committed or not, minus the empty sandbox placeholders, deleted ones included. */
export function changedSinceBase(root: string, from = base(root)): string[] {
  if (!from) return [];
  const untracked = git(root, ['ls-files', '--others', '--exclude-standard'])
    .stdout.split('\n')
    .filter((path) => !isSandboxPlaceholder(root, path));
  const out = [
    git(root, ['diff', '--name-only', from]).stdout,
    ...untracked,
  ].join('\n');
  return [...new Set(out.split('\n').filter(Boolean))].sort();
}

export interface Outcome {
  ok: boolean;
  reason: string;
  /** Set when no host test slot came free before the deadline: the tests did not run, which is not a test failure. */
  slotTimeout?: string;
  /** Test files that failed, then passed on the one rerun. */
  flaky?: string[];
}

/** The file a failing key names; `<run>::` keys name none. */
function keyFile(key: string): string | undefined {
  return NAMELESS.test(key) ? undefined : key.split('::')[0];
}

/**
 * Rerun the failing test files once: a key that passes on the rerun is flaky, a key that fails again stays
 * failing, and a failure naming no file (or no file on disk for a command run) is not rerun.
 */
function settleFailures(
  failing: string[],
  rerun: (files: string[]) => string[],
  rerunnable: (file: string) => boolean,
): { failing: string[]; flaky: string[] } {
  const files = [
    ...new Set(
      failing
        .map(keyFile)
        .filter(
          (file): file is string => file !== undefined && rerunnable(file),
        ),
    ),
  ];
  if (files.length === 0) return { failing, flaky: [] };
  const again = new Set(rerun(files));
  const kept = failing.filter((key) => {
    const file = keyFile(key);
    return file === undefined || !files.includes(file) || again.has(key);
  });
  const extra = [...again].filter((key) => !failing.includes(key));
  return {
    failing: [...kept, ...extra].sort(),
    flaky: failing.filter((key) => !kept.includes(key)),
  };
}

const SKIP_MARK =
  /\.skip\b|\b(?:xit|xdescribe|xtest)\s*\(|\bxfail\b|\bpytest\.skip\b|@(?:unittest\.)?skip(?:If|Unless)?\b|\bt\.Skip(?:Now)?\s*\(|#\[ignore\b|\{\s*skip\s*:|\bpending\s*\(/u;

/** What the branch did to tests: deleted files, files that gain a skip or xfail, edited pre-existing files. */
export interface TestEdits {
  deleted: string[];
  skipped: string[];
  modified: string[];
}

function safeRead(path: string): string {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return '';
  }
}

const WEAKENS_REASON = /^\s*Weakens-tests:\s*\S+/imu;
const LOCAL_IMPORT =
  /(?:\bfrom\s+|\bimport\s*\(?\s*|\brequire\s*\(\s*)['"](\.{1,2}\/[^'"]+)['"]/gu;
const stemOfFile = (path: string) =>
  (path.split('/').pop() ?? '').replace(/\.test\.\w+$|\.\w+$/u, '');

/**
 * A deleted test is explained when a branch commit carries a `Weakens-tests:` reason, or when the branch
 * also deleted at least one source it imported (or, with no local import, the source sharing its name).
 */
function deletionExplained(root: string, from: string, path: string): boolean {
  const log = git(root, ['log', '--format=%B', `${from}..HEAD`]).stdout;
  if (WEAKENS_REASON.test(log)) return true;
  const text = git(root, ['show', `${from}:${path}`]).stdout;
  const dir = path.split('/').slice(0, -1);
  const imported = [...text.matchAll(LOCAL_IMPORT)]
    .map((match) => posix.join(...dir, match[1] ?? ''))
    .filter((target) => !isTestFile(target));
  const existed = (target: string) =>
    git(root, ['cat-file', '-e', `${from}:${target}`]).status === 0;
  const present = (target: string) => existsSync(join(root, target));
  const sources = imported.filter(existed);
  if (sources.length > 0) return sources.some((target) => !present(target));
  const stem = stemOfFile(path);
  const named = git(root, ['ls-tree', '-r', '--name-only', from])
    .stdout.split('\n')
    .filter((file) => file && !isTestFile(file) && stemOfFile(file) === stem);
  return named.length > 0 && named.every((file) => !present(file));
}

export function testEdits(root: string, from: string): TestEdits {
  const edits: TestEdits = { deleted: [], skipped: [], modified: [] };
  const status = git(root, ['diff', '--name-status', '-M', from]).stdout.split(
    '\n',
  );
  for (const line of status) {
    const [kind, first, second] = line.split('\t');
    // A rename moves a test: it is kept, and only lines it gains count for skips.
    const renamed = kind?.startsWith('R') === true && second !== undefined;
    const path = renamed ? second : first;
    if (!kind || !path || !isTestFile(path)) continue;
    if (kind === 'D') {
      if (!deletionExplained(root, from, path)) edits.deleted.push(path);
      continue;
    }
    if (kind === 'M') edits.modified.push(path);
    const added =
      kind === 'A'
        ? safeRead(join(root, path)).split('\n')
        : git(root, [
            'diff',
            '-U0',
            '-M',
            from,
            '--',
            ...(renamed && first ? [first, path] : [path]),
          ])
            .stdout.split('\n')
            .filter((row) => row.startsWith('+') && !row.startsWith('+++'));
    if (added.some((row) => SKIP_MARK.test(row))) edits.skipped.push(path);
  }
  const untracked = git(root, [
    'ls-files',
    '--others',
    '--exclude-standard',
  ]).stdout.split('\n');
  for (const path of untracked)
    if (
      path &&
      isTestFile(path) &&
      safeRead(join(root, path))
        .split('\n')
        .some((row) => SKIP_MARK.test(row))
    )
      edits.skipped.push(path);
  return edits;
}

/** The refusal for deleted tests and added skips the task text does not name, or undefined. */
export function testTampering(
  edits: TestEdits,
  taskText: string,
): string | undefined {
  const unnamed = (paths: string[]) =>
    paths.filter((path) => !taskText.includes(path));
  const deleted = unnamed(edits.deleted);
  const skipped = unnamed(edits.skipped);
  if (deleted.length === 0 && skipped.length === 0) return undefined;
  const parts = [
    deleted.length > 0 ? `deleted test file(s): ${deleted.join(', ')}` : '',
    skipped.length > 0 ? `added skip/xfail in: ${skipped.join(', ')}` : '',
  ].filter(Boolean);
  return `the branch weakens the tests (${parts.join('; ')}). Restore them and fix the code instead, unless the task Acceptance names them, or end with a line \`BLOCKER: <what stops you>\`.`;
}

/** The task record text of the lane (KRN_TASK), whose Acceptance may name a deleted or skipped test. */
function taskText(root: string, env: NodeJS.ProcessEnv): string {
  const id = env.KRN_TASK;
  return id && /^[\w-]+$/u.test(id)
    ? safeRead(join(root, 'tasks', `${id}.json`))
    : '';
}

/**
 * Failing tests of one run as `<file>::<name>` keys; a run that dies without naming a test yields `<run>::exit <status>`.
 * A runner may also hand back the output that names a missing package or tool.
 */
export type Runner = (
  root: string,
  tests: string[],
) => string[] | CommandResult;
/** A shell command's failing keys together with its full output. */
export type CommandResult = { failures: string[]; output: string };
/** Failing keys of one shell command run at `root`, read from its output; a runner may also hand back that output. */
export type CommandRunner = (
  root: string,
  command: string,
) => string[] | CommandResult;

const failuresOf = (result: string[] | CommandResult): string[] =>
  Array.isArray(result) ? result : result.failures;

const resultOf = (result: string[] | CommandResult): CommandResult =>
  Array.isArray(result) ? { failures: result, output: '' } : result;

const EXCERPT_LINES = 40;
const EXCERPT_CHARS = 4000;

/** The tail of a failing run's output, bounded; the test summary and the failure sit at the end. */
export function failureExcerpt(output: string): string {
  const tail = output.trimEnd().split('\n').slice(-EXCERPT_LINES).join('\n');
  return tail.length > EXCERPT_CHARS
    ? `...${tail.slice(-EXCERPT_CHARS)}`
    : tail;
}

/** Save a failing run's full output under the root's ignored stop-check run directory; undefined when it cannot be written. */
function saveFailureLog(root: string, output: string): string | undefined {
  try {
    const dir = join(root, '.krn', 'runs', 'stop-check');
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `${Date.now()}-${process.pid}.log`);
    writeFileSync(file, output);
    return file;
  } catch {
    return undefined;
  }
}

/** Write one named file under the root's ignored stop-check run directory, replacing the last; undefined when it cannot be written. */
function saveRunLog(
  root: string,
  name: string,
  text: string,
): string | undefined {
  // A root that is gone is never recreated by a log write.
  if (!existsSync(root)) return undefined;
  try {
    const dir = join(root, '.krn', 'runs', 'stop-check');
    mkdirSync(dir, { recursive: true });
    const file = join(dir, name);
    writeFileSync(file, text.endsWith('\n') ? text : `${text}\n`);
    return file;
  } catch {
    return undefined;
  }
}

/** Keep the last Stop refusal text, so a lane and the lead can read why; undefined when it cannot be written. */
export function saveRefusal(root: string, refusal: string): string | undefined {
  return saveRunLog(root, 'last-refusal.txt', refusal);
}

/** The failure key of a check whose test root is gone: it names the directory, never the program. */
const missingRootKey = (root: string): string =>
  `<run>::error test root ${root} does not exist (the worktree was removed or never created)`;

const REPORTER = fileURLToPath(
  new URL('./failure-reporter.mjs', import.meta.url),
);

/** The wait for the host test slot ended at its deadline, so the check ran no tests. */
export class StopSlotTimeout extends Error {
  constructor(cause: SlotTimeoutError) {
    super(`stop check skipped: ${cause.message}`);
    this.name = 'StopSlotTimeout';
  }
}

/**
 * Runs a test process inside the host test slot fast uses, so stops do not stack test processes on fast runs.
 * A run started by fast already holds the slot (SLOT_HELD_ENV) and runs inside it.
 */
export function inStopSlot<T>(
  root: string,
  work: () => T,
  env: NodeJS.ProcessEnv = process.env,
): T {
  if (env[SLOT_HELD_ENV] === '1') return work();
  try {
    return withSlotSync(testSlotOptions(root, env), work);
  } catch (error) {
    if (error instanceof SlotTimeoutError) throw new StopSlotTimeout(error);
    throw error;
  }
}

export const runTests: Runner = (root, tests) =>
  existsSync(root)
    ? inStopSlot(root, () => spawnTests(root, tests))
    : [missingRootKey(root)];

function spawnTests(root: string, tests: string[]): string[] | CommandResult {
  // spawnSync reports a missing cwd as ENOENT on the program, which sends the reader hunting for node.
  if (!existsSync(root)) return [missingRootKey(root)];
  const env = receiverEnv(root);
  const run = spawnSync(
    // The receiver's pinned Node when it pins one, else the Node running this hook.
    env === process.env ? process.execPath : 'node',
    ['--test', `--test-reporter=${REPORTER}`, ...tests],
    {
      cwd: root,
      encoding: 'utf8',
      // Inside a `node --test` parent this variable turns the child into a nested run with no reporter output.
      env: { ...env, NODE_TEST_CONTEXT: undefined },
      stdio: ['ignore', 'pipe', 'ignore'],
      maxBuffer: 64 * 1024 * 1024,
      timeout: 600_000,
    },
  );
  const failed: string[] = [];
  const stderr: string[] = [];
  // A spawn that cannot start (a removed cwd) has no stdout: it fails as one run, never a crash.
  if (run.error) return [`<run>::error ${run.error.message}`];
  for (const line of run.stdout.split('\n')) {
    if (!line.startsWith('{')) continue;
    try {
      const parsed: unknown = JSON.parse(line);
      const said = (parsed as { stderr?: unknown } | null)?.stderr;
      if (typeof said === 'string') {
        stderr.push(said);
        continue;
      }
      const failure = failureLine(parsed);
      if (failure) failed.push(`${failure.file}::${failure.name}`);
    } catch (error) {
      // Runner output mixes JSON failure lines with other text starting with `{`.
      if (!(error instanceof SyntaxError)) throw error;
    }
  }
  if (failed.length === 0 && run.status !== 0)
    failed.push(`<run>::exit ${run.status ?? run.signal}`);
  // Plain keys unless a missing package or tool spoke: then its output rides along for the environment check.
  return stderr.length === 0
    ? failed
    : { failures: failed, output: stderr.join('') };
}

// One failing test per match, by runner: pytest summary, unittest, go, cargo, jest/vitest file lines.
const FAILURE_LINES: readonly RegExp[] = [
  /^(?:FAILED|ERROR) (\S+)/mu,
  /^(?:FAIL|ERROR): \S+ \(([^)]+)\)/mu,
  /^\s*--- FAIL: (\S+)/mu,
  /^FAIL\s+(\S+)\s/mu,
  /^test (\S+) \.\.\. FAILED/mu,
  /^\s*FAIL\s+(\S+)/mu,
];

const MISSING_KEY = '<run>::missing dependency';
const MISSING_DEPENDENCY =
  /Cannot find (?:module|package)|ERR_MODULE_NOT_FOUND|Failed to resolve import|No module named |ModuleNotFoundError|command not found|: not found$/mu;

/** Failing keys in a test command's output; a nonzero exit naming no test is `<run>::exit <status>`. */
export function failuresIn(output: string, status: number | string): string[] {
  const found = new Set<string>();
  for (const line of output.split('\n'))
    for (const pattern of FAILURE_LINES) {
      const match = pattern.exec(line);
      if (match?.[1]) {
        found.add(match[1]);
        break;
      }
    }
  if (found.size === 0 && status !== 0) found.add(`<run>::exit ${status}`);
  if (status !== 0 && MISSING_DEPENDENCY.test(output)) found.add(MISSING_KEY);
  return [...found].sort();
}

const NAMELESS = /^<run>::/u;

const runCommand: CommandRunner = (root, command) =>
  existsSync(root)
    ? inStopSlot(root, () => spawnCommand(root, command))
    : [missingRootKey(root)];

function spawnCommand(
  root: string,
  command: string,
): ReturnType<CommandRunner> {
  if (!existsSync(root)) return [missingRootKey(root)];
  const run = spawnSync('sh', ['-c', `${command} 2>&1`], {
    cwd: root,
    encoding: 'utf8',
    env: { ...receiverEnv(root), NODE_TEST_CONTEXT: undefined },
    stdio: ['ignore', 'pipe', 'ignore'],
    maxBuffer: 64 * 1024 * 1024,
    timeout: 600_000,
  });
  const output = run.stdout ?? '';
  return {
    failures: failuresIn(output, run.status ?? run.signal ?? 'killed'),
    output,
  };
}

/** Link each nested package's node_modules (packages/seo/node_modules) so the base sees the worktree's dependencies. */
export function linkPackageModules(root: string, dir: string, depth = 3) {
  const walk = (rel: string, left: number) => {
    let entries: Dirent[];
    try {
      entries = readdirSync(join(root, rel), { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (
        !entry.isDirectory() ||
        ['.git', '.krn', 'node_modules'].includes(entry.name)
      )
        continue;
      const child = join(rel, entry.name);
      if (existsSync(join(root, child, 'node_modules'))) {
        const target = join(dir, child, 'node_modules');
        try {
          lstatSync(target);
        } catch {
          try {
            mkdirSync(join(dir, child), { recursive: true });
            symlinkSync(join(root, child, 'node_modules'), target);
          } catch (error) {
            // A concurrent run may have created it first; the copy then already has its modules.
            if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
          }
        }
      }
      if (left > 1) walk(child, left - 1);
    }
  };
  walk('', depth);
}

/** The temporary base worktree could not be created: an infrastructure fault, never a test result. */
class BaseWorktreeError extends Error {}

/** Failing keys of `measure` at the base commit, run in a temporary detached worktree that is always removed. */
function failuresAtBase(
  root: string,
  from: string,
  measure: (dir: string) => string[],
  strict = false,
): Set<string> {
  const dir = mkdtempSync(join(tmpdir(), 'worker-stop-base-'));
  try {
    const added = git(root, ['worktree', 'add', '--detach', dir, from]);
    if (added.status !== 0) {
      // Strict callers blame no test for a base they could not even check out.
      if (strict)
        throw new BaseWorktreeError(
          `git worktree add of ${from} failed: ${(added.stderr || added.stdout).trim()}`,
        );
      return new Set();
    }
    // The base may already carry node_modules (a D23 clone commits its symlink); link only when absent.
    const modules = join(dir, 'node_modules');
    let linked = true;
    try {
      lstatSync(modules);
    } catch {
      linked = false;
    }
    if (!linked && existsSync(join(root, 'node_modules')))
      symlinkSync(join(root, 'node_modules'), modules);
    linkPackageModules(root, dir);
    const failed = measure(dir);
    // A base that lacks a module or tool fails for that reason, not for the test: nothing there is pre-existing.
    return new Set(failed.includes(MISSING_KEY) ? [] : failed);
  } finally {
    git(root, ['worktree', 'remove', '--force', dir]);
    rmSync(dir, { recursive: true, force: true });
    git(root, ['worktree', 'prune']);
  }
}

const isDir = (root: string) => (path: string) => {
  try {
    return statSync(join(root, path)).isDirectory();
  } catch {
    return false;
  }
};

/** How this repository's tests run: the node reporter over test files, or a contract shell command. */
interface Plan {
  readonly selection: Selection;
  /** The shell command, or undefined for the node --test reporter. */
  readonly command?: string;
}

function plan(root: string, from: string, contract?: RepoContract): Plan {
  const tests = listTests(root);
  const related = contract?.related?.trim();
  const node =
    related === NODE_RELATED ||
    (related === undefined &&
      [...tests.keys()].some((path) => LEGACY_TEST.test(path)));
  const selection = selectTests(
    changedSinceBase(root, from),
    tests,
    guardOf(contract),
    related?.startsWith('go test ') ?? false,
    isDir(root),
  );
  // A test outside test/ in a repository whose contract names its own runner (vitest in packages/seo) is not a
  // node:test file: it runs through the contract command, never the node reporter.
  const foreign =
    related === undefined &&
    contract !== undefined &&
    selection.files.some((file) => !LEGACY_TEST.test(file));
  if (node && !foreign) {
    if (!selection.full) return { selection };
    // No contract command to fall back to: every node test under test/ is the full run.
    if (!contract)
      return {
        selection: {
          files: [...tests.keys()].filter((p) => LEGACY_TEST.test(p)).sort(),
          full: false,
        },
      };
  }
  // No contract command, or a change that selects nothing (the branch ends equal to its base): nothing runs.
  if (!contract || (!selection.full && selection.files.length === 0))
    return { selection: { files: [], full: false } };
  return {
    selection,
    command: selection.full
      ? contract.test
      : relatedCommand(
          contract,
          withinPackage(contract.related ?? '', selection.files),
        ),
  };
}

/** The tests the change selects, as `--related` prints them. */
export function related(root: string): string[] {
  const { contract } = loadContract(root);
  const from = base(root, contract);
  if (!from) return [];
  const { selection, command } = plan(root, from, contract);
  return selection.full ? [`(full) ${command}`] : [...selection.files];
}

const SHOWN = 10;

/**
 * Whether the branch may stop: a commit past the base and no new test failure. A test failing now that
 * also fails at the base is pre-existing and ignored; `ignored` counts those.
 */
export function inspect(
  root: string,
  run: Runner = runTests,
  shell: CommandRunner = runCommand,
  env: NodeJS.ProcessEnv = process.env,
): Outcome & { ignored: number; modified?: string[] } {
  try {
    return inspectWithin(root, run, shell, env);
  } catch (error) {
    if (!(error instanceof StopSlotTimeout)) throw error;
    // No slot came free: the tests never ran, so the stop is neither passed as proven nor refused as red.
    return { ok: true, ignored: 0, reason: '', slotTimeout: error.message };
  }
}

function inspectWithin(
  root: string,
  run: Runner,
  shell: CommandRunner,
  env: NodeJS.ProcessEnv,
): Outcome & { ignored: number; modified?: string[] } {
  const outcome = inspectTests(root, run, shell, env);
  if (!outcome.ok) return outcome;
  const { contract } = loadContract(root);
  const from = base(root, contract);
  const reason =
    (testFirstOn(env, contract)
      ? testFirstRefusal(root, from, run, shell, contract)
      : undefined) ??
    (clausesOn(env, contract) ||
    (armOn(contract, 'clauses') && briefStatesClauses(env))
      ? clauseRefusal(root, from, run, shell, contract, env)
      : undefined);
  return reason === undefined ? outcome : { ...outcome, ok: false, reason };
}

/** The task body as clauses: the brief text in KRN_TASK_BODY (the body the lane brief and its proof line read), else the record's body (KRN_TASK). */
function taskBody(root: string, env: NodeJS.ProcessEnv): string {
  const fromBrief = env.KRN_TASK_BODY ?? '';
  if (fromBrief.trim() !== '') return fromBrief;
  const raw = taskText(root, env);
  let body = '';
  if (raw !== '')
    try {
      const parsed = JSON.parse(raw) as { body?: unknown };
      body = Array.isArray(parsed.body)
        ? parsed.body.join('\n')
        : typeof parsed.body === 'string'
          ? parsed.body
          : raw;
    } catch {
      body = raw;
    }
  return body;
}

function taskClauses(root: string, env: NodeJS.ProcessEnv): string[] {
  return splitClauses(taskBody(root, env));
}

/** The clause arm follows the red-at-base default: on where the contract has a real test command; KRN_ACCEPTANCE_CLAUSES=0 opts out. */
export function clausesOn(
  env: NodeJS.ProcessEnv,
  contract?: RepoContract,
): boolean {
  if (env.KRN_ACCEPTANCE_CLAUSES === '0') return false;
  if (env.KRN_ACCEPTANCE_CLAUSES === '1') return true;
  return (
    armOn(contract, 'clauses') &&
    contract !== undefined &&
    contract.test.trim() !== '' &&
    contract.vacuous !== true
  );
}

/** A lane brief that states clauses puts the arm on whatever the contract says, unless KRN_ACCEPTANCE_CLAUSES=0. */
function briefStatesClauses(env: NodeJS.ProcessEnv): boolean {
  return (
    env.KRN_ACCEPTANCE_CLAUSES !== '0' &&
    splitClauses(env.KRN_TASK_BODY ?? '').length > 0
  );
}

/** A body with under two clauses makes the worker write its own: this many must end proven. */
const OWN_CLAUSES = 3;

/**
 * Acceptance-clause arm (default on, KRN_ACCEPTANCE_CLAUSES=0 opts out): every numbered clause of
 * the task body has a changed test marked `clause N` that passes on head (red at the base is asked once, by the test-first arm), or
 * a commit message line `Clause N: not reproducible: <reason>`. A body with under two clauses
 * makes the worker write its own: at least three distinct clause numbers, every marked one proven.
 */
function clauseRefusal(
  root: string,
  from: string,
  run: Runner,
  shell: CommandRunner,
  contract: RepoContract | undefined,
  env: NodeJS.ProcessEnv,
): string | undefined {
  const stated = taskClauses(root, env);
  const tests = new Map(
    changedSinceBase(root, from)
      .filter((path) => isTestFile(path) && existsSync(join(root, path)))
      .map((file) => [file, safeRead(join(root, file))]),
  );
  const messages = git(root, ['log', '--format=%B', `${from}..HEAD`]).stdout;
  const marked = markedTests(stated, tests);
  const passes = headPasses(root, marked, run, shell, contract);
  const headFailing = new Set(marked.filter((file) => !passes(file)));
  const { own, clauses } = clauseProof({
    stated,
    tests,
    messages,
    headFailing,
  });
  const uncovered = clauses.flatMap((clause) =>
    clause.proven ? [] : [`clause ${clause.n}: ${clause.text.slice(0, 80)}`],
  );
  if (own && clauses.length < OWN_CLAUSES)
    return `Acceptance-clause rule (KRN_ACCEPTANCE_CLAUSES=0 opts out): the task body states under 2 clauses, so write at least ${OWN_CLAUSES} numbered clauses (edge cases: empty, missing, unauthorised, duplicate submit, non-ASCII) and commit a test per clause whose name contains "clause N" that passes on your commit; ${clauses.length} found. Or end with a line \`BLOCKER: <what stops you>\`.`;
  if (uncovered.length === 0) {
    const missing =
      clauses.length > 0
        ? missingBoundary(clauses, tests, messages)
        : undefined;
    if (missing === undefined) return undefined;
    return `Acceptance-clause rule (KRN_ACCEPTANCE_CLAUSES=0 opts out): no clause covers a boundary case. Add a clause for at least one (for example "empty input") and commit a test marked "clause N" (in its name, body or a comment) that uses one of these words: ${BOUNDARY_WORDS}; or put the word in the clause text or in a commit message line for that clause. Cases: ${missing}. Or end with a line \`BLOCKER: <what stops you>\`.`;
  }
  return `Acceptance-clause rule (KRN_ACCEPTANCE_CLAUSES=0 opts out): ${uncovered.length} of ${clauses.length} clause(s) uncovered (${uncovered.slice(0, SHOWN).join(' | ')}). For each, commit a changed test whose name contains "clause N" that passes on your commit, or add a commit-message line \`Clause N: not reproducible: <reason>\` (a sibling call site: \`Clause N: not affected: <reason>\`), or end with a line \`BLOCKER: <what stops you>\`.`;
}

function testFileRun(
  dir: string,
  file: string,
  run: Runner,
  shell: CommandRunner,
  contract?: RepoContract,
): { failures: string[]; output: string } {
  if (LEGACY_TEST.test(file) || !contract) return resultOf(run(dir, [file]));
  const result = shell(
    dir,
    relatedCommand(contract, withinPackage(contract.related ?? '', [file])),
  );
  return Array.isArray(result)
    ? { failures: result, output: '' }
    : { failures: result.failures, output: result.output };
}

function runTestFile(
  dir: string,
  file: string,
  run: Runner,
  shell: CommandRunner,
  contract?: RepoContract,
): string[] {
  return testFileRun(dir, file, run, shell, contract).failures;
}

/**
 * A run output that names a missing package or tool (a bare specifier or a command), not a missing source file of the repository:
 * the environment lacks its dependencies, so the run says nothing about the test.
 */
const BROKEN_ENVIRONMENT =
  /Cannot find package '[^./]|Cannot find module '[^./]|Failed to resolve import "[^./]|command not found|: not found$|No module named |ModuleNotFoundError/mu;

/** Whether a test run's output shows an environment that lacks its dependencies, not a test that fails. */
const brokenEnvironment = (output: string): boolean =>
  BROKEN_ENVIRONMENT.test(output);

/**
 * Characterization mode: the branch changes only test files (and tracker records), so no source exists
 * for a test to be red against; a test that passes at the base and on head is the proof.
 */
function testsOnlyDiff(root: string, from: string): boolean {
  const changed = changedSinceBase(root, from);
  return (
    changed.some(isTestFile) &&
    changed.every((path) => isTestFile(path) || isTaskPath(path))
  );
}

/** Prose the branch may change without a test: docs/ files, markdown and plain-text files. */
const isDocsPath = (path: string) =>
  path.startsWith('docs/') || /\.(?:md|mdx|txt)$/iu.test(path);

/** A diff of docs and tracker records only: it changes no source or test file, so there is nothing for a test to be red against. */
function docsOnlyDiff(root: string, from: string): boolean {
  const changed = changedSinceBase(root, from);
  return (
    changed.length > 0 &&
    changed.every(
      (path) => !isTestFile(path) && (isDocsPath(path) || isTaskPath(path)),
    )
  );
}

/** The changed test files of the branch that fail against the base source: what the lane proof line counts as red-first. */
export function redTestsAtBase(
  root: string,
  run: Runner = runTests,
  shell: CommandRunner = runCommand,
): string[] {
  const { contract } = loadContract(root);
  const from = base(root, contract);
  const changed = changedSinceBase(root, from).filter(
    (path) => isTestFile(path) && existsSync(join(root, path)),
  );
  return [...redAtBase(root, from, changed, run, shell, contract).red];
}

/** Whether `file` runs only through the contract's full test command: no related command can name it alone. */
function runsSuite(
  file: string,
  contract?: RepoContract,
): contract is RepoContract {
  return (
    contract !== undefined &&
    !LEGACY_TEST.test(file) &&
    relatedCommand(contract, withinPackage(contract.related ?? '', [file])) ===
      contract.test
  );
}

/** The package directory a command runs in (`npm --prefix packages/seo test`), whose runner names files relative to it. */
const packageDir = (command: string): string | undefined =>
  /--prefix[ =]+(\S+)/u.exec(command)?.[1]?.replace(/\/+$/u, '');

/** Whether a failing key names the repository file `file`, as is or relative to the command's package directory. */
function namesFile(key: string, file: string, command: string): boolean {
  const named = keyFile(key);
  if (named === undefined) return false;
  const dir = packageDir(command);
  return named === file || (dir !== undefined && `${dir}/${named}` === file);
}

/** One run of the full test command at `dir`, with the files among `files` it names failing. */
interface SuiteRun extends CommandResult {
  readonly failing: Set<string>;
}

/**
 * The full test command run once for all of `files`: a file fails only when a failing key names it, and only when
 * one rerun of the named tests fails it again, so a flaky or load-timed failure elsewhere in the suite blames no file.
 */
function suiteRun(
  dir: string,
  files: readonly string[],
  shell: CommandRunner,
  contract: RepoContract,
): SuiteRun {
  const command = contract.test;
  const first = resultOf(shell(dir, command));
  const named = (failures: readonly string[]) =>
    files.filter((file) =>
      failures.some((key) => namesFile(key, file, command)),
    );
  const blamed = named(first.failures);
  if (blamed.length === 0) return { ...first, failing: new Set() };
  const keys = [
    ...new Set(
      first.failures
        .filter((key) => blamed.some((file) => namesFile(key, file, command)))
        .map(keyFile)
        .filter((file): file is string => file !== undefined),
    ),
  ];
  const again = failuresOf(shell(dir, rerunCommand(command, keys)));
  return {
    ...first,
    failing: new Set(named(again).filter((file) => blamed.includes(file))),
  };
}

/** Whether a changed test passes on head; files that only the full suite runs share one suite run. */
function headPasses(
  root: string,
  files: readonly string[],
  run: Runner,
  shell: CommandRunner,
  contract?: RepoContract,
): (file: string) => boolean {
  let suite: SuiteRun | undefined;
  return (file) => {
    if (!runsSuite(file, contract))
      return runTestFile(root, file, run, shell, contract).length === 0;
    suite ??= suiteRun(
      root,
      files.filter((path) => runsSuite(path, contract)),
      shell,
      contract,
    );
    return !suite.failing.has(file);
  };
}

/** The changed test files that fail against the base source, and the base runs that broke on the environment instead (file to output). */
interface BaseRuns {
  readonly red: Set<string>;
  readonly broken: Map<string, string>;
}

/** The files among `changed` that fail against the base source, run with the head file in place in a detached worktree. */
function redAtBase(
  root: string,
  from: string,
  changed: string[],
  run: Runner,
  shell: CommandRunner,
  contract?: RepoContract,
): BaseRuns {
  const red = new Set<string>();
  const broken = new Map<string, string>();
  const outputs: string[] = [];
  // With no related command every changed file would rerun the whole suite: run it once and blame only named files.
  const suite = changed.filter((file) => runsSuite(file, contract));
  if (changed.length > 0)
    failuresAtBase(
      root,
      from,
      (dir) => {
        for (const file of changed) {
          mkdirSync(dirname(join(dir, file)), { recursive: true });
          copyFileSync(join(root, file), join(dir, file));
        }
        if (suite.length > 0 && contract !== undefined) {
          const base = suiteRun(dir, suite, shell, contract);
          if (base.output !== '')
            outputs.push(
              `== ${contract.test} at the base (${suite.join(', ')}) ==\n${base.output}`,
            );
          if (base.failures.length > 0 && brokenEnvironment(base.output))
            for (const file of suite) broken.set(file, base.output);
          else for (const file of base.failing) red.add(file);
        }
        for (const file of changed) {
          if (suite.includes(file)) continue;
          const base = testFileRun(dir, file, run, shell, contract);
          if (base.output !== '')
            outputs.push(`== ${file} at the base ==\n${base.output}`);
          if (base.failures.length === 0) continue;
          if (brokenEnvironment(base.output)) broken.set(file, base.output);
          else red.add(file);
        }
        return [];
      },
      true,
    );
  if (outputs.length > 0) saveRunLog(root, 'base-run.log', outputs.join('\n'));
  return { red, broken };
}

/** The red-at-base arm is on by default where the contract has a real test command; KRN_TEST_FIRST=0 opts out. */
export function testFirstOn(
  env: NodeJS.ProcessEnv,
  contract?: RepoContract,
): boolean {
  if (env.KRN_TEST_FIRST === '0') return false;
  if (env.KRN_TEST_FIRST === '1') return true;
  return (
    armOn(contract, 'red-first') &&
    contract !== undefined &&
    contract.test.trim() !== '' &&
    contract.vacuous !== true
  );
}

/**
 * Test-first arm (default on, KRN_TEST_FIRST=0 opts out): at least one changed test file must fail against the base source
 * with the head test file in place, and pass on head. The base run happens in a detached worktree.
 */
function testFirstRefusal(
  root: string,
  from: string,
  run: Runner,
  shell: CommandRunner,
  contract?: RepoContract,
): string | undefined {
  const rule =
    'Test-first rule (KRN_TEST_FIRST=0 opts out): a changed test must fail against the base source and pass on your commit, and no red-at-base proof was found.';
  if (docsOnlyDiff(root, from)) return undefined;
  const changed = changedSinceBase(root, from).filter(
    (path) => isTestFile(path) && existsSync(join(root, path)),
  );
  let base: BaseRuns;
  try {
    base = redAtBase(root, from, changed, run, shell, contract);
  } catch (error) {
    if (!(error instanceof BaseWorktreeError)) throw error;
    return `Test-first check could not run: ${error.message}. This is a repository or host fault, not a missing red test; free disk space, run \`git worktree prune\`, then stop again, or end with a line \`BLOCKER: <what stops you>\`.`;
  }
  const { red, broken } = base;
  const characterization = testsOnlyDiff(root, from);
  const characterizing = new Set(
    characterizingTests(
      git(root, ['log', '--format=%B', `${from}..HEAD`]).stdout,
      new Map(changed.map((file) => [file, safeRead(join(root, file))])),
    ),
  );
  const candidates = changed.filter(
    (file) => characterization || characterizing.has(file) || red.has(file),
  );
  const passes = headPasses(root, candidates, run, shell, contract);
  const proven = candidates.find(passes);
  if (proven !== undefined) return undefined;
  if (broken.size > 0) {
    const logged = saveRunLog(
      root,
      'base-environment.log',
      [...broken]
        .map(([file, output]) => `== ${file} ==\n${output}`)
        .join('\n'),
    );
    const install = contract?.install
      ? `run the install the repo contract names (${contract.install})`
      : 'install the dependencies';
    return `Test-first check could not run: the base environment is broken, not a test red (a package or tool is missing in the temporary base worktree: ${[...broken.keys()].slice(0, SHOWN).join(', ')}${logged ? `; base output: ${logged}` : ''}). ${install}, so the base worktree can link its modules, then commit, or end with a line \`BLOCKER: <what stops you>\`.`;
  }
  const why =
    changed.length === 0
      ? 'no test file changed on this branch'
      : red.size === 0
        ? `no changed test fails at the base (${changed.slice(0, SHOWN).join(', ')})`
        : `the tests that fail at the base do not pass on your commit (${[...red].slice(0, SHOWN).join(', ')})`;
  return `${rule} ${why}. Commit a test that is red at the base and green on your fix, or end with a line \`BLOCKER: <what stops you>\`.`;
}

function inspectTests(
  root: string,
  run: Runner,
  shell: CommandRunner,
  env: NodeJS.ProcessEnv,
): Outcome & { ignored: number; modified?: string[] } {
  if (!existsSync(root))
    return {
      ok: false,
      ignored: 0,
      reason: `the test root ${root} does not exist (the worktree was removed or never created), so no test can run there. Run from an existing checkout, or end with a line \`BLOCKER: <what stops you>\`.`,
    };
  const { contract, error } = loadContract(root);
  if (error)
    return {
      ok: false,
      ignored: 0,
      reason: `the repo contract is invalid (${error}). Fix krn.json and commit, or end with a line \`BLOCKER: <what stops you>\`.`,
    };
  if (contract?.vacuous)
    return {
      ok: false,
      ignored: 0,
      reason: `the repo contract marks the test command vacuous (${contract.test} runs no real test), so green proves nothing. Add one real test and a test command that runs it (krn.json "test", drop "vacuous"), commit, or end with a line \`BLOCKER: <what stops you>\`.`,
    };
  const from = base(root, contract);
  const named = contract?.base ?? 'main';
  if (!from)
    return {
      ok: false,
      ignored: 0,
      reason: `no base resolves (neither origin/${named} nor ${named} exists here), so the branch cannot be checked. Point a \`${named}\` branch at the base commit and commit your change, or end with a line \`BLOCKER: <what stops you>\`.`,
    };
  const ahead = git(root, ['rev-list', '--count', `${from}..HEAD`]).stdout;
  if (Number(ahead.trim()) === 0)
    return {
      ok: false,
      ignored: 0,
      reason: `there is no commit on this branch yet. Commit your change (run \`${contract?.fast ?? contract?.test ?? 'node --test'}\` first), or end with a line \`BLOCKER: <what stops you>\`.`,
    };
  const edits = testEdits(root, from);
  const tampering = testTampering(edits, taskText(root, env));
  if (tampering) return { ok: false, ignored: 0, reason: tampering };
  const { selection, command } = plan(root, from, contract);
  const files = [...selection.files];
  let failing: string[];
  let before: () => Set<string>;
  let headOutput: string | undefined;
  if (command === undefined) {
    failing = files.length > 0 ? failuresOf(run(root, files)) : [];
    before = () => {
      const named = [...new Set(failing.map((key) => key.split('::')[0]))];
      const present = named.filter(
        (file) =>
          file !== undefined &&
          git(root, ['cat-file', '-e', `${from}:${file}`]).status === 0,
      ) as string[];
      return present.length === 0
        ? new Set()
        : failuresAtBase(root, from, (dir) => failuresOf(run(dir, present)));
    };
  } else {
    const first = shell(root, command);
    failing = failuresOf(first);
    if (!Array.isArray(first)) headOutput = first.output;
    before = () =>
      failuresAtBase(root, from, (dir) => failuresOf(shell(dir, command)));
  }
  // The adopt canary measured the base green once: its failures are all fresh, so the base is not run again.
  if (env.KRN_BASE_GREEN === '1') before = () => new Set();
  let flaky: string[] = [];
  if (failing.length > 0) {
    const settled = settleFailures(
      failing,
      (named) => {
        if (command === undefined) return failuresOf(run(root, named));
        const again = shell(
          root,
          selection.full || contract === undefined
            ? rerunCommand(command, named)
            : relatedCommand(
                contract,
                withinPackage(contract.related ?? '', named),
              ),
        );
        if (!Array.isArray(again)) headOutput = again.output;
        return failuresOf(again);
      },
      (file) =>
        command === undefined ||
        existsSync(join(root, file)) ||
        // A package runner names its files relative to the package (`npm --prefix packages/seo test`).
        existsSync(join(root, packageDir(command) ?? '', file)),
    );
    failing = settled.failing;
    flaky = settled.flaky;
  }
  if (failing.length === 0)
    return {
      ok: true,
      reason: '',
      ignored: 0,
      ...(flaky.length > 0 ? { flaky } : {}),
      ...(edits.modified.length > 0 ? { modified: edits.modified } : {}),
    };
  // A missing runner fails the same way at the base, so it would pass as pre-existing: refuse it instead.
  const missing = failing.find((key) => /^<run>::exit 12[67]$/u.test(key));
  if (missing)
    return {
      ok: false,
      ignored: 0,
      reason: `the test command could not start (${missing.slice(7)}: command not found or not executable)${command === undefined ? '' : `: ${command}`}. Install the runner the repo contract names or fix krn.json, or end with a line \`BLOCKER: <what stops you>\`.`,
    };
  const earlier = before();
  // A failure naming no test cannot be matched to the base, so it is never pre-existing.
  const fresh = failing.filter(
    (key) => NAMELESS.test(key) || !earlier.has(key),
  );
  if (fresh.length === 0)
    return { ok: true, reason: '', ignored: failing.length };
  const listed = fresh
    .slice(0, SHOWN)
    .map((key) => `  ${key.replace('::', ' :: ')}`)
    .join('\n');
  const more =
    fresh.length > SHOWN ? `\n  ... ${fresh.length - SHOWN} more` : '';
  const ran = ` (ran: ${command ?? `node --test ${files.join(' ')}`})`;
  const logged = headOutput ? saveFailureLog(root, headOutput) : undefined;
  const output =
    headOutput && logged
      ? `\nFailure output (full log: ${logged}):\n${failureExcerpt(headOutput)}`
      : '';
  // No test was named: the run broke before any test, so nothing can have "passed at the base".
  if (fresh.every((key) => NAMELESS.test(key))) {
    const install = contract?.install
      ? `run the install the repo contract names (${contract.install})`
      : 'install the dependencies (krn.json "install" names the command lane worktrees run)';
    const why = fresh.includes(MISSING_KEY)
      ? `a module or tool is missing, so ${install} or fix the import`
      : 'read its output';
    return {
      ok: false,
      ignored: failing.length - fresh.length,
      reason: `the test command failed before naming any test (${fresh.map((key) => key.slice(7)).join(', ')})${ran}:${output}\n${why}, then commit, or end with a line \`BLOCKER: <what stops you>\`.`,
    };
  }
  return {
    ok: false,
    ignored: failing.length - fresh.length,
    reason: `${fresh.length} related test(s) fail that passed at the base (pre-existing failures were ignored)${ran}:\n${listed}${more}${output}\nFix them and commit, or end with a line \`BLOCKER: <what stops you>\`.`,
  };
}

/**
 * A lane whose ship merged has no branch left: ship removed its worktree, so the payload cwd is the
 * main checkout on the base. Its last message names the merge (`verdict: merged <sha>`); the end is
 * accepted when that commit is on the base. The main checkout may not have fetched the merge yet
 * (t-0bct43k, debf26c), so a miss fetches the base once and checks again. The line may sit in a
 * list bullet, a quote or backticks (t-310mwdm: lanes pasted it quoted and were refused).
 */
export function shippedMerge(root: string, message: unknown): boolean {
  if (typeof message !== 'string') return false;
  const sha = /^[\s>*`-]*verdict: merged ([0-9a-f]{7,40})\b/mu.exec(
    message,
  )?.[1];
  return sha !== undefined && onBase(root, sha);
}

/** The head branch of a pull request, or undefined when gh cannot say (a check that cannot look never blocks). */
export function prHeadBranch(root: string, pr: number): string | undefined {
  const viewed = ghApiSync(root, `repos/{owner}/{repo}/pulls/${pr}`);
  if (viewed.status !== 0) return undefined;
  try {
    const head = (JSON.parse(viewed.stdout) as { head?: { ref?: unknown } })
      .head?.ref;
    return typeof head === 'string' && head !== '' ? head : undefined;
  } catch {
    return undefined;
  }
}

/**
 * A lane reports its own PR only (t-rajd6vr: a lane ended "#1183 merged 5858a69", another lane's PR, while
 * its own #1186 was open). Every `#<n>` on a line of the final message that says merged or carries `pr:` is
 * looked up; a PR whose head branch is not one of the lane's branches is refused, naming both.
 */
export function foreignPr(
  message: unknown,
  own: readonly string[],
  headOf: (pr: number) => string | undefined,
): string | undefined {
  if (typeof message !== 'string' || own.length === 0) return undefined;
  for (const line of message.split('\n')) {
    if (!/\bmerged\b|^[\s>*`-]*pr:/iu.test(line)) continue;
    for (const match of line.matchAll(/#(\d{1,7})\b/gu)) {
      const pr = Number(match[1]);
      const head = headOf(pr);
      if (head !== undefined && !own.includes(head))
        return `Stop refused: your report names PR #${pr}, whose head branch is ${head}, not your lane branch ${own[0]}. Report only the PR your own branch carries (\`gh pr list --head ${own[0]}\`) and the verdict line from your own \`krn pr ship\` output or a log under your worktree, or end with a line \`BLOCKER: <what stops you>\`.`;
    }
  }
  return undefined;
}

function onBase(root: string, sha: string): boolean {
  const named = loadContract(root).contract?.base ?? 'main';
  const merged = () =>
    [`origin/${named}`, named].some(
      (ref) =>
        git(root, ['merge-base', '--is-ancestor', sha, ref]).status === 0,
    );
  if (merged()) return true;
  const fetched = spawnSync('git', ['fetch', '-q', 'origin', named], {
    cwd: root,
    encoding: 'utf8',
    timeout: 30_000,
  });
  return fetched.status === 0 && merged();
}

const laneMarker = `${sep}.krn${sep}worktrees${sep}`;

/**
 * The lane worktree a path lies in, as `<owner>/.krn/worktrees/<name>`. An existing path belongs to its nearest
 * enclosing checkout only: a repository created under another lane's `.krn/tmp` (a test temp dir) is its own main.
 * A path that is gone is a lane tree only when it is exactly `<owner>/.krn/worktrees/<name>`.
 */
export function laneTreeOf(
  path: string,
): { owner: string; name: string } | undefined {
  let top = path;
  if (existsSync(path)) {
    while (!existsSync(join(top, '.git'))) {
      const up = dirname(top);
      if (up === top) return undefined;
      top = up;
    }
    if (!statSync(join(top, '.git')).isFile()) return undefined;
  }
  const at = top.lastIndexOf(laneMarker);
  if (at < 0) return undefined;
  const rest = top.slice(at + laneMarker.length).split(sep);
  const name = rest[0];
  if (!existsSync(path) && rest.length !== 1) return undefined;
  return name ? { owner: top.slice(0, at), name } : undefined;
}

/**
 * Where `krn pr ship` recorded a merged ship for this session's lane, whose branch and worktree it then
 * removed. The last message need not repeat the verdict: lanes ended "the branch was deleted after merge"
 * and were refused. The record counts when its merge commit is on the base and the hook runs in a removed
 * worktree, the main checkout, or a kept lane worktree whose branch and tip are the recorded ones. It is
 * found by branch, worktree directory name or the session's KRN_TASK.
 */
export function recordedShip(
  root: string,
  env: NodeJS.ProcessEnv,
  branch = '',
  payload: unknown = undefined,
): boolean {
  const named = loadContract(root).contract?.base ?? 'main';
  const current = branch.trim();
  // On a lane branch the record counts only for a kept worktree whose tip is still the shipped head:
  // a lane agent's ship keeps worktree and branch for the next lane start to prune (t-hswt15n).
  const onLane = current !== '' && current !== named;
  let main: string | undefined;
  if (existsSync(root)) {
    const common = git(root, [
      'rev-parse',
      '--path-format=absolute',
      '--git-common-dir',
    ]);
    if (common.status === 0) main = dirname(common.stdout);
  }
  const tree = laneTreeOf(root);
  if (main === undefined && tree) main = tree.owner;
  if (main === undefined) return false;
  const lane = tree?.name ?? '';
  // A lane worktree still on disk counts only while its tip is the shipped head: later work there is unshipped.
  const kept = lane !== '' && existsSync(join(root, '.git'));
  const tip =
    kept || onLane ? git(root, ['rev-parse', 'HEAD']).stdout.trim() : '';
  const dir = join(main, shipRecordDir);
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return false;
  }
  const claimed = claimedBranches(main, env, payload);
  for (const name of names) {
    try {
      const record = JSON.parse(readFileSync(join(dir, name), 'utf8')) as {
        branch?: unknown;
        task?: unknown;
        sha?: unknown;
        head?: unknown;
      };
      if (onLane && record.branch !== current) continue;
      const ours =
        (lane !== '' && record.branch === lane) ||
        (typeof record.branch === 'string' &&
          claimed.includes(record.branch)) ||
        (env.KRN_TASK !== undefined && record.task === env.KRN_TASK);
      if (
        ours &&
        typeof record.sha === 'string' &&
        laneMergeVerdict({
          record: {
            sha: record.sha,
            ...(typeof record.head === 'string' ? { head: record.head } : {}),
          },
          head: kept || onLane ? tip : undefined,
          merged: (sha) => onBase(main, sha),
        }) === 'merged'
      )
        return true;
    } catch {
      /* An unreadable record proves nothing. */
    }
  }
  return false;
}

/** The blocking standards of a repository on a date (YYYY-MM-DD), one line each. */
/** The record id a blocker line starts with (`<id> (<tier>): ...`). */
const standardKey = (line: string): string => line.split(' (')[0] ?? line;

export type StandardsRunner = (root: string, asOf: string) => string[];

/**
 * Logs the session's records to the exposure log: each refused record is violated, each other
 * record the session was served gets its own check result on the final tree (null when it has none).
 * The log is evidence, never a reason to fail a Stop.
 */
function logChecks(
  root: string,
  payload: unknown,
  blockers: readonly string[],
  env: NodeJS.ProcessEnv,
): void {
  try {
    const refused = blockers.flatMap(
      (line) => /^(\S+) \(/u.exec(line)?.[1] ?? [],
    );
    const session = (payload as { session_id?: unknown } | null)?.session_id;
    const run = typeof session === 'string' ? session : 'stop';
    const main = dirname(
      resolve(root, git(root, ['rev-parse', '--git-common-dir']).stdout),
    );
    const seen = new Set(refused);
    const earlier = readExposures(main).filter(
      (row) => row.run === run && row.channel !== 'stop',
    );
    const rest = [...new Set(earlier.flatMap((row) => row.served))].filter(
      (id) => !seen.has(id),
    );
    const withheld = [
      ...new Set(earlier.flatMap((row) => row.withheld)),
    ].filter((id) => !seen.has(id) && !rest.includes(id));
    if (refused.length === 0 && rest.length === 0) return;
    const exposure = exposureOf({
      run,
      task: sessionTaskIds(env, payload)[0],
      channel: 'stop',
      served: rest,
      withheld,
      refused,
      laneOk: refused.length === 0,
      violated: {
        ...recordChecks(root, rest),
        ...Object.fromEntries(refused.map((id) => [id, true])),
      },
    });
    appendExposure(main, exposure);
  } catch {
    /* Evidence only. */
  }
}

/**
 * Whether a subagent's own transcript shows no edit and no lane claim: it only read, so the commit
 * requirement has nothing to check and refusing its end would lose its report. An unreadable or
 * missing transcript is not read-only.
 */
export function readOnlySession(payload: unknown): boolean {
  const path = (payload as { agent_transcript_path?: unknown } | null)
    ?.agent_transcript_path;
  if (typeof path !== 'string') return false;
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return false;
  }
  const claims =
    /\bkrn lane start\b|\bkrn task claim\b|\bgit (?:commit|add|push)\b|\bkrn pr (?:ship|body)\b|\.krn\/task-claims\//u;
  for (const line of text.split('\n')) {
    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    // A bare `input` naming a file is a recorded file write of an unnamed tool.
    const bare = (entry as { input?: { file_path?: unknown } } | null)?.input;
    if (typeof bare?.file_path === 'string') return false;
    const content = (entry as { message?: { content?: unknown } } | null)
      ?.message?.content;
    if (!Array.isArray(content)) continue;
    for (const part of content as {
      type?: unknown;
      name?: unknown;
      input?: { command?: unknown };
    }[]) {
      if (part?.type !== 'tool_use') continue;
      if (
        typeof part.name === 'string' &&
        /^(?:Edit|Write|MultiEdit|NotebookEdit)$/u.test(part.name)
      )
        return false;
      const command = part.input?.command;
      if (typeof command === 'string' && claims.test(command)) return false;
    }
  }
  return true;
}

/**
 * A lane brief that marks itself non-delivery (a line `Delivery: none` in the first user message of the
 * agent's own transcript, or KRN_DELIVERY=none) produces a report, not a commit: its end needs no commit,
 * PR or test run. Only the brief itself counts; later tool output and pages the agent read never do.
 */
export function nonDeliveryBrief(
  env: NodeJS.ProcessEnv,
  payload: unknown,
): boolean {
  if (env.KRN_DELIVERY === 'none') return true;
  const path = (payload as { agent_transcript_path?: unknown } | null)
    ?.agent_transcript_path;
  if (typeof path !== 'string') return false;
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return false;
  }
  for (const line of text.split('\n')) {
    let entry: {
      type?: unknown;
      message?: { role?: unknown; content?: unknown };
    };
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (entry?.type !== 'user' && entry?.message?.role !== 'user') continue;
    const content = entry.message?.content;
    const brief = Array.isArray(content)
      ? content
          .map((part: { text?: unknown }) =>
            typeof part?.text === 'string' ? part.text : '',
          )
          .join('\n')
      : typeof content === 'string'
        ? content
        : '';
    return /^[\s>*`-]*Delivery:\s*none\b/imu.test(brief);
  }
  return false;
}

/**
 * Whether the lane named by a removed worktree directory has a merged pull request on the base. A squash
 * merge leaves the branch tip no ancestor of the base and `krn pr ship` deletes the branch, so the merged
 * pull request of the head branch is the evidence. Only a worktree that is gone is judged here; a live one
 * is judged on its own commits.
 */
export function mergedLaneBranch(
  root: string,
  lane: string,
  mergedPr: (root: string, branch: string) => boolean = ghMergedPr,
): boolean {
  return lane !== '' && mergedPr(root, lane);
}

function ghMergedPr(root: string, branch: string): boolean {
  const listed = ghApiSync(
    root,
    `repos/{owner}/{repo}/pulls?state=closed&head={owner}:${encodeURIComponent(branch)}&per_page=5`,
  );
  if (listed.status !== 0) return false;
  try {
    return (JSON.parse(listed.stdout) as { merged_at?: unknown }[]).some(
      (pr) => typeof pr.merged_at === 'string',
    );
  } catch {
    return false;
  }
}

/**
 * A krn-lane subagent shares the lead's session cwd, so the payload cwd may sit in the lead's worktree
 * or the main checkout. Its own worktree is the one under `<main>/.krn/worktrees` that its transcript last
 * edited a file in, else the worktree of the first live task claim its transcript names.
 * Returns the payload cwd when the transcript shows neither.
 */
export function laneWorktree(
  cwd: string,
  payload: unknown,
  projectDir?: string,
): string {
  const path = (payload as { agent_transcript_path?: unknown } | null)
    ?.agent_transcript_path;
  if (typeof path !== 'string') return cwd;
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return cwd;
  }
  // The session cwd may sit in another repository (the lead cd-ed away); the project dir names the lane's.
  for (const dir of [cwd, projectDir]) {
    if (dir === undefined || !existsSync(dir)) continue;
    const common = git(dir, [
      'rev-parse',
      '--path-format=absolute',
      '--git-common-dir',
    ]);
    if (common.status !== 0) continue;
    const found = laneWorktreeIn(dirname(common.stdout), text);
    if (found !== undefined) return found;
  }
  return cwd;
}

/** The claim of a task unless the claim reader (src/task) finds it expired; a file it cannot fully parse still names its lane. */
function heldClaim(main: string, id: string): Partial<TaskClaim> | undefined {
  const inspected = inspectClaim(main, id);
  return inspected.state === 'expired' ? undefined : inspected.claim;
}

function laneWorktreeIn(main: string, text: string): string | undefined {
  const marker = join(main, '.krn', 'worktrees') + sep;
  const escaped = marker.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  const edited = [
    ...text.matchAll(
      new RegExp(
        `"(?:file_path|notebook_path)"\\s*:\\s*"${escaped}([^/"]+)`,
        'gu',
      ),
    ),
  ].at(-1)?.[1];
  if (edited !== undefined && existsSync(join(marker, edited)))
    return join(marker, edited);
  for (const id of text.match(/(?<![a-z0-9])t-[a-z0-9]{7}(?![a-z0-9])/gu) ??
    []) {
    try {
      const claim = heldClaim(main, id);
      if (typeof claim?.worktree === 'string' && existsSync(claim.worktree))
        return claim.worktree;
    } catch {
      /* No claim for this id. */
    }
  }
  return undefined;
}

/**
 * `krn pr ship` removes a merged lane's worktree, so a lane may stop with its cwd gone (t-vs35jd7, #1137:
 * Stop crashed spawning tests there). A missing `<main>/.krn/worktrees/<name>` is judged at `<main>`.
 */
export function ownerCheckout(root: string): string {
  if (existsSync(root)) return root;
  const owner = laneTreeOf(root)?.owner;
  return owner !== undefined && existsSync(owner) ? owner : root;
}

/** The task ids a session names: KRN_TASK and the ids in its transcript (a lane subagent's own transcript first). */
function sessionTaskIds(env: NodeJS.ProcessEnv, payload: unknown): string[] {
  const ids = new Set<string>();
  if (env.KRN_TASK) ids.add(env.KRN_TASK);
  const fields = payload as {
    transcript_path?: unknown;
    agent_transcript_path?: unknown;
  } | null;
  // A lane subagent's own transcript names its tasks; the lead's transcript names every lane's.
  const own = fields?.agent_transcript_path;
  for (const path of typeof own === 'string'
    ? [own]
    : [fields?.transcript_path]) {
    if (typeof path !== 'string') continue;
    try {
      for (const id of readFileSync(path, 'utf8').match(
        /(?<![a-z0-9])t-[a-z0-9]{7}(?![a-z0-9])/gu,
      ) ?? [])
        ids.add(id);
    } catch {
      /* No transcript to read. */
    }
  }
  return [...ids];
}

/** What the repository recorded about a lane a session started: a live claim, or the ship record of a released one. */
export type LaneRecord = { branch: string; worktree?: string; sha?: string };

/**
 * The one resolution of "which branch and worktree is this session's lane": the live task claims and the
 * ship records (once the claim is released) of the task ids the session names, found from the main checkout.
 */
export function laneRecords(
  root: string,
  env: NodeJS.ProcessEnv,
  payload: unknown,
): LaneRecord[] {
  const common = git(root, [
    'rev-parse',
    '--path-format=absolute',
    '--git-common-dir',
  ]);
  if (common.status !== 0) return [];
  const main = dirname(common.stdout);
  const ids = sessionTaskIds(env, payload);
  const records: LaneRecord[] = [];
  for (const id of ids) {
    try {
      const claim = heldClaim(main, id);
      if (typeof claim?.branch === 'string' && claim.branch !== '')
        records.push({
          branch: claim.branch,
          ...(typeof claim.worktree === 'string' && claim.worktree !== ''
            ? { worktree: claim.worktree }
            : {}),
        });
    } catch {
      /* No claim for this id. */
    }
  }
  const dir = join(main, shipRecordDir);
  let names: string[] = [];
  try {
    names = readdirSync(dir);
  } catch {
    /* No ship records. */
  }
  for (const name of names) {
    try {
      const record = JSON.parse(readFileSync(join(dir, name), 'utf8')) as {
        branch?: unknown;
        task?: unknown;
        sha?: unknown;
      };
      if (
        typeof record.branch === 'string' &&
        record.branch !== '' &&
        typeof record.task === 'string' &&
        ids.includes(record.task)
      )
        records.push({
          branch: record.branch,
          ...(typeof record.sha === 'string' ? { sha: record.sha } : {}),
        });
    } catch {
      /* An unreadable record proves nothing. */
    }
  }
  return records;
}

/** The branches of the lanes a session started, claimed or shipped. */
export function claimedBranches(
  root: string,
  env: NodeJS.ProcessEnv,
  payload: unknown,
): string[] {
  return [...new Set(laneRecords(root, env, payload).map((r) => r.branch))];
}

/** The worktrees under `<main>/.krn/worktrees` that a lane subagent's transcript edited a file in. */
function editedWorktrees(cwd: string, payload: unknown): string[] {
  const path = (payload as { agent_transcript_path?: unknown } | null)
    ?.agent_transcript_path;
  if (typeof path !== 'string') return [];
  const common = git(cwd, [
    'rev-parse',
    '--path-format=absolute',
    '--git-common-dir',
  ]);
  if (common.status !== 0) return [];
  const marker = join(dirname(common.stdout), '.krn', 'worktrees') + sep;
  const escaped = marker.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  try {
    const names = [
      ...readFileSync(path, 'utf8').matchAll(
        new RegExp(
          `"(?:file_path|notebook_path)"\\s*:\\s*"${escaped}([^/"]+)`,
          'gu',
        ),
      ),
    ].map((match) => match[1] as string);
    return [...new Set(names)]
      .filter((name) => existsSync(join(marker, name)))
      .map((name) => join(marker, name));
  } catch {
    return [];
  }
}

/**
 * Every branch a session's report may name as its own. A lane subagent shares the lead's cwd, so its
 * evidence is its claims, ship records and the worktrees its transcript edited; the cwd names count only
 * when that evidence is empty, so a report is never judged against the lead's or another lane's branch.
 */
export function ownBranches(
  root: string,
  env: NodeJS.ProcessEnv,
  payload: unknown,
  cwdNames: readonly string[],
  subagent: boolean,
): string[] {
  const evidence = [
    ...claimedBranches(root, env, payload),
    ...(subagent
      ? editedWorktrees(root, payload).map((tree) => {
          const at = git(tree, ['branch', '--show-current']).stdout.trim();
          return at !== '' ? at : (tree.split(sep).at(-1) as string);
        })
      : []),
  ];
  const names =
    subagent && evidence.length > 0 ? evidence : [...evidence, ...cwdNames];
  return [...new Set(names.filter((name) => name !== ''))];
}

/**
 * A shell that returned to the main checkout (the cwd resets after each Bash call) is judged at the worktree
 * of the lane claim the session holds; a session already inside a lane worktree keeps its own.
 */
export function claimedWorktree(
  start: string,
  env: NodeJS.ProcessEnv,
  payload: unknown,
): string {
  if (laneTreeOf(start) || !existsSync(start)) return start;
  const tree = laneRecords(start, env, payload).find(
    (record) => record.worktree !== undefined && existsSync(record.worktree),
  )?.worktree;
  return tree ?? start;
}

/**
 * The checkout a Stop is judged in: the lane worktree of a krn-lane subagent (it shares the lead's
 * CLAUDE_PROJECT_DIR, its own checkout is the payload cwd), else the project dir, then the worktree of
 * a lane claim; a removed lane worktree is judged at its main checkout. judgeStop and stopHook both use it.
 */
export function stopCheckout(
  payload: unknown,
  env: NodeJS.ProcessEnv,
): { start: string; root: string } {
  const fields = payload as { cwd?: unknown } | null;
  const subagent = isLaneSubagent(payload) && typeof fields?.cwd === 'string';
  const sessionDir = resolve(
    subagent
      ? laneWorktree(fields?.cwd as string, payload, env.CLAUDE_PROJECT_DIR)
      : (env.CLAUDE_PROJECT_DIR ??
          (typeof fields?.cwd === 'string' ? fields.cwd : process.cwd())),
  );
  const start = claimedWorktree(sessionDir, env, payload);
  return { start, root: ownerCheckout(start) };
}

/** The refusal reason for a Stop payload, or undefined when the session may end. */
export function judgeStop(
  payload: unknown,
  env: NodeJS.ProcessEnv = process.env,
  run: Runner = runTests,
  branch = '',
  shell: CommandRunner = runCommand,
  standards: StandardsRunner = standardsBlockers,
  outcomeJudge: JudgeCall = claudeJudge,
  headOf: (root: string, pr: number) => string | undefined = prHeadBranch,
  mergedPrOf: (root: string, branch: string) => boolean = ghMergedPr,
): string | undefined {
  const fields = payload as {
    cwd?: unknown;
    last_assistant_message?: unknown;
    stop_hook_active?: unknown;
  } | null;
  const subagent = isLaneSubagent(payload) && typeof fields?.cwd === 'string';
  const { start, root } = stopCheckout(payload, env);
  const who = worker(env, root, branch, payload);
  if (!who) return undefined;
  if (nonDeliveryBrief(env, payload)) return undefined;
  if (subagent && readOnlySession(payload)) return undefined;
  if (who.unidentified) return `Stop refused: ${UNIDENTIFIED_LANE}`;
  if (statesBlocker(fields?.last_assistant_message)) return undefined;
  const lane = laneTreeOf(start)?.name;
  const current = existsSync(start)
    ? git(start, ['branch', '--show-current']).stdout.trim()
    : '';
  const foreign = foreignPr(
    fields?.last_assistant_message,
    ownBranches(root, env, payload, [lane ?? '', current, branch], subagent),
    (pr) => headOf(root, pr),
  );
  if (foreign !== undefined) return foreign;
  if (subagent && shippedMerge(root, fields?.last_assistant_message))
    return undefined;
  if (recordedShip(root, env, branch, payload)) return undefined;
  // A removed lane worktree whose branch merged needs no ship record: ship may have been detached or its record lost.
  if (!existsSync(start) && lane && mergedLaneBranch(root, lane, mergedPrOf))
    return undefined;
  const outcome = inspect(root, run, shell, env);
  if (outcome.ok) {
    // Floor and unwaived reflex standards of the repository stop the session; finish and waived ones only report.
    // The adopt canary proves the test gate on a fresh repository, which may not meet its reflex standards yet.
    if (env.KRN_LANE === 'canary') return undefined;
    const settled = () =>
      outcomeRefusal(root, env, payload, taskBody(root, env), outcomeJudge);
    const asOf = new Date().toISOString().slice(0, 10);
    // An empty sandbox placeholder (package.json, .npmrc, .env.*) is not the change; a check must not read it.
    clearSandboxPlaceholders(root);
    const failing = standards(root, asOf);
    if (failing.length === 0) {
      logChecks(root, payload, [], env);
      return settled();
    }
    // A standard already red at the merge base is not this branch's doing: it is reported, never blocking.
    const from = base(root, loadContract(root).contract);
    const red = from
      ? failuresAtBase(root, from, (dir) =>
          standards(dir, asOf).map(standardKey),
        )
      : new Set<string>();
    const blockers = failing.filter((line) => !red.has(standardKey(line)));
    logChecks(root, payload, blockers, env);
    if (blockers.length === 0) return settled();
    const inherited = failing.length - blockers.length;
    const preExisting =
      inherited > 0
        ? `\n${inherited} standard(s) already failed at the base and do not block: ${failing
            .filter((line) => red.has(standardKey(line)))
            .map(standardKey)
            .join(', ')}`
        : '';
    return `Stop refused: ${blockers.length} standard(s) pass at the base and fail now (floor, or reflex without a recorded waiver):\n${blockers.map((line) => `- ${line}`).join('\n')}${preExisting}\nFix them, record a reason in \`waiver\` on a reflex record in .agents/standards.json, or end with a line \`BLOCKER: <what stops you>\`.`;
  }
  // A missing base or an invalid contract is refused once: a continued stop (stop_hook_active) is not held again.
  if (fields?.stop_hook_active === true) {
    const { contract, error } = loadContract(root);
    if (error || !base(root, contract)) return undefined;
  }
  const shipped = subagent ? `\n${SHIPPED_HINT}` : '';
  return `Stop refused: ${outcome.reason}${shipped}`;
}

/** A lane subagent refused at the end is told how a merged ship ends it (t-310mwdm). */
export const SHIPPED_HINT =
  'If `krn pr ship` merged your PR, end with its exact line `verdict: merged <sha>`.';

/**
 * The Stop hook on raw stdin: exit 2 with the refusal on stderr, or 0. A crash refuses (Claude Code reads
 * any exit but 2 as non-blocking, so a crash that exited 1 would let the worker stop unchecked), except on
 * a continued stop, so a check that always crashes cannot hold a session forever.
 */
export function stopHook(
  input: string,
  env: NodeJS.ProcessEnv,
  branch: string,
  judge: typeof judgeStop = judgeStop,
): { code: 0 | 2; stderr: string } {
  let payload: unknown = {};
  try {
    payload = JSON.parse(input);
  } catch (error) {
    // Hook input that is not JSON is judged as an empty payload.
    if (!(error instanceof SyntaxError)) throw error;
  }
  try {
    const refusal = judge(payload, env, runTests, branch);
    if (refusal === undefined) return { code: 0, stderr: '' };
    // The same refusal on an unchanged tree three times in a row can never be met: allow the stop.
    const fields = payload as { session_id?: unknown } | null;
    const cwd = stopCheckout(payload, env).root;
    saveRefusal(cwd, refusal);
    const tree = [
      'rev-parse HEAD',
      'status --porcelain -- . :!.krn',
      'diff HEAD',
    ]
      .map((command) => git(cwd, command.split(' ')).stdout)
      .join('\n');
    if (stuckInStopLoop(cwd, fields?.session_id, refusal, tree))
      return {
        code: 0,
        stderr: `Stop allowed: stop-loop, the same refusal three times with no edit between:\n${refusal}\n`,
      };
    return { code: 2, stderr: `${refusal}\n` };
  } catch (error) {
    const message = `Stop check crashed: ${(error as Error)?.stack ?? String(error)}`;
    if ((payload as { stop_hook_active?: unknown })?.stop_hook_active === true)
      return { code: 0, stderr: `${message}\n` };
    return {
      code: 2,
      stderr: `Stop refused: ${message}\nRun \`krn hook stop --check\`, or end with a line \`BLOCKER: <what stops you>\`.\n`,
    };
  }
}

export function main() {
  const mode = process.argv[2];
  const root = resolve(process.env.CLAUDE_PROJECT_DIR ?? process.cwd());
  if (mode === '--related') {
    process.stdout.write(`${related(root).join('\n')}\n`);
    return;
  }
  if (mode === '--red') {
    const red = redTestsAtBase(root);
    process.stdout.write(red.length > 0 ? `${red.join('\n')}\n` : '');
    return;
  }
  if (mode === '--check') {
    const outcome = inspect(root);
    const changedTests = outcome.modified?.length
      ? `\nchanged pre-existing tests: ${outcome.modified.join(', ')}`
      : '';
    process.stdout.write(
      outcome.slotTimeout
        ? `stop SKIPPED (slot): ${outcome.slotTimeout}\n`
        : outcome.ok
          ? `stop PASS${outcome.ignored > 0 ? ` (${outcome.ignored} pre-existing failure(s) ignored)` : ''}${outcome.flaky?.length ? ` (flaky, passed on rerun: ${outcome.flaky.join(', ')})` : ''}${changedTests}\n`
          : `stop FAIL: ${outcome.reason}\n`,
    );
    process.exitCode = outcome.ok ? 0 : 1;
    return;
  }
  let input = '';
  try {
    input = hookStdin();
  } catch (error) {
    // No stdin attached (closed or a terminal with no data) is an empty payload.
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'EAGAIN' && code !== 'EOF' && code !== 'ENXIO') throw error;
  }
  const branch = git(root, ['branch', '--show-current']).stdout.trim();
  const { code, stderr } = stopHook(input, process.env, branch);
  if (stderr) process.stderr.write(stderr);
  process.exitCode = code;
}
if (process.argv[1] === fileURLToPath(import.meta.url)) main();
