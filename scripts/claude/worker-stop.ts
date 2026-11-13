import { spawnSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, posix, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ContractError,
  type RepoContract,
  relatedCommand,
  resolveContract,
} from '../../src/repo/contract.ts';
import { UNIDENTIFIED_LANE, worker } from './worker-scope.ts';

// Stop hook for worker sessions, and the related-test command a lane brief names:
//   node scripts/claude/worker-stop.ts --related    prints the tests (or Go packages) this branch's change selects
//   node scripts/claude/worker-stop.ts --check      runs them; exit 0 only with a commit and green tests
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

const LEGACY_TEST = /^test\/.+\.test\.(?:ts|js|mjs|cjs)$/u;
const TEST_FILE = [
  LEGACY_TEST,
  /\.(?:test|spec)\.[cm]?[jt]sx?$/u,
  /(?:^|\/)test_[^/]+\.py$/u,
  /_test\.(?:py|go)$/u,
  /_spec\.rb$/u,
];
const SPECIFIER =
  /(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)(['"])(\.{1,2}\/[^'"]+)\1/gu;
const EXTENSIONS = ['', '.ts', '.mts', '.js', '.mjs', '/index.ts', '/index.js'];
const NODE_RELATED = 'node --test {files}';

/** Whether the message states a blocker on a line of its own: `BLOCKER: <reason>`. */
export function statesBlocker(message: unknown): boolean {
  return (
    typeof message === 'string' && /^\s*\**BLOCKER:\**\s*\S/mu.test(message)
  );
}

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
      } catch {}
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

/** Files the branch changed past its base, committed or not, deleted ones included. */
export function changedSinceBase(root: string, from = base(root)): string[] {
  if (!from) return [];
  const out = [
    git(root, ['diff', '--name-only', from]).stdout,
    git(root, ['ls-files', '--others', '--exclude-standard']).stdout,
  ].join('\n');
  return [...new Set(out.split('\n').filter(Boolean))].sort();
}

export interface Outcome {
  ok: boolean;
  reason: string;
}

/** Failing tests of one run as `<file>::<name>` keys; a run that dies without naming a test yields `<run>::exit <status>`. */
export type Runner = (root: string, tests: string[]) => string[];
/** Failing keys of one shell command run at `root`, read from its output. */
export type CommandRunner = (root: string, command: string) => string[];

const REPORTER = fileURLToPath(
  new URL('./failure-reporter.mjs', import.meta.url),
);

const runTests: Runner = (root, tests) => {
  const run = spawnSync(
    process.execPath,
    ['--test', `--test-reporter=${REPORTER}`, ...tests],
    {
      cwd: root,
      encoding: 'utf8',
      // Inside a `node --test` parent this variable turns the child into a nested run with no reporter output.
      env: { ...process.env, NODE_TEST_CONTEXT: undefined },
      stdio: ['ignore', 'pipe', 'ignore'],
      maxBuffer: 64 * 1024 * 1024,
      timeout: 600_000,
    },
  );
  const failed: string[] = [];
  for (const line of run.stdout.split('\n')) {
    if (!line.startsWith('{')) continue;
    try {
      const { file, name } = JSON.parse(line) as {
        file: string;
        name: string;
      };
      failed.push(`${file}::${name}`);
    } catch {}
  }
  if (failed.length === 0 && run.status !== 0)
    failed.push(`<run>::exit ${run.status ?? run.signal}`);
  return failed;
};

// One failing test per match, by runner: pytest summary, unittest, go, cargo, jest/vitest file lines.
const FAILURE_LINES: readonly RegExp[] = [
  /^(?:FAILED|ERROR) (\S+)/mu,
  /^(?:FAIL|ERROR): \S+ \(([^)]+)\)/mu,
  /^\s*--- FAIL: (\S+)/mu,
  /^FAIL\s+(\S+)\s/mu,
  /^test (\S+) \.\.\. FAILED/mu,
  /^\s*FAIL\s+(\S+)/mu,
];

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
  return [...found].sort();
}

const runCommand: CommandRunner = (root, command) => {
  const run = spawnSync('sh', ['-c', `${command} 2>&1`], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, NODE_TEST_CONTEXT: undefined },
    stdio: ['ignore', 'pipe', 'ignore'],
    maxBuffer: 64 * 1024 * 1024,
    timeout: 600_000,
  });
  return failuresIn(run.stdout ?? '', run.status ?? run.signal ?? 'killed');
};

