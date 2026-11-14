// The adoption canary: proves the Stop gate works in the adopted repository by breaking one existing test.
import { spawnSync } from 'node:child_process';
import {
  appendFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CONTRACT_FILE,
  findContract,
  type RepoContract,
} from '../repo/contract.ts';
import { isKrnStopCommand } from './stop-hook.ts';

export interface CanaryResult {
  /**
   * pass: the gate refused the broken test and passed the clean tree; fail: it did not; skipped: nothing to break;
   * timeout: the canary ran past its time limit; red-base: the repository's own test command fails on the clean base.
   */
  outcome: 'pass' | 'fail' | 'skipped' | 'timeout' | 'red-base';
  message: string;
}

const productCli = fileURLToPath(new URL('../cli/main.ts', import.meta.url));
const TEST_FILE = [
  /\.(?:test|spec)\.[cm]?[jt]sx?$/u,
  /(?:^|\/)test_[^/]+\.py$/u,
  /_test\.(?:py|go)$/u,
];

/** The whole canary may run this long (KRN_CANARY_TIMEOUT_MS overrides); a slow install or test suite ends it with outcome timeout. */
export const CANARY_TIMEOUT_MS = 180_000;

class CanaryTimeout extends Error {}

let deadline = Number.POSITIVE_INFINITY;

function remaining(): number {
  const left = deadline - Date.now();
  if (left <= 0) throw new CanaryTimeout();
  return left;
}

function timedOut(result: { error?: Error | undefined }): boolean {
  return (
    (result.error as NodeJS.ErrnoException | undefined)?.code === 'ETIMEDOUT'
  );
}

function run(cwd: string, command: string, args: string[], env = {}) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, ...env },
    timeout: remaining(),
    killSignal: 'SIGKILL',
  });
  if (timedOut(result)) throw new CanaryTimeout();
  return result;
}

const gitIn = (cwd: string, ...args: string[]) =>
  run(cwd, 'git', [
    '-c',
    'user.email=canary@krn',
    '-c',
    'user.name=krn-canary',
    ...args,
  ]);

/** The Stop commands the adopted settings call, or none when the gate is not installed. */
function stopCommands(root: string): string[] {
  try {
    const settings = JSON.parse(
      readFileSync(join(root, '.claude/settings.json'), 'utf8'),
    ) as { hooks?: { Stop?: { hooks?: { command?: unknown }[] }[] } };
    return (settings.hooks?.Stop ?? [])
      .flatMap((entry) => entry.hooks ?? [])
      .flatMap((hook) =>
        typeof hook.command === 'string' ? [hook.command] : [],
      );
  } catch {
    return [];
  }
}

