// `krn adopt <path> --verify`: a read-only report of the repository settings adoption relies on.
import { spawnSync } from 'node:child_process';
import {
  appendFileSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { projectPath } from '../harness/claude.ts';
import {
  CONTRACT_FILE,
  contractBase,
  contractDeployAcknowledged,
  findContract,
  type RepoContract,
  relatedCommand,
  withinPackage,
} from '../repo/contract.ts';
import { ghApiSync } from '../repo/gh.ts';
import { requiredContexts } from '../repo/required-check.ts';
import { deployRemedy, deployWorkflows } from './deploy.ts';
import { isKrnStopCommand } from './stop-hook.ts';
import { GATE_KEYS, type GateKey, workflowGates } from './workflow-gates.ts';

const repoSchema = z.object({
  default_branch: z.string().min(1),
  allow_auto_merge: z.boolean().optional(),
});

export interface VerifyReport {
  ok: boolean;
  gaps: string[];
  /** Set when the CI checks were not run, with the reason: a repository with no origin (a fresh local project). */
  skipped?: string;
}

/** The `origin` URL of `root`, or undefined without one. */
export function originUrl(root: string): string | undefined {
  const run = spawnSync('git', ['remote', 'get-url', 'origin'], {
    cwd: root,
    encoding: 'utf8',
  });
  const url = run.stdout.trim();
  return run.status === 0 && url !== '' ? url : undefined;
}

/** True when the origin names a GitHub host (github.com or a host gh is logged in to through GH_HOST). */
export function hasGithubHost(url: string | undefined): boolean {
  if (url === undefined) return false;
  const host =
    /^[a-z+]+:\/\/(?:[^@/]+@)?([^/:]+)/iu.exec(url)?.[1] ??
    /^[^@/\s]+@([^:/]+):/u.exec(url)?.[1];
  if (host === undefined) return false;
  const extra = process.env.GH_HOST;
  return (
    host.toLowerCase() === 'github.com' ||
    (extra !== undefined && host.toLowerCase() === extra.toLowerCase())
  );
}

/**
 * Gaps in the answers of `gh api repos/<repo>`, `gh api repos/<repo>/branches/<default>` and
 * `gh api repos/<repo>/rules/branches/<default>`: a required check counts from classic protection or a ruleset.
 */
export function verifyGaps(
  repoBody: string,
  branchBody: string,
  rulesBody = '[]',
): string[] {
  const repo = repoSchema.parse(JSON.parse(repoBody));
  const gaps: string[] = [];
  if (repo.allow_auto_merge !== true)
    gaps.push(
      'auto-merge is not allowed (repository setting allow_auto_merge)',
    );
  if (requiredContexts(branchBody, rulesBody).length !== 1)
    gaps.push(
      `branch ${repo.default_branch} has no single required status check from GitHub Actions`,
    );
  return gaps;
}

export function defaultBranch(repoBody: string): string {
  return repoSchema.parse(JSON.parse(repoBody)).default_branch;
}

/** Where the KRN delivery GitHub App is installed on a repository. */
export const APP_INSTALL_URL =
  'https://github.com/apps/krn-works-delivery/installations/new';
/** Exit of a repository the GitHub App cannot see. */
export const APP_NOT_INSTALLED_EXIT = 67;

export class AppNotInstalledError extends Error {
  readonly exitCode = APP_NOT_INSTALLED_EXIT;
  constructor(slug: string) {
    super(`GitHub App not installed on ${slug}: install at ${APP_INSTALL_URL}`);
  }
}

/** `<owner>/<repo>` of a GitHub origin url, or undefined. */
export function repoSlug(url: string | undefined): string | undefined {
  const match =
    /^[a-z+]+:\/\/(?:[^@/]+@)?[^/:]+(?::\d+)?\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/iu.exec(
      url ?? '',
    ) ?? /^[^@/\s]+@[^:/]+:([^/]+)\/([^/]+?)(?:\.git)?$/u.exec(url ?? '');
  return match ? `${match[1]}/${match[2]}` : undefined;
}

/** True when a `gh api repos/<repo>` failure is the 404 gh prints for a repository the token cannot see. */
export function isRepositoryNotFound(status: number | null, stderr: string) {
  return status !== 0 && /\(HTTP 404\)/u.test(stderr);
}

function gh(root: string, path: string): string {
  const run = ghApiSync(root, path);
  if (
    path === 'repos/{owner}/{repo}' &&
    isRepositoryNotFound(run.status, run.stderr)
  )
    throw new AppNotInstalledError(
      repoSlug(originUrl(root)) ?? '{owner}/{repo}',
    );
  if (run.status !== 0)
    throw new Error(
      `gh api ${path} failed (exit ${run.status ?? 'none'}): ${run.stderr.trim() || run.error?.message || ''}`,
    );
  return run.stdout;
}

/** Reads the repository of `root` through gh; changes no setting. */
export function verifyRepository(root: string): VerifyReport {
  const origin = originUrl(root);
  const github = hasGithubHost(origin);
  const base = contractBase(root);
  const gaps: string[] = [];
  // No origin is the bootstrap flow of a fresh local project: it is reported, not refused. An origin that is not GitHub is refused.
  if (!github && origin !== undefined)
    gaps.push(
      `no GitHub host (origin ${origin}): the required check and auto-merge cannot be checked`,
    );
  else if (github) {
    const repoBody = gh(root, 'repos/{owner}/{repo}');
    const branch = defaultBranch(repoBody);
    gaps.push(
      ...verifyGaps(
        repoBody,
        gh(root, `repos/{owner}/{repo}/branches/${branch}`),
        gh(root, `repos/{owner}/{repo}/rules/branches/${branch}`),
      ),
    );
    // krn.json `base` wins over the repository default, as for lanes; the gate read above is the default branch's.
    if (base !== branch)
      gaps.push(
        `lane base ${base} is not the default branch ${branch}: the required check on ${base} was not checked`,
      );
  }
  const deploying = deployWorkflows(root, base);
  if (deploying.length > 0 && !contractDeployAcknowledged(root))
    gaps.push(deployRemedy(deploying, base));
  return origin === undefined
    ? {
        ok: gaps.length === 0,
        gaps,
        skipped:
          'no origin: the required gate (required check and auto-merge) was not checked',
      }
    : { ok: gaps.length === 0, gaps };
}

/** One contract gate command that two or more workflows run, and the files that run it. */
export interface DuplicateCi {
  gate: GateKey;
  command: string;
  files: string[];
}

/**
 * The contract gate commands (lint, typecheck, test) that more than one workflow runs: adopt fills
 * gaps and never adds a second runner, so an adopted repository reports none. A repository without a
 * readable contract has no gate commands to compare and reports none.
 */
export function duplicateCi(root: string): DuplicateCi[] {
  let contract: ReturnType<typeof findContract>;
  try {
    contract = findContract(root);
  } catch {
    return [];
  }
  if (contract === undefined) return [];
  const commands = {
    lint: contract.contract.lint,
    typecheck: contract.contract.typecheck,
    test: contract.contract.vacuous ? undefined : contract.contract.test,
  };
  const gates = workflowGates(root, commands);
  return GATE_KEYS.filter((gate) => gates.duplicated.includes(gate)).map(
    (gate) => ({
      gate,
      command: commands[gate] ?? '',
      files: gates.runBy[gate] ?? [],
    }),
  );
}

// The adoption canary: proves the Stop gate works in the adopted repository by breaking one existing test.
export interface CanaryResult {
  /**
   * pass: the gate refused the broken test and passed the clean tree; fail: it did not; skipped: nothing to break;
   * timeout: the canary ran past its time limit; red-base: the repository's own test command fails on the clean base;
   * bootstrap: the contract is vacuous (no real test yet) and the Stop gate refused it, as it must until the first test lands.
   */
  outcome: 'pass' | 'fail' | 'skipped' | 'timeout' | 'red-base' | 'bootstrap';
  message: string;
}

const productCli = fileURLToPath(new URL('../cli/main.ts', import.meta.url));
const TEST_FILE = [
  /\.(?:test|spec)\.[cm]?[jt]sx?$/u,
  // A script in a test directory is a test file (tap and mocha run `test/*.js`).
  /(?:^|\/)(?:tests?|__tests__)\/[^/]+\.[cm]?[jt]sx?$/u,
  /(?:^|\/)test_[^/]+\.py$/u,
  /_test\.(?:py|go)$/u,
  /(?:^|\/)tests\/[^/]+\.rs$/u,
  /(?:^|\/)tests?\/[^/]+\.php$/u,
  /Test\.php$/u,
];

/** The whole canary may run this long (KRN_CANARY_TIMEOUT_MS overrides); a slow install or test suite ends it with outcome timeout. */
export const CANARY_TIMEOUT_MS = 180_000;

class CanaryTimeout extends Error {}

let deadline = Number.POSITIVE_INFINITY;
/** The step the canary is in (install, test command, Stop gate) and when it began, so a timeout names the slow one. */
let step = { name: 'setup', since: Date.now() };

function enter(name: string): void {
  step = { name, since: Date.now() };
}

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

/**
 * The bin directories of the tool versions a repository pins in mise.toml (`[tools]`, bare keys with a plain version),
 * resolved with `mise where <tool>@<version>` from a neutral directory so no repository config has to be trusted.
 * Empty when mise is absent, the file pins nothing, or a pinned version is not installed.
 */
export function pinnedToolBins(root: string): string[] {
  const file = ['mise.toml', '.mise.toml']
    .map((name) => join(root, name))
    .find((path) => existsSync(path));
  if (file === undefined) return [];
  const bins: string[] = [];
  let inTools = false;
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const header = /^\s*\[([^\]]+)\]\s*$/u.exec(line);
    if (header) inTools = header[1] === 'tools';
    const pin = inTools
      ? /^\s*([A-Za-z][\w-]*)\s*=\s*"(\d[\w.-]*)"\s*(?:#.*)?$/u.exec(line)
      : null;
    if (!pin) continue;
    const where = spawnSync('mise', ['where', `${pin[1]}@${pin[2]}`], {
      cwd: tmpdir(),
      encoding: 'utf8',
    });
    const dir = where.stdout?.trim();
    if (where.status === 0 && dir && existsSync(join(dir, 'bin')))
      bins.push(join(dir, 'bin'));
  }
  return bins;
}