/** Failing keys of `measure` at the base commit, run in a temporary detached worktree that is always removed. */
function failuresAtBase(
  root: string,
  from: string,
  measure: (dir: string) => string[],
): Set<string> {
  const dir = mkdtempSync(join(tmpdir(), 'worker-stop-base-'));
  try {
    const added = git(root, ['worktree', 'add', '--detach', dir, from]);
    if (added.status !== 0) return new Set();
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
    return new Set(measure(dir));
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
  if (node) {
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
      : relatedCommand(contract, selection.files),
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
): Outcome & { ignored: number } {
  const { contract, error } = loadContract(root);
  if (error)
    return {
      ok: false,
      ignored: 0,
      reason: `the repo contract is invalid (${error}). Fix krn.json and commit, or end with a line \`BLOCKER: <what stops you>\`.`,
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
      reason: `there is no commit on this branch yet. Commit your change (run \`${contract?.fast ?? contract?.test ?? 'the tests'}\` first), or end with a line \`BLOCKER: <what stops you>\`.`,
    };
  const { selection, command } = plan(root, from, contract);
  const files = [...selection.files];
  let failing: string[];
  let before: () => Set<string>;
  if (command === undefined) {
    failing = files.length > 0 ? run(root, files) : [];
    before = () => {
      const named = [...new Set(failing.map((key) => key.split('::')[0]))];
      const present = named.filter(
        (file) =>
          file !== undefined &&
          git(root, ['cat-file', '-e', `${from}:${file}`]).status === 0,
      ) as string[];
      return present.length === 0
        ? new Set()
        : failuresAtBase(root, from, (dir) => run(dir, present));
    };
  } else {
    failing = shell(root, command);
    before = () => failuresAtBase(root, from, (dir) => shell(dir, command));
  }
  if (failing.length === 0) return { ok: true, reason: '', ignored: 0 };
  // A missing runner fails the same way at the base, so it would pass as pre-existing: refuse it instead.
  const missing = failing.find((key) => /^<run>::exit 12[67]$/u.test(key));
  if (missing)
    return {
      ok: false,
      ignored: 0,
      reason: `the test command could not start (${missing.slice(7)}: command not found or not executable)${command === undefined ? '' : `: ${command}`}. Install the runner the repo contract names or fix krn.json, or end with a line \`BLOCKER: <what stops you>\`.`,
    };
  const earlier = before();
  const fresh = failing.filter((key) => !earlier.has(key));
  if (fresh.length === 0)
    return { ok: true, reason: '', ignored: failing.length };
  const listed = fresh
    .slice(0, SHOWN)
    .map((key) => `  ${key.replace('::', ' :: ')}`)
    .join('\n');
  const more =
    fresh.length > SHOWN ? `\n  ... ${fresh.length - SHOWN} more` : '';
  const ran = command === undefined ? '' : ` (ran: ${command})`;
  return {
    ok: false,
    ignored: failing.length - fresh.length,
    reason: `${fresh.length} related test(s) fail that passed at the base (pre-existing failures were ignored)${ran}:\n${listed}${more}\nFix them and commit, or end with a line \`BLOCKER: <what stops you>\`.`,
  };
}

/** The refusal reason for a Stop payload, or undefined when the session may end. */
export function judgeStop(
  payload: unknown,
  env: NodeJS.ProcessEnv = process.env,
  run: Runner = runTests,
  branch = '',
  shell: CommandRunner = runCommand,
): string | undefined {
  const fields = payload as {
    cwd?: unknown;
    last_assistant_message?: unknown;
    stop_hook_active?: unknown;
  } | null;
  const root = resolve(
    env.CLAUDE_PROJECT_DIR ??
      (typeof fields?.cwd === 'string' ? fields.cwd : process.cwd()),
  );
  const who = worker(env, root, branch);
  if (!who) return undefined;
  if (who.unidentified) return `Stop refused: ${UNIDENTIFIED_LANE}`;
  if (statesBlocker(fields?.last_assistant_message)) return undefined;
  const outcome = inspect(root, run, shell);
  if (outcome.ok) return undefined;
  // A missing base or an invalid contract is refused once: a continued stop (stop_hook_active) is not held again.
  if (fields?.stop_hook_active === true) {
    const { contract, error } = loadContract(root);
    if (error || !base(root, contract)) return undefined;
  }
  return `Stop refused: ${outcome.reason}`;
}

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
  } catch {}
  try {
    const refusal = judge(payload, env, runTests, branch);
    return refusal === undefined
      ? { code: 0, stderr: '' }
      : { code: 2, stderr: `${refusal}\n` };
  } catch (error) {
    const message = `Stop check crashed: ${(error as Error)?.stack ?? String(error)}`;
    if ((payload as { stop_hook_active?: unknown })?.stop_hook_active === true)
      return { code: 0, stderr: `${message}\n` };
    return {
      code: 2,
      stderr: `Stop refused: ${message}\nRun \`node scripts/claude/worker-stop.ts --check\`, or end with a line \`BLOCKER: <what stops you>\`.\n`,
    };
  }
}

function main() {
  const mode = process.argv[2];
  const root = resolve(process.env.CLAUDE_PROJECT_DIR ?? process.cwd());
  if (mode === '--related') {
    process.stdout.write(`${related(root).join('\n')}\n`);
    return;
  }
  if (mode === '--check') {
    const outcome = inspect(root);
    process.stdout.write(
      outcome.ok
        ? `worker-stop PASS${outcome.ignored > 0 ? ` (${outcome.ignored} pre-existing failure(s) ignored)` : ''}\n`
        : `worker-stop FAIL: ${outcome.reason}\n`,
    );
    process.exitCode = outcome.ok ? 0 : 1;
    return;
  }
  let input = '';
  try {
    input = readFileSync(0, 'utf8');
  } catch {}
  const branch = git(root, ['branch', '--show-current']).stdout;
  const { code, stderr } = stopHook(input, process.env, branch);
  if (stderr) process.stderr.write(stderr);
  process.exitCode = code;
}
if (process.argv[1] === fileURLToPath(import.meta.url)) main();
