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
  /** pass: the gate refused the broken test and passed the clean tree; fail: it did not; skipped: nothing to break. */
  outcome: 'pass' | 'fail' | 'skipped';
  message: string;
}

const productCli = fileURLToPath(new URL('../cli/main.ts', import.meta.url));
const TEST_FILE = [
  /\.(?:test|spec)\.[cm]?[jt]sx?$/u,
  /(?:^|\/)test_[^/]+\.py$/u,
  /_test\.(?:py|go)$/u,
];

function run(cwd: string, command: string, args: string[], env = {}) {
  return spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
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

function stop(tree: string, commands: string[]) {
  const command =
    commands.find((c) => isKrnStopCommand(c)) ??
    commands.find((c) => /worker-stop/u.test(c));
  const env = {
    CLAUDE_PROJECT_DIR: tree,
    KRN_SESSION_CLASS: 'lane',
    KRN_LANE: 'canary',
  };
  const result =
    isKrnStopCommand(command) || command === undefined
      ? spawnSync(process.execPath, [productCli, 'hook', 'stop'], {
          cwd: tree,
          input: '{}',
          encoding: 'utf8',
          env: { ...process.env, ...env },
        })
      : spawnSync('sh', ['-c', command], {
          cwd: tree,
          input: '{}',
          encoding: 'utf8',
          env: { ...process.env, ...env },
        });
  return { status: result.status, stderr: result.stderr };
}

/** Breaks one test in a temporary worktree of the base, requires the Stop gate to refuse it (exit 2), then to pass the clean tree. */
export function runCanary(root: string): CanaryResult {
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
  const commands = stopCommands(root);
  if (!commands.some((c) => isKrnStopCommand(c) || /worker-stop/u.test(c)))
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
    if (clean.status !== 0)
      return fail(
        `the Stop gate does not pass the clean tree after the canary was restored: exit ${clean.status}. ${clean.stderr.slice(-400)}`,
      );
    return {
      outcome: 'pass',
      message: `the Stop gate refused a broken ${file} (exit 2) and passed the restored tree (exit 0)`,
    };
  } finally {
    run(root, 'git', ['worktree', 'remove', '--force', tree]);
    run(root, 'git', ['branch', '-D', branch]);
    rmSync(parent, { recursive: true, force: true });
  }
}