/** Runs one of the repository's own commands under its pinned toolchain (the PATH tools when it pins none). */
function runOwn(root: string, tree: string, command: string) {
  const bins = pinnedToolBins(root);
  const path = [...bins, process.env.PATH ?? ''].join(':');
  // The canary trees, and the temp directories a suite copies the repository into, are throwaway: their mise config
  // is trusted for these runs only (an environment variable; nothing is written to the host's mise trust list).
  return run(tree, 'sh', ['-c', command], {
    PATH: path,
    MISE_TRUSTED_CONFIG_PATHS: [dirname(tree), tmpdir()].join(':'),
  });
}

/** Names of the tests a runner's output reports as failed (node:test spec `✖ name`, tap `not ok N - name`, pytest `FAILED id`). */
export function failedTestNames(output: string): string[] {
  const names = new Set<string>();
  for (const line of output.split('\n')) {
    const found =
      /^\s*✖\s+(.+?)(?:\s+\(\d[\d.]*m?s\))?\s*$/u.exec(line) ??
      /^\s*not ok \d+\s*-?\s*(.+?)\s*$/u.exec(line) ??
      /^\s*FAILED\s+(\S.*?)(?:\s+-\s.*)?$/u.exec(line);
    if (found?.[1] && !/^failing tests:?$/u.test(found[1])) names.add(found[1]);
  }
  return [...names];
}

