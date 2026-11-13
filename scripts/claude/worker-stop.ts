import { spawnSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, posix, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { worker } from './worker-scope.ts';

// Stop hook for worker sessions, and the related-test command a lane brief names:
//   node scripts/claude/worker-stop.ts --related    prints the tests importing the files this branch changed
//   node scripts/claude/worker-stop.ts --check      runs them; exit 0 only with a commit and green tests
// D23 arm K ended 7 of 20 n100 runs without a commit (four in under 40 s), and a scoped test list given to the
// agent measured +5 pp at lower cost. A worker session (KRN_SESSION_CLASS=lane or KRN_ROLE=worker) is refused
// the end of its turn while its branch has no commit past the base or the related tests are red.
// A worker whose clone has neither origin/main nor main has no base to measure against: that refuses once
// too (a replay clone once ended every arm K run unchecked this way), naming the missing base.
// One explicit escape: a final message with a line starting `BLOCKER:` that states the blocker.
// The lead sets neither variable, so it is never held here.

const TEST_FILE = /^test\/.+\.test\.(?:ts|js|mjs|cjs)$/u;
const SPECIFIER =
  /(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)(['"])(\.{1,2}\/[^'"]+)\1/gu;
const EXTENSIONS = ['', '.ts', '.mts', '.js', '.mjs', '/index.ts', '/index.js'];

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

const GUARD_DIR = 'test/rules/';

/** Whether the source holds the repository path as a quoted string literal. */
function namesPath(source: string, file: string): boolean {
  return ["'", '"', '`'].some((quote) => source.includes(quote + file + quote));
}

/**
 * Tests among `tests` (path to source) sorted that are changed, import a changed file, name a changed
 * file's repository path as a string literal (data files read by path), or are a tree-scanning guard
 * under test/rules/ (selected whenever any file changed).
 */
export function relatedTests(
  changed: string[],
  tests: Map<string, string>,
): string[] {
  const picked = new Set(changed.filter((file) => tests.has(file)));
  const targets = new Set(changed.filter((file) => !tests.has(file)));
  for (const [path, source] of tests)
    for (const target of imported(path, source))
      if (targets.has(target)) picked.add(path);
  if (changed.length > 0)
    for (const [path, source] of tests) {
      if (path.startsWith(GUARD_DIR)) picked.add(path);
      else if ([...targets].some((file) => namesPath(source, file)))
        picked.add(path);
    }
  return [...picked].sort();
}

function listTests(root: string): Map<string, string> {
  const tests = new Map<string, string>();
  const walk = (dir: string): void => {
    let entries: import('node:fs').Dirent[];
    try {
      entries = readdirSync(join(root, dir), { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = `${dir}/${entry.name}`;
      if (entry.isDirectory()) walk(path);
      else if (TEST_FILE.test(path))
        tests.set(path, readFileSync(join(root, path), 'utf8'));
    }
  };
  walk('test');
  return tests;
}

const git = (root: string, args: string[]) =>
  spawnSync('git', args, { cwd: root, encoding: 'utf8' });

function base(root: string): string {
  for (const ref of ['origin/main', 'main']) {
    const found = git(root, ['merge-base', 'HEAD', ref]);
    if (found.status === 0 && found.stdout.trim()) return found.stdout.trim();
  }
  return '';
}

/** Files the branch changed past its base, committed or not. */
export function changedSinceBase(root: string): string[] {
  const from = base(root);
  if (!from) return [];
  const out = [
    git(root, ['diff', '--name-only', '--diff-filter=d', from]).stdout,
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

/** Failing keys of `tests` at the base commit, run in a temporary detached worktree that is always removed. */
function failuresAtBase(
  root: string,
  from: string,
  tests: string[],
  run: Runner,
): Set<string> {
  const present = tests.filter(
    (file) => git(root, ['cat-file', '-e', `${from}:${file}`]).status === 0,
  );
  if (present.length === 0) return new Set();
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
    return new Set(run(dir, present));
  } finally {
    git(root, ['worktree', 'remove', '--force', dir]);
    rmSync(dir, { recursive: true, force: true });
    git(root, ['worktree', 'prune']);
  }
}

const SHOWN = 10;

/**
 * Whether the branch may stop: a commit past the base and no new test failure. A test failing now that
 * also fails at the base is pre-existing and ignored; `ignored` counts those.
 */
export function inspect(
  root: string,
  run: Runner = runTests,
): Outcome & { ignored: number } {
  const from = base(root);
  if (!from)
    return {
      ok: false,
      ignored: 0,
      reason:
        'no base resolves (neither origin/main nor main exists here), so the branch cannot be checked. Point a `main` branch at the base commit and commit your change, or end with a line `BLOCKER: <what stops you>`.',
    };
  const ahead = git(root, ['rev-list', '--count', `${from}..HEAD`]).stdout;
  if (Number(ahead.trim()) === 0)
    return {
      ok: false,
      ignored: 0,
      reason:
        'there is no commit on this branch yet. Commit your change (run `npm run fast` first), or end with a line `BLOCKER: <what stops you>`.',
    };
  const tests = relatedTests(changedSinceBase(root), listTests(root));
  const failing = tests.length > 0 ? run(root, tests) : [];
  if (failing.length === 0) return { ok: true, reason: '', ignored: 0 };
  const files = [...new Set(failing.map((key) => key.split('::')[0] ?? ''))];
  const before = failuresAtBase(root, from, files, run);
  const fresh = failing.filter((key) => !before.has(key));
  if (fresh.length === 0)
    return { ok: true, reason: '', ignored: failing.length };
  const listed = fresh
    .slice(0, SHOWN)
    .map((key) => `  ${key.replace('::', ' :: ')}`)
    .join('\n');
  const more =
    fresh.length > SHOWN ? `\n  ... ${fresh.length - SHOWN} more` : '';
  return {
    ok: false,
    ignored: failing.length - fresh.length,
    reason: `${fresh.length} related test(s) fail that passed at the base (pre-existing failures were ignored):\n${listed}${more}\nFix them and commit, or end with a line \`BLOCKER: <what stops you>\`.`,
  };
}

/** The refusal reason for a Stop payload, or undefined when the session may end. */
export function judgeStop(
  payload: unknown,
  env: NodeJS.ProcessEnv = process.env,
  run: Runner = runTests,
  branch = '',
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
  if (!worker(env, root, branch)) return undefined;
  if (statesBlocker(fields?.last_assistant_message)) return undefined;
  const outcome = inspect(root, run);
  // A missing base is refused once: a continued stop (stop_hook_active) is not held again for it.
  if (!outcome.ok && fields?.stop_hook_active === true && !base(root))
    return undefined;
  return outcome.ok ? undefined : `Stop refused: ${outcome.reason}`;
}

function main() {
  const mode = process.argv[2];
  const root = resolve(process.env.CLAUDE_PROJECT_DIR ?? process.cwd());
  if (mode === '--related') {
    process.stdout.write(
      `${relatedTests(changedSinceBase(root), listTests(root)).join('\n')}\n`,
    );
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
  let payload: unknown;
  try {
    payload = JSON.parse(readFileSync(0, 'utf8'));
  } catch {
    return;
  }
  const branch = git(root, ['branch', '--show-current']).stdout;
  const refusal = judgeStop(payload, process.env, runTests, branch);
  if (refusal !== undefined) {
    process.stderr.write(`${refusal}\n`);
    process.exitCode = 2;
  }
}
if (process.argv[1] === fileURLToPath(import.meta.url)) main();