/** Candidate test files, best first: under the package the test command names, then under a test directory. */
function testFiles(root: string, contract: RepoContract): string[] {
  const listed = run(root, 'git', ['ls-files']).stdout.split('\n');
  const tests = listed.filter((f) => TEST_FILE.some((p) => p.test(f))).sort();
  const scope =
    /--prefix\s+(\S+)/u.exec(contract.test)?.[1] ??
    /\bcd\s+(\S+)/u.exec(contract.test)?.[1];
  const dir = scope?.replace(/^\.\//u, '').replace(/\/$/u, '');
  const rank = (f: string) =>
    (dir && f.startsWith(`${dir}/`) ? 0 : 2) +
    (/(?:^|\/)(?:tests?|__tests__)\//u.test(f) ? 0 : 1);
  return tests.sort((x, y) => rank(x) - rank(y));
}

function breakage(file: string): string | undefined {
  if (/\.py$/u.test(file)) return '\nassert False, "krn canary"\n';
  if (/\.go$/u.test(file))
    return '\nfunc TestKrnCanary(t *testing.T) { t.Fatal("krn canary") }\n';
  if (/\.[cm]?[jt]sx?$/u.test(file))
    return '\nthrow new Error("krn canary");\n';
  return undefined;
}

/** Dependencies for the temp worktree: link the clone's node_modules, else run the contract install. */
function prepare(
  root: string,
  tree: string,
  contract: RepoContract,
): string | undefined {
  const dirs = run(root, 'git', [
    'ls-files',
    '--',
    'package.json',
    '**/package.json',
  ])
    .stdout.split('\n')
    .filter(Boolean)
    .map((f) => dirname(f));
  let linked = false;
  for (const dir of new Set(dirs)) {
    const from = join(root, dir, 'node_modules');
    const to = join(tree, dir, 'node_modules');
    if (existsSync(from) && !existsSync(to)) {
      symlinkSync(from, to);
      linked = true;
    }
  }
  if (!linked && contract.install) {
    const install = run(tree, 'sh', ['-c', contract.install]);
    if (install.status !== 0)
      return `the install command failed (${contract.install}): ${install.stderr.slice(-300)}`;
  }
  return undefined;
}

/** A Stop entry that runs the gate module by path: KRN's own (src/hook/stop.ts) or the legacy worker-stop script. */
const OWN_STOP = /src\/hook\/stop\.ts|worker-stop/u;

function stop(tree: string, commands: string[]) {
  const command =
    commands.find((c) => isKrnStopCommand(c)) ??
    commands.find((c) => OWN_STOP.test(c));
  const env = {
    CLAUDE_PROJECT_DIR: tree,
    KRN_SESSION_CLASS: 'lane',
    KRN_LANE: 'canary',
  };
  const limits = {
    cwd: tree,
    input: '{}',
    encoding: 'utf8',
    env: { ...process.env, ...env },
    timeout: remaining(),
    killSignal: 'SIGKILL',
  } as const;
  const result =
    isKrnStopCommand(command) || command === undefined
      ? spawnSync(process.execPath, [productCli, 'hook', 'stop'], limits)
      : spawnSync('sh', ['-c', command], limits);
  if (timedOut(result)) throw new CanaryTimeout();
  return { status: result.status, stderr: result.stderr };
}

/** Breaks one test in a temporary worktree of the base, requires the Stop gate to refuse it (exit 2), then to pass the clean tree. */
export function runCanary(
  root: string,
  timeoutMs: number = Number(process.env.KRN_CANARY_TIMEOUT_MS) ||
    CANARY_TIMEOUT_MS,
): CanaryResult {
  deadline = Date.now() + timeoutMs;
  try {
    return canary(root);
  } catch (error) {
    if (!(error instanceof CanaryTimeout)) throw error;
    return {
      outcome: 'timeout',
      message: `the canary did not finish within ${Math.round(timeoutMs / 1000)}s (install, test command or Stop gate too slow); raise KRN_CANARY_TIMEOUT_MS, or pass --no-canary to decline`,
    };
  } finally {
    deadline = Number.POSITIVE_INFINITY;
  }
}

function canary(root: string): CanaryResult {
  const skipped = (message: string): CanaryResult => ({
    outcome: 'skipped',
    message,
  });
  const fail = (message: string): CanaryResult => ({
    outcome: 'fail',
    message,
  });
  let found: ReturnType<typeof findContract>;
  try {
    found = findContract(root);
  } catch (error) {
    return fail(`the repo contract is invalid: ${(error as Error).message}`);
  }
  if (found === undefined)
    return skipped('no test command in the repo contract');
  const { contract } = found;
  // A vacuous contract carries a command that fails on purpose: there is no gate to prove until a real test exists.
  if (contract.vacuous === true)
    return skipped(
      'no test command in the repo contract (the contract is vacuous: add one real test and set test in krn.json)',
    );
  const commands = stopCommands(root);
  if (!commands.some((c) => isKrnStopCommand(c) || OWN_STOP.test(c)))
    return fail(
      'the Stop hook is not installed: .claude/settings.json has no Stop entry calling `krn hook stop`, so a broken test would not be refused',
    );
  const files = testFiles(root, contract).filter(
    (f) => breakage(f) !== undefined,
  );
  if (files.length === 0)
    return skipped('no test file the canary can break (js, ts, py, go)');
  const baseRef =
    run(root, 'git', [
      'rev-parse',
      '--verify',
      '-q',
      `${contract.base}^{commit}`,
    ]).status === 0
      ? contract.base
      : 'HEAD';
  if (
    run(root, 'git', ['rev-parse', '--verify', '-q', `${baseRef}^{commit}`])
      .status !== 0
  )
    return skipped('the repository has no commit to branch the canary from');

  const parent = mkdtempSync(join(tmpdir(), 'krn-canary-'));
  const tree = join(parent, 'tree');
  const branch = `krn-canary-${process.pid}`;
  try {
    const add = run(root, 'git', [
      'worktree',
      'add',
      '-q',
      '--no-track',
      '-b',
      branch,
      tree,
      baseRef,
    ]);
    if (add.status !== 0)
      return skipped(
        `cannot create a temporary worktree: ${add.stderr.trim()}`,
      );
    if (!existsSync(join(tree, CONTRACT_FILE)))
      writeFileSync(
        join(tree, CONTRACT_FILE),
        `${JSON.stringify(contract, null, 2)}\n`,
      );
    const prepared = prepare(root, tree, contract);
    if (prepared) return fail(prepared);

    // A test file the runner does not collect (another include pattern) cannot be refused: try the next.
    const tried: string[] = [];
    let refusedFile: string | undefined;
    let last: { status: number | null; stderr: string } | undefined;
    for (const file of files.slice(0, 3)) {
      appendFileSync(join(tree, file), breakage(file) as string);
      gitIn(tree, 'commit', '-qm', 'canary: break one test', '--', file);
      last = stop(tree, commands);
      tried.push(file);
      if (last.status === 2) {
        refusedFile = file;
        break;
      }
      gitIn(tree, 'reset', '-q', '--hard', 'HEAD~1');
    }
    if (refusedFile === undefined)
      return fail(
        `the Stop gate did not refuse a broken test (${tried.join(', ')}): expected exit 2, got ${last?.status}. ${last?.stderr.slice(-300)}`,
      );
    const file = refusedFile;

    gitIn(tree, 'reset', '-q', '--hard', 'HEAD~1');
    gitIn(tree, 'commit', '-q', '--allow-empty', '-m', 'canary: clean tree');
    const clean = stop(tree, commands);
    if (clean.status !== 0) {
      // A red base (the repository's own command fails on its clean tree: missing dependencies, a broken test)
      // is not a gate defect: name the command.
      const own = run(tree, 'sh', ['-c', contract.test]);
      if (own.status !== 0)
        return {
          outcome: 'red-base',
          message: `red base: the repository's own test command \`${contract.test}\` exits ${own.status} on the clean ${baseRef} tree, so the Stop gate cannot pass it; make it pass (install the dependencies) and rerun. ${(own.stderr || own.stdout).replace(/\s+/gu, ' ').trim().slice(-300)}`,
        };
      return fail(
        `the Stop gate does not pass the clean tree after the canary was restored: exit ${clean.status}. ${clean.stderr.slice(-400)}`,
      );
    }
    return {
      outcome: 'pass',
      message: `the Stop gate refused a broken ${file} (exit 2) and passed the restored tree (exit 0)`,
    };
  } finally {
    // Cleanup ignores the deadline: a timed-out canary still removes its worktree.
    spawnSync('git', ['worktree', 'remove', '--force', tree], { cwd: root });
    spawnSync('git', ['branch', '-D', branch], { cwd: root });
    rmSync(parent, { recursive: true, force: true });
  }
}