/**
 * A worktree of the base with the repository's uncommitted adoption files laid over it, so the suite can run
 * with them. Undefined when the repository has no uncommitted change (the base already carries them).
 */
function withAdoptionFiles(
  root: string,
  parent: string,
  baseRef: string,
  contract: RepoContract,
): string | undefined {
  const dirty = (flags: string[]) =>
    run(root, 'git', ['ls-files', ...flags, '--exclude-standard'])
      .stdout.split('\n')
      .filter(Boolean);
  const changed = [...dirty(['-m']), ...dirty(['-o'])];
  const deleted = dirty(['-d']);
  if (changed.length === 0 && deleted.length === 0) return undefined;
  const tree = join(parent, 'with-adoption');
  const add = run(root, 'git', [
    'worktree',
    'add',
    '-q',
    '--detach',
    tree,
    baseRef,
  ]);
  if (add.status !== 0) return undefined;
  for (const file of deleted) rmSync(join(tree, file), { force: true });
  for (const file of changed) {
    const from = join(root, file);
    if (lstatSync(from, { throwIfNoEntry: false }) === undefined) continue;
    mkdirSync(dirname(join(tree, file)), { recursive: true });
    rmSync(join(tree, file), { recursive: true, force: true });
    cpSync(from, join(tree, file), { recursive: true, verbatimSymlinks: true });
  }
  prepare(root, tree, contract);
  return tree;
}

/** The slice of .claude/settings.json the canary reads: Stop hook commands. */
export const stopSettingsSchema = z.looseObject({
  hooks: z
    .looseObject({
      Stop: z
        .array(
          z.looseObject({
            hooks: z
              .array(z.looseObject({ command: z.unknown().optional() }))
              .optional(),
          }),
        )
        .optional(),
    })
    .optional(),
});

/** The Stop commands the adopted settings call, or none when the gate is not installed. */
function stopCommands(root: string): string[] {
  try {
    const settings = stopSettingsSchema.parse(
      JSON.parse(readFileSync(projectPath(root, 'settings.json'), 'utf8')),
    );
    return (settings.hooks?.Stop ?? [])
      .flatMap((entry) => entry.hooks ?? [])
      .flatMap((hook) =>
        typeof hook.command === 'string' ? [hook.command] : [],
      );
  } catch {
    return [];
  }
}

/**
 * The test files a test command's path and glob arguments (`node --test test/*.test.mjs`) select, with shell glob
 * semantics relative to the repository root. `named` is false when the command names no glob or test-file path.
 */
export function namedTests(
  command: string,
  files: string[],
): { named: boolean; matched: string[] } {
  const patterns = (command.match(/[\w./*-]+/gu) ?? [])
    .map((token) => token.replace(/^\.\//u, ''))
    .filter(
      (token) => token.includes('*') || TEST_FILE.some((p) => p.test(token)),
    )
    .map(
      (token) =>
        new RegExp(
          `^${token
            .replace(/[.+?^${}()|[\]\\]/gu, '\\$&')
            .replace(/\*\*\//gu, '(?:.*/)?')
            .replace(/\*\*/gu, '.*')
            .replace(/\*/gu, '[^/]*')}$`,
          'u',
        ),
    );
  return {
    named: patterns.length > 0,
    matched: files.filter(
      (f) =>
        TEST_FILE.some((p) => p.test(f)) && patterns.some((p) => p.test(f)),
    ),
  };
}

/** Candidate test files, best first: under the package the test command names, then under a test directory. */
function testFiles(root: string, contract: RepoContract): string[] {
  const listed = run(root, 'git', ['ls-files']).stdout.split('\n');
  const tests = listed.filter((f) => TEST_FILE.some((p) => p.test(f))).sort();
  const scope =
    /--prefix\s+(\S+)/u.exec(contract.test)?.[1] ??
    /\bcd\s+(\S+)/u.exec(contract.test)?.[1];
  const dir = scope?.replace(/^\.\//u, '').replace(/\/$/u, '');
  const named = namedTests(contract.test, listed);
  const rank = (f: string) =>
    (named.matched.includes(f) ? 0 : 4) +
    (dir && f.startsWith(`${dir}/`) ? 0 : 2) +
    (/(?:^|\/)(?:tests?|__tests__)\//u.test(f) ? 0 : 1);
  return tests.sort((x, y) => rank(x) - rank(y));
}

/** What one broken test appends, by file kind; PHP's `?>` ends PHP mode when the file is still in it and is plain text when not. */
const BREAKAGE: [RegExp, string][] = [
  [/\.py$/u, '\nassert False, "krn canary"\n'],
  [/\.php$/u, '\n?>\n<?php throw new Exception("krn canary");\n'],
  [/\.go$/u, '\nfunc TestKrnCanary(t *testing.T) { t.Fatal("krn canary") }\n'],
  [/\.rs$/u, '\n#[test]\nfn krn_canary() {\n    panic!("krn canary");\n}\n'],
  [/\.[cm]?[jt]sx?$/u, '\nthrow new Error("krn canary");\n'],
];

const breakage = (file: string): string | undefined =>
  BREAKAGE.find(([kind]) => kind.test(file))?.[1];

/** What an install run reports: its exit status and output, or the error that kept it from running. */
export interface InstallRun {
  status: number | null;
  stdout?: string | null;
  stderr?: string | null;
  error?: Error | undefined;
}

/**
 * Dependencies for a worktree of `root`: link the root checkout's node_modules into each package
 * directory the tree tracks (with `ignoredOnly`, a link git would not ignore is removed again), else run the contract
 * install in the tree. A node_modules already in the tree counts as linked, so a rerun neither
 * installs through the link into the root nor repeats the install. A string is the failure.
 */
export function worktreeDependencies(
  root: string,
  tree: string,
  install: string | undefined,
  runInstall: (command: string) => InstallRun,
  ignoredOnly = false,
): string | undefined {
  const listed = spawnSync(
    'git',
    ['ls-files', '--', 'package.json', '**/package.json'],
    { cwd: tree, encoding: 'utf8' },
  );
  const dirs = (listed.status === 0 ? listed.stdout : '')
    .split('\n')
    .filter(Boolean)
    .map((f) => dirname(f));
  let linked = false;
  let bare = false;
  const made: string[] = [];
  for (const dir of new Set(dirs)) {
    const to = join(tree, dir, 'node_modules');
    if (existsSync(to)) {
      linked = true;
      continue;
    }
    const from = join(root, dir, 'node_modules');
    if (!existsSync(from)) {
      bare = true;
      continue;
    }
    symlinkSync(from, to);
    made.push(to);
    if (!ignoredOnly) {
      linked = true;
      continue;
    }
    // `node_modules/` in .gitignore matches a directory, not a link: an unignored link would dirty the tree.
    const ignored = spawnSync(
      'git',
      ['check-ignore', '-q', '--', join(dir, 'node_modules')],
      { cwd: tree },
    );
    if (ignored.status === 0) linked = true;
    else {
      rmSync(to);
      // A tree nested in the root still resolves the root's node_modules by walking up.
      if (dir === '.' && tree.startsWith(`${root}/`)) linked = true;
    }
  }
  // A package directory with no node_modules in either checkout still needs its install, even when
  // another one is linked; the install must not run through our own links into the root checkout.
  if (!install || (linked && !bare)) return undefined;
  for (const link of made) if (existsSync(link)) rmSync(link);
  const ran = runInstall(install);
  if (ran.status === 0) return undefined;
  const said =
    ran.error?.message ??
    `exit ${ran.status ?? 'signal'}: ${(ran.stderr || ran.stdout || '').trim().slice(-300)}`;
  return `the install command failed (${install}, ${said})`;
}

/** Dependencies for the temp worktree: link the clone's node_modules, else run the contract install. */
function prepare(
  root: string,
  tree: string,
  contract: RepoContract,
): string | undefined {
  return worktreeDependencies(root, tree, contract.install, (command) => {
    enter('install');
    return runOwn(root, tree, command);
  });
}

function stop(tree: string, baseGreen = false) {
  const env = {
    ...(baseGreen ? { KRN_BASE_GREEN: '1' } : {}),
    CLAUDE_PROJECT_DIR: tree,
    KRN_SESSION_CLASS: 'lane',
    KRN_LANE: 'canary',
    KRN_TEST_FIRST: '0',
    KRN_ACCEPTANCE_CLAUSES: '0',
  };
  const limits = {
    cwd: tree,
    input: '{}',
    encoding: 'utf8',
    env: { ...process.env, ...env },
    timeout: remaining(),
    killSignal: 'SIGKILL',
  } as const;
  const result = spawnSync(
    process.execPath,
    [productCli, 'hook', 'stop'],
    limits,
  );
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
  step = { name: 'setup', since: Date.now() };
  try {
    return canary(root);
  } catch (error) {
    if (!(error instanceof CanaryTimeout)) throw error;
    return {
      outcome: 'timeout',
      message: `the canary did not finish within ${Math.round(timeoutMs / 1000)}s: step "${step.name}" exceeded it after ${((Date.now() - step.since) / 1000).toFixed(1)}s; raise KRN_CANARY_TIMEOUT_MS, or pass --no-canary to decline`,
    };
  } finally {
    deadline = Number.POSITIVE_INFINITY;
  }
}

function redBase(
  contract: RepoContract,
  baseRef: string,
  own: { status: number | null; stderr: string; stdout: string },
): CanaryResult {
  return {
    outcome: 'red-base',
    message: `red base: the repository's own test command \`${contract.test}\` exits ${own.status} on the clean ${baseRef} tree, so the Stop gate cannot pass it; make it pass (install the dependencies) and rerun. ${(own.stderr || own.stdout).replace(/\s+/gu, ' ').trim().slice(-300)}`,
  };
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
  if (!stopCommands(root).some(isKrnStopCommand))
    return fail(
      'the Stop hook is not installed: .claude/settings.json has no Stop entry calling `krn hook stop`, so a broken test would not be refused',
    );
  // A vacuous contract carries a command that fails on purpose: the gate must refuse it until one real test exists.
  if (contract.vacuous === true) {
    const gate = stop(root);
    if (gate.status !== 2)
      return fail(
        `the Stop gate did not refuse the vacuous contract: expected exit 2, got ${gate.status}. ${gate.stderr.slice(-300)}`,
      );
    return {
      outcome: 'bootstrap',
      message:
        'bootstrap state: the contract is vacuous and the Stop gate refused it (exit 2); the first admitted task adds one real test and a test command',
    };
  }
  const ranked = testFiles(root, contract);
  const named = namedTests(contract.test, ranked);
  // A test command that names paths or globs runs only those files: breaking another file proves nothing.
  if (named.named && named.matched.length === 0)
    return fail(
      `the test command (${contract.test}) names test paths that match no tracked test file, so it runs no test and the Stop gate cannot refuse a broken one; add a test the command runs or fix the command`,
    );
  const files = (named.named ? named.matched : ranked).filter(
    (f) => breakage(f) !== undefined,
  );
  if (files.length === 0)
    return skipped('no test file the canary can break (js, ts, py, go, rs)');
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

    const wholeOnly = !contract.related;
    // The adoption files must not turn a test green on the clean base red: the suite runs once with them laid over
    // the base. Green there stands in for the clean-base run (one run, not two); red sends the clean base to the
    // same command, which tells a base that was already red from tests the adoption files broke.
    const adopted = withAdoptionFiles(root, parent, baseRef, contract);
    let baseChecked = false;
    if (adopted !== undefined) {
      enter('test command with the adoption files');
      const withFiles = runOwn(root, adopted, contract.test);
      if (withFiles.status === 0) baseChecked = true;
      else {
        enter('test command on the clean base');
        const own = runOwn(root, tree, contract.test);
        if (own.status !== 0) return redBase(contract, baseRef, own);
        const names = failedTestNames(
          `${withFiles.stdout}\n${withFiles.stderr}`,
        );
        return fail(
          `the adoption files turn the repository's own tests red: \`${contract.test}\` passes on the clean ${baseRef} tree and exits ${withFiles.status} with them; ${names.length > 0 ? `newly red: ${names.slice(0, 10).join('; ')}` : `no failed test name was readable in its output: ${(withFiles.stderr || withFiles.stdout).replace(/\s+/gu, ' ').trim().slice(-300)}`}`,
        );
      }
    }

    // Without a related command every Stop-gate step runs the whole test command, so a slow build would cost one
    // run per step. One measured baseline run of it on the clean tree replaces the gate's base run and the
    // clean-tree step; the broken-tree step is then the only gate run.
    if (wholeOnly && !baseChecked) {
      enter('test command on the clean base');
      const own = runOwn(root, tree, contract.test);
      if (own.status !== 0) return redBase(contract, baseRef, own);
    }

    // A test file the runner does not collect (another include pattern) cannot be refused: try the next.
    const tried: string[] = [];
    let refusedFile: string | undefined;
    let last: { status: number | null; stderr: string } | undefined;
    for (const file of files.slice(0, 3)) {
      enter('Stop gate on the broken test');
      appendFileSync(join(tree, file), breakage(file) as string);
      gitIn(tree, 'commit', '-qm', 'canary: break one test', '--', file);
      last = stop(tree, wholeOnly);
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
    if (wholeOnly)
      return {
        outcome: 'pass',
        message: `the Stop gate refused a broken ${file} (exit 2); the clean tree passed one run of the test command (${contract.test}), which stands in for the gate's clean-tree step`,
      };
    // The restored commit touches the same test file with a blank line, so the gate selects that test's related
    // subset; an empty commit selects nothing and the gate would run the whole (possibly unfinishable) test command.
    appendFileSync(join(tree, file), '\n');
    gitIn(tree, 'commit', '-qm', 'canary: clean tree', '--', file);
    enter('Stop gate on the clean tree');
    const clean = stop(tree);
    // A red base (the repository's own command fails on its clean tree: missing dependencies, a broken test)
    // is not a gate defect: name the command. The gate ignores failures the base already had, so the touched
    // test is also run by the command the gate selects for it, never the whole suite when a related one exists.
    const checkRedBase = () => {
      enter('test command on the clean base');
      const command =
        clean.status === 0
          ? relatedCommand(
              contract,
              withinPackage(contract.related ?? '', [file]),
            )
          : contract.test;
      const own = runOwn(root, tree, command);
      return own.status === 0 ? undefined : redBase(contract, baseRef, own);
    };
    const red = checkRedBase();
    if (red) return red;
    if (clean.status !== 0)
      return fail(
        `the Stop gate does not pass the clean tree after the canary was restored: exit ${clean.status}. ${clean.stderr.slice(-400)}`,
      );
    return {
      outcome: 'pass',
      message: `the Stop gate refused a broken ${file} (exit 2) and passed the restored tree (exit 0)`,
    };
  } finally {
    // Cleanup ignores the deadline: a timed-out canary still removes its worktree.
    spawnSync('git', ['worktree', 'remove', '--force', tree], { cwd: root });
    spawnSync(
      'git',
      ['worktree', 'remove', '--force', join(parent, 'with-adoption')],
      {
        cwd: root,
      },
    );
    spawnSync('git', ['branch', '-D', branch], { cwd: root });
    rmSync(parent, { recursive: true, force: true });
  }
}
