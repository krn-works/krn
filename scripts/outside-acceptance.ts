import { spawnSync } from 'node:child_process';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import {
  BOOTSTRAP_TASK_TITLE,
  GREEN_BASE_TASK_TITLE,
} from '../src/adopt/adopt.ts';
import { namedTests } from '../src/adopt/canary.ts';
import { appendExposure, readExposures } from '../src/brain/exposures.ts';
import { harvestCandidates, renderHarvest } from '../src/brain/proposals.ts';
import { parseUnified } from '../src/brain/record.ts';
import { readProposals, repositoryRoot } from '../src/brain/standards-cli.ts';
import { appCredentialArgs } from '../src/cli/outside-git.ts';
import {
  failureArgs,
  promoteCandidates,
  proposeArgs,
  refusedRecords,
} from './lib/outside-harvest.ts';

// One command reruns the outside acceptance: for each scratch copy it pushes a fresh orphan base
// outside/<stack> to krn-works/krn, adopts, drains the ready tasks unattended, appends one graded
// row to the summary and always deletes the branch. The logic up to main() is pure and tested.

/** The repository a row's scratch copy is pushed to unless `--repo STACK=OWNER/NAME` names another. */
export const defaultRepo = 'krn-works/krn';

/** The `OWNER/NAME` of a `--repo` value, refused unless it is a plain GitHub repository name. */
export function repoName(text: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9._-]+$/u.test(text))
    throw new Error(`outside-acceptance: bad repository name: ${text}`);
  return text;
}

/** The repository a stack's row pushes to: its `--repo` choice, else the default. */
export function repoFor(
  repos: Readonly<Record<string, string>> | undefined,
  stack: string,
): string {
  return repos?.[stack] ?? defaultRepo;
}

export const repoUrl = (repo: string): string =>
  `https://github.com/${repo}.git`;
export const summaryHeader =
  'repo/branch | stack | adopt exit | first-test PR | drain exit | PRs (all merged) | sessions (approx) | USD (approx) | hidden | hook | cases | suite regressions | stop refusals | turns';
const defaultStacks = ['php', 'npm', 'py'];

export interface RunOptions {
  stacks: string[];
  /** Per-stack push target, OWNER/NAME; a stack without one pushes to the default repository. */
  repos: Record<string, string>;
  scratch: string;
  max: number;
  windowHours: number;
  summary: string;
  /** A task file of fixed-issue rows, each graded by its held-back upstream test. */
  taskFile?: string;
  /** Where the harvest over the row checkouts is written. */
  harvest: string;
  /** How many times each row runs, serially, each from a fresh clone. */
  reps: number;
}

/** The only branches this script may push or delete: orphan bases outside/<stack>. */
export function outsideBranch(stack: string): string {
  if (!/^[a-z][a-z0-9-]*$/u.test(stack))
    throw new Error(`outside-acceptance: bad stack name: ${stack}`);
  return `outside/${stack}`;
}

/** The default scratch root: KRN_OUTSIDE_SCRATCH, else krn-outside in the system temp dir. */
export function defaultScratch(env: NodeJS.ProcessEnv = process.env): string {
  return env.KRN_OUTSIDE_SCRATCH || join(tmpdir(), 'krn-outside');
}

export function parseOptions(
  args: string[],
  root: string,
  scratch = defaultScratch(),
): RunOptions {
  const options: RunOptions = {
    stacks: [],
    scratch,
    max: 1,
    windowHours: 8,
    summary: join(root, '.krn/runs/outside/summary.txt'),
    harvest: join(root, '.krn/runs/outside/harvest.txt'),
    reps: 1,
    repos: {},
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] as string;
    const value = (): string => {
      const text = args[++index];
      if (text === undefined)
        throw new Error(`outside-acceptance: ${arg} requires a value`);
      return text;
    };
    if (arg === '--stack') {
      const stack = value();
      outsideBranch(stack);
      options.stacks.push(stack);
    } else if (arg === '--scratch') options.scratch = resolve(value());
    else if (arg === '--repo') {
      const text = value();
      const at = text.indexOf('=');
      if (at < 1)
        throw new Error('outside-acceptance: --repo needs STACK=OWNER/NAME');
      const stack = text.slice(0, at);
      outsideBranch(stack);
      options.repos[stack] = repoName(text.slice(at + 1));
    } else if (arg === '--summary') options.summary = resolve(value());
    else if (arg === '--harvest') options.harvest = resolve(value());
    else if (arg === '--task-file') options.taskFile = resolve(value());
    else if (arg === '--window-hours') {
      const text = value();
      if (!/^[1-9]\d*$/u.test(text))
        throw new Error(
          'outside-acceptance: --window-hours needs a positive integer',
        );
      options.windowHours = Number(text);
    } else if (arg === '--max') {
      const text = value();
      if (!/^[1-9]\d*$/u.test(text))
        throw new Error('outside-acceptance: --max needs a positive integer');
      options.max = Number(text);
    } else if (arg === '--reps') {
      const text = value();
      if (!/^[1-9]\d*$/u.test(text))
        throw new Error('outside-acceptance: --reps needs a positive integer');
      options.reps = Number(text);
    } else throw new Error(`outside-acceptance: unknown argument ${arg}`);
  }
  if (options.stacks.length === 0) options.stacks = [...defaultStacks];
  return options;
}

/** The orphan base is the parent of the adopt commit of a scratch copy's history (newest first). */
export function baseCommit(
  log: ReadonlyArray<{
    sha: string;
    parent: string | undefined;
    subject: string;
  }>,
): string {
  const adopt = log.find((entry) =>
    entry.subject.startsWith('chore: adopt krn'),
  );
  if (adopt === undefined)
    throw new Error(
      'outside-acceptance: no "chore: adopt krn" commit in scratch history',
    );
  if (adopt.parent === undefined)
    throw new Error('outside-acceptance: the adopt commit has no parent base');
  return adopt.parent;
}

export interface AdoptFlags {
  base?: string;
  test?: string;
  /** The base's existing suite, run on the worker's merged tree before the hidden files return: its failures are regressions. */
  suite?: string;
  install?: string;
  related?: string;
}

/** The `krn adopt` argument list for a scratch copy's krn.json (only the keys adopt accepts). */
export function adoptArgs(dir: string, config: AdoptFlags): string[] {
  const args = ['adopt', dir, '--tracker'];
  if (config.test !== undefined) args.push('--test', config.test);
  return args;
}

export interface DrainFacts {
  exitCode: number;
  sessions: number;
  merged: number;
  prs: string[];
  usd: number;
  turns: number;
}

/** Read the drain's output: one `<id> <id> exit=N` line per session, shipped PR numbers and cost. */
export function drainFacts(exitCode: number, output: string): DrainFacts {
  const lines = output.split('\n');
  const sessions = lines.filter((line) =>
    /^t-\w+ t-\w+ exit=\d+/u.test(line),
  ).length;
  // The drain prints the lane's verdict line: `lane <id>: shipped verdict: merged <sha> model ...`.
  const shas = [
    ...output.matchAll(/\bverdict: merged ([0-9a-f]{7,40})\b/gu),
  ].map((match) => (match[1] as string).slice(0, 7));
  const merged = shas.length;
  const prs: string[] = [];
  for (const match of output.matchAll(/(?:pull\/|PR #|pr #)(\d+)/gu)) {
    const pr = `#${match[1]}`;
    if (!prs.includes(pr)) prs.push(pr);
  }
  // A merge verdict names a commit, not a PR: the commit stands for its PR when no number is printed.
  if (prs.length === 0) prs.push(...shas);
  let usd = 0;
  for (const match of output.matchAll(/cost \$(\d+(?:\.\d+)?)/gu))
    usd += Number(match[1]);
  let turns = 0;
  for (const match of output.matchAll(/\bturns (\d+)/gu))
    turns += Number(match[1]);
  return {
    exitCode,
    sessions,
    merged,
    prs,
    usd: Math.round(usd * 100) / 100,
    turns,
  };
}

/** Passed and total test cases a runner printed: pytest, TAP or node:test, or the PHP shim's `ran N, failed M`. */
export interface CaseCounts {
  passed: number;
  total: number;
}

export function caseCounts(output: string): CaseCounts | undefined {
  const count = (pattern: RegExp): number | undefined => {
    const found = pattern.exec(output)?.[1];
    return found === undefined ? undefined : Number(found);
  };
  const shim = /ran (\d+), failed (\d+)/u.exec(output);
  if (shim) {
    const total = Number(shim[1]);
    return { passed: total - Number(shim[2]), total };
  }
  const tapPass = count(/^# pass (\d+)/mu);
  if (tapPass !== undefined) {
    const failed = count(/^# fail (\d+)/mu) ?? 0;
    return { passed: tapPass, total: tapPass + failed };
  }
  const summary = /^=+ (.*?) in [\d.]+s/mu.exec(output)?.[1] ?? output;
  const passed = Number(/(\d+) passed/u.exec(summary)?.[1] ?? 0);
  const failed =
    Number(/(\d+) failed/u.exec(summary)?.[1] ?? 0) +
    Number(/(\d+) errors?/u.exec(summary)?.[1] ?? 0);
  return passed + failed === 0 ? undefined : { passed, total: passed + failed };
}

/**
 * The names of the cases a runner reported failing: pytest `FAILED path::name - reason` (a parametrize
 * suffix is kept), TAP `not ok N - name` and the PHP shim's `FAIL T::name #n`. Each name appears once.
 */
export function failedCases(output: string): string[] {
  const names = new Set<string>();
  for (const line of output.split('\n')) {
    const found =
      /^(?:FAILED|ERROR) (\S+?::\S+?)(?: - .*)?$/u.exec(line)?.[1] ??
      /^not ok \d+ - (.+)$/u.exec(line)?.[1] ??
      /^FAIL (\S+) #\d+/u.exec(line)?.[1];
    if (found !== undefined) names.add(found.replace(/^.*::/u, ''));
  }
  return [...names];
}

/** The graded measures of a fixed-issue row beyond pass or fail. */
export interface RowMetrics {
  cases?: CaseCounts | undefined;
  /** Existing-suite cases (or one for a red run without counts) failing on the merged tree before the hidden test is restored. */
  regressions: number | undefined;
  /** Distinct records the Stop gate refused. */
  refusals: number;
  /** Names of the hidden cases that failed on the merged tree. */
  failed?: string[];
}

/** The summary cells of the graded measures: `cases P/T | regressions N | refusals N | turns N`. */
export function metricsCells(
  metrics: RowMetrics,
  turns: number | undefined,
): string[] {
  return [
    metrics.cases === undefined
      ? 'none'
      : `${metrics.cases.passed}/${metrics.cases.total}`,
    metrics.regressions === undefined ? 'none' : String(metrics.regressions),
    String(metrics.refusals),
    turns === undefined ? 'none' : String(turns),
  ];
}

export interface RowInput {
  stack: string;
  /** The repository the row ran on; the default when absent. */
  repo?: string;
  adoptExit: number;
  firstPr: string;
  drain: DrainFacts | undefined;
  hidden?: HiddenResult;
  metrics?: RowMetrics;
  /** The krn commit the row's hooks ran, against the checkout HEAD it must equal. */
  hook?: { commit: string | undefined; head: string };
  note?: string;
}

/**
 * The bin directory of the newest Go toolchain mise has installed, or undefined: a host with several installed
 * versions and none selected makes the `go` shim fail, so a Go row puts the toolchain itself on PATH.
 */
export function goToolchainBin(
  installs: string,
  has: (path: string) => boolean = existsSync,
  list: (path: string) => string[] = (path) => readdirSync(path),
): string | undefined {
  const root = join(installs, 'go');
  let versions: string[];
  try {
    versions = list(root);
  } catch {
    return undefined;
  }
  const newest = versions
    .filter((name) => /^\d+\.\d+\.\d+$/u.test(name))
    .sort((a, b) => a.localeCompare(b, 'en', { numeric: true }))
    .at(-1);
  const bin = newest === undefined ? undefined : join(root, newest, 'bin');
  return bin !== undefined && has(join(bin, 'go')) ? bin : undefined;
}

/** Where mise keeps installed tool versions on this host. */
function miseInstalls(): string {
  return (
    process.env.MISE_DATA_DIR ??
    join(process.env.HOME ?? '', '.local/share/mise')
  ).concat('/installs');
}

/** PATH with the checkout's bin/ first, so the `krn` that hooks and lanes call by name is the checkout's own. */
export function hookPath(root: string, pathEnv: string | undefined): string {
  return [join(root, 'bin'), ...(pathEnv ? [pathEnv] : [])].join(delimiter);
}

/** A row's adopted registry is a scratch file, never the host's `~/.krn/adopted.json`. */
export function scratchRegistryEnv(scratch: string): {
  KRN_ADOPTED_REGISTRY: string;
} {
  return { KRN_ADOPTED_REGISTRY: join(scratch, 'registry.json') };
}

/**
 * The environment of `krn adopt`: the test-first arm applies to the worker's session, not to the
 * canary, whose clean tree changes no test and would be refused by the test-first Stop check.
 */
export function adoptEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const { KRN_TEST_FIRST: _arm, ...rest } = env;
  return rest;
}

/**
 * The commit of the tree whose `krn` a hook command resolves by name under `env`: the tree the session's
 * Stop hook (`exec krn hook stop`) runs. `krn doctor` is no measure: it reports the host's configured
 * product entry, whichever tree runs it.
 */
export function hookTreeCommit(
  env: NodeJS.ProcessEnv,
  cwd: string,
): string | undefined {
  const found = spawnSync('sh', ['-c', 'command -v krn'], {
    cwd,
    encoding: 'utf8',
    env,
  });
  if (found.status !== 0) return undefined;
  let tree: string;
  try {
    tree = dirname(dirname(realpathSync(found.stdout.trim())));
  } catch {
    return undefined;
  }
  const head = run('git', ['rev-parse', 'HEAD'], tree);
  return head.status === 0 ? head.output.trim() : undefined;
}

/** The commit a krn entry reports in `krn doctor` output (`entry-commit=<sha>`), if it reports one. */
export function entryCommit(doctorOutput: string): string | undefined {
  const sha = /^entry-commit=([0-9a-f]{40})$/mu.exec(doctorOutput)?.[1];
  return sha;
}

/** The summary cell for the hook commit: it names a skew when the hook is not the checkout HEAD. */
export function hookCell(hook: RowInput['hook']): string {
  if (hook === undefined) return 'none';
  const short = (sha: string | undefined) => sha?.slice(0, 7) ?? 'unknown';
  return hook.commit === hook.head
    ? short(hook.commit)
    : `skew ${short(hook.commit)} != ${short(hook.head)}`;
}

/** The held-back upstream test on the merged tree: it passed, failed, or the row has none. */
export type HiddenResult = 'pass' | 'fail' | 'none';

/** One graded summary row; the PR cell says whether every listed PR merged. */
export function gradedRow(input: RowInput): string {
  const { stack, adoptExit, firstPr, drain } = input;
  const green =
    drain !== undefined &&
    drain.exitCode === 0 &&
    drain.prs.length > 0 &&
    drain.merged >= drain.prs.length;
  const prs =
    drain === undefined || drain.prs.length === 0
      ? 'none'
      : `${drain.prs.join(' ')} (${green ? 'all merged' : `${drain.merged} merged`})`;
  const cells = [
    `${input.repo ?? defaultRepo} ${outsideBranch(stack)}`,
    stack,
    String(adoptExit),
    firstPr,
    drain === undefined ? 'not run' : String(drain.exitCode),
    prs,
    drain === undefined ? '0' : String(drain.sessions),
    `$${(drain?.usd ?? 0).toFixed(2)}`,
    input.hidden ?? 'none',
    hookCell(input.hook),
    ...(input.metrics === undefined
      ? []
      : metricsCells(input.metrics, drain?.turns)),
  ];
  const failed = input.metrics?.failed;
  if (failed !== undefined && failed.length > 0)
    cells.push(`failed ${failed.join(' ')}`);
  const row = cells.join(' | ');
  return input.note === undefined ? row : `${row} | ${input.note}`;
}

/** A fixed-issue row: a small real upstream bug, its base the parent of the fix commit. */
export interface HiddenRow {
  stack: string;
  upstream: string;
  license: string;
  fix: string;
  title: string;
  body: string[];
  /** Upstream files the fix commit's test touches: held back from the base, restored from the fix after the drain. */
  hidden: string[];
  /** Run in the merged tree after the hidden files are restored; exit 0 is a pass. KRN_ROOT names this repository. */
  hiddenVerify: string;
  test?: string;
  /** The base's existing suite, run on the worker's merged tree before the hidden files return: its failures are regressions. */
  suite?: string;
  install?: string;
  /** The related-test command (with {files}) the Stop gate runs, when detection would pick one the host cannot run. */
  related?: string;
  /** Files copied from this repository into the base (target path to source path), e.g. a test runner the stack lacks. */
  support?: Record<string, string>;
  /** The base's own test command is red: the row's task is the green-base task, the one task a red baseline admits. */
  redBase?: boolean;
}

/** The workflow files of a base: a GitHub App cannot push them, and adoption writes its own CI call. */
export function workflowFiles(files: readonly string[]): string[] {
  return files.filter((file) => file.startsWith('.github/workflows/'));
}

/** Read and check a task file: `{ "rows": [ ... ] }`; any malformed row is refused before anything is pushed. */
export function parseTaskFile(text: string): HiddenRow[] {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error('outside-acceptance: the task file is not JSON');
  }
  const rows =
    typeof data === 'object' && data !== null
      ? Reflect.get(data, 'rows')
      : undefined;
  if (!Array.isArray(rows) || rows.length === 0)
    throw new Error('outside-acceptance: the task file needs a "rows" array');
  return rows.map((raw: unknown, index) => {
    const field = (key: string): unknown =>
      typeof raw === 'object' && raw !== null
        ? Reflect.get(raw, key)
        : undefined;
    const text = (key: string, optional = false): string => {
      const value = field(key);
      if (typeof value === 'string' && value.trim() !== '') return value;
      if (optional && value === undefined) return '';
      throw new Error(`outside-acceptance: row ${index} needs "${key}"`);
    };
    const list = (key: string): string[] => {
      const value = field(key);
      if (
        !Array.isArray(value) ||
        value.length === 0 ||
        value.some((item) => typeof item !== 'string' || item.trim() === '')
      )
        throw new Error(
          `outside-acceptance: row ${index} needs "${key}" as a list of strings`,
        );
      return value as string[];
    };
    const stack = text('stack');
    outsideBranch(stack);
    const fix = text('fix');
    if (!/^[0-9a-f]{7,40}$/u.test(fix))
      throw new Error(`outside-acceptance: row ${index} "fix" is not a commit`);
    const hidden = list('hidden');
    for (const path of hidden)
      if (path.startsWith('/') || path.split('/').includes('..'))
        throw new Error(
          `outside-acceptance: row ${index} hidden path ${path} leaves the repository`,
        );
    const upstream = text('upstream');
    const row: HiddenRow = {
      stack,
      upstream,
      license: text('license'),
      fix,
      title: text('title'),
      body: list('body'),
      hidden,
      hiddenVerify: text('hiddenVerify'),
    };
    const test = text('test', true);
    if (test !== '') row.test = test;
    const install = text('install', true);
    if (install !== '') row.install = install;
    const related = text('related', true);
    if (related !== '') row.related = related;
    const suite = text('suite', true);
    if (suite !== '') row.suite = suite;
    if (field('redBase') === true) row.redBase = true;
    const support = field('support');
    if (support !== undefined) {
      if (typeof support !== 'object' || support === null)
        throw new Error(
          `outside-acceptance: row ${index} "support" is not a map`,
        );
      for (const [target, from] of Object.entries(support))
        if (
          typeof from !== 'string' ||
          [target, from].some(
            (path) => path.startsWith('/') || path.split('/').includes('..'),
          )
        )
          throw new Error(
            `outside-acceptance: row ${index} support path leaves the repository`,
          );
      row.support = support as Record<string, string>;
    }
    const refusal = publishRefusal(
      JSON.stringify({ url: upstream, license: row.license }),
      'public',
    );
    if (refusal !== undefined)
      throw new Error(`outside-acceptance: row ${index}: ${refusal}`);
    return row;
  });
}

/** The held-back test grades the merged tree: its exit code is the verdict. */
export function hiddenResult(exitCode: number | undefined): HiddenResult {
  return exitCode === undefined ? 'none' : exitCode === 0 ? 'pass' : 'fail';
}

/** A summary row is green when the drain exits 0 with every PR merged and any hidden test passes. */
export function rowGreen(row: string): boolean {
  return (
    !/\| skew /u.test(row) &&
    /\| 0 \| [^|]*\(all merged\) \| [^|]* \| [^|]* \| (?:pass|none)(?: \||$)/u.test(
      row,
    ) &&
    !/\| fail(?: \||$)/u.test(row)
  );
}

/** The task a fixed-issue row seeds: the upstream bug in words, acceptance the row's own test command. */
export function hiddenSeedTask(
  row: HiddenRow,
  created: string,
): { file: string; text: string } {
  const seed = seedTask(row.stack, row.test, created);
  const task = JSON.parse(seed.text) as Record<string, unknown>;
  task.title = row.redBase === true ? GREEN_BASE_TASK_TITLE : row.title;
  task.body = row.redBase === true ? [row.title, ...row.body] : row.body;
  return { file: seed.file, text: `${JSON.stringify(task, null, 2)}\n` };
}

/**
 * The one real small task each drain delivers. Adopt seeds only gap tasks at priority 1 and 2, which
 * ask for CI workflows and settings an outside base cannot take, so the drain needs its own at priority 0.
 */
export function seedTask(
  stack: string,
  test: string | undefined,
  created: string,
  bootstrap = false,
): { file: string; text: string } {
  const id = `t-${Math.abs(
    [...`${stack}${created}`].reduce(
      (hash, char) => (hash * 31 + char.charCodeAt(0)) | 0,
      7,
    ),
  )
    .toString(36)
    .padStart(7, '0')
    .slice(0, 7)}`;
  const verify = test ?? 'true';
  const task = {
    id,
    status: 'open',
    resolution: null,
    created,
    priority: 0,
    title: bootstrap
      ? BOOTSTRAP_TASK_TITLE
      : `Add a focused ${stack} test for one untested function`,
    after: [] as string[],
    body: bootstrap
      ? [
          'Outcome: the repository has one real test and a test command in krn.json that runs it; "vacuous" is dropped from krn.json.',
          'Why: the base declares no test command, and lane run admits only this task on it.',
          'Proof: the test command exits 0 and runs at least one test.',
        ]
      : [
          `Add one focused test for one untested public function (the smallest one); keep \`${verify}\` green. No other change.`,
        ],
    acceptance: [{ verify, passes: false, exit: null }],
  };
  return {
    file: `tasks/${id}.json`,
    text: `${JSON.stringify(task, null, 2)}\n`,
  };
}

/** The krn.json keys adopt has no flag for, plus the base: the orphan branch the drain delivers to. */
export function pick(config: AdoptFlags, branch: string): AdoptFlags {
  const kept: AdoptFlags = { base: branch };
  if (config.install !== undefined) kept.install = config.install;
  if (config.related !== undefined) kept.related = config.related;
  return kept;
}

export const run = (
  command: string,
  args: string[],
  cwd: string,
  env?: NodeJS.ProcessEnv,
): { status: number; output: string } => {
  const result = spawnSync(command, args, {
    cwd,
    ...(env === undefined ? {} : { env }),
    encoding: 'utf8',
    maxBuffer: 1 << 28,
  });
  return {
    status: result.status ?? 70,
    output: `${result.stdout ?? ''}${result.stderr ?? ''}`,
  };
};

/**
 * Whether a scratch copy may be pushed to the remote: a private remote takes any copy; a public (or unknown)
 * remote takes only a copy whose UPSTREAM.json names a public https upstream and an open licence, so an
 * operator or client repository never reaches a public repository. A string is the refusal.
 */
export function publishRefusal(
  manifestText: string | undefined,
  visibility: string | undefined,
): string | undefined {
  if (visibility === 'private') return undefined;
  const remote = `the remote is ${visibility ?? 'of unknown visibility'}`;
  if (manifestText === undefined)
    return `${remote} and the scratch copy has no UPSTREAM.json naming its public upstream and licence; refusing to push`;
  let manifest: unknown;
  try {
    manifest = JSON.parse(manifestText);
  } catch {
    return `${remote} and UPSTREAM.json is not JSON; refusing to push`;
  }
  const field = (key: string): unknown =>
    typeof manifest === 'object' && manifest !== null
      ? Reflect.get(manifest, key)
      : undefined;
  const url = field('url');
  const license = field('license');
  if (typeof url !== 'string' || !/^https:\/\/\S+$/u.test(url))
    return `${remote} and UPSTREAM.json has no https "url" of a public upstream; refusing to push`;
  if (
    typeof license !== 'string' ||
    license.trim() === '' ||
    /^(?:unlicensed|proprietary|none)$/iu.test(license.trim())
  )
    return `${remote} and UPSTREAM.json has no open "license"; refusing to push`;
  return undefined;
}

/**
 * The visibility GitHub reports for the remote repository, undefined when it cannot be read. The App token
 * is minted for the row's own repository (not the repository of the current directory), so a private row
 * repository is visible to the lookup.
 */
export function remoteVisibility(
  root: string,
  repo: string,
  exec: typeof run = run,
): string | undefined {
  const result = exec(
    'gh',
    ['api', `repos/${repo}`, '--jq', '.visibility'],
    root,
    { ...process.env, KRN_APP_REPOSITORY: repo },
  );
  const value = result.output.trim();
  return result.status === 0 && value !== '' ? value : undefined;
}

/**
 * git `-c` arguments for the host's own seed pushes: the operator's GitHub login through gh, which carries
 * the `workflow` scope a GitHub App lacks. The token is never in the arguments.
 */
export function hostCredentialArgs(): string[] {
  const key = 'credential.https://github.com.helper';
  return [
    '-c',
    'credential.helper=',
    '-c',
    `${key}=`,
    '-c',
    `${key}=!/usr/bin/gh auth git-credential`,
  ];
}

/**
 * The credential arguments of a row push: the seed push (the base and the adopt commit that carries the
 * host-written CI workflow) uses the host login, and only for a private remote; every other push, and any
 * push to a public or unknown remote, keeps the repository's App token.
 */
export function rowCredentialArgs(
  repo: string,
  visibility: string | undefined,
  seed: boolean,
): string[] {
  return seed && visibility === 'private'
    ? hostCredentialArgs()
    : appCredentialArgs(repo);
}

const packFile = (root: string): string => join(root, 'standards/records.json');

/** Copies a row's exposures into the host log and turns its Stop refusals into proposals in the row checkout. */
function collectRow(
  dir: string,
  stack: string,
  krn: string,
  root: string,
  failures: string[][] = [],
): void {
  const exposures = readExposures(dir);
  for (const exposure of exposures) appendExposure(root, exposure);
  const pack = parseUnified(JSON.parse(readFileSync(packFile(root), 'utf8')));
  for (const args of [
    ...proposeArgs(refusedRecords(exposures), pack, stack),
    ...failures,
  ])
    run(krn, [...args, '--root', dir], dir);
}

/** The summary row of a stack whose run threw: it names the repository the row was pushing to. */
export function failedRow(
  stack: string,
  repos: Readonly<Record<string, string>> | undefined,
  error: unknown,
): string {
  return gradedRow({
    repo: repoFor(repos, stack),
    stack,
    adoptExit: 1,
    firstPr: 'none',
    drain: undefined,
    note: error instanceof Error ? error.message : String(error),
  });
}

/**
 * Removes the row directories this invocation created. Another invocation sharing the scratch
 * directory keeps its own rows: wiping the whole `runs` directory pulled a running row's clone
 * and lane worktree out from under it.
 */
export function sweepOwnedRows(owned: readonly string[]): void {
  for (const dir of owned) rmSync(dir, { recursive: true, force: true });
}

/** The harvest over the row checkouts: its report lines, with every promotable pack record marked harvested. */
export function harvestRows(
  checkouts: readonly string[],
  root: string,
): string[] {
  // A row whose clone is gone or never became a git repository has nothing to harvest; it is reported, not fatal.
  const skipped: string[] = [];
  const usable = checkouts.filter((dir) => {
    try {
      repositoryRoot(dir);
      return true;
    } catch (error) {
      skipped.push(
        `skipped: ${dir} (${error instanceof Error ? error.message : String(error)})`,
      );
      return false;
    }
  });
  const sourced = usable.flatMap((dir) => readProposals(repositoryRoot(dir)));
  const candidates = harvestCandidates(sourced);
  const pack = parseUnified(JSON.parse(readFileSync(packFile(root), 'utf8')));
  const { pack: next, promoted } = promoteCandidates(pack, candidates);
  if (promoted.length > 0)
    writeFileSync(packFile(root), `${JSON.stringify(next, null, 2)}\n`);
  return [
    ...skipped,
    ...renderHarvest(candidates, usable.length),
    `promoted: ${promoted.join(', ') || 'none'}`,
  ];
}

/**
 * The remote lane branches a row's clone owns: a task id of the clone that is also a head on the remote
 * and whose history starts at this row's orphan base. A lane branch left by an earlier run of the same row
 * has the same name (the ids are deterministic) and would make the next push non-fast-forward.
 */
export function ownedLaneBranches(
  taskIds: string[],
  remoteHeads: string[],
  rootSubject: (branch: string) => string | undefined,
  stack: string,
): string[] {
  return taskIds.filter(
    (id) =>
      remoteHeads.includes(id) &&
      rootSubject(id) === `chore: orphan base for ${stack}`,
  );
}

/** Writes the seed task into the row clone; adopt may have left no tasks/ directory, so it is created. */
export function writeSeedTask(
  dir: string,
  seed: { file: string; text: string },
): void {
  const path = join(dir, seed.file);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, seed.text);
}

function acceptStack(
  stack: string,
  options: RunOptions,
  root: string,
  hiddenRow?: HiddenRow,
  checkouts: string[] = [],
  owned: string[] = [],
): string {
  const branch = outsideBranch(stack);
  const repo = repoFor(options.repos, stack);
  const source = hiddenRow
    ? join(options.scratch, 'runs', `${stack}-upstream-${Date.now()}`)
    : join(options.scratch, stack);
  if (hiddenRow) owned.push(source);
  if (hiddenRow) {
    mkdirSync(dirname(source), { recursive: true });
    const cloned = run(
      'git',
      ['clone', '--quiet', hiddenRow.upstream, source],
      options.scratch,
    );
    if (cloned.status !== 0)
      throw new Error(
        `outside-acceptance: ${stack}: clone of ${hiddenRow.upstream} failed: ${cloned.output.trim()}`,
      );
  } else if (!existsSync(source))
    throw new Error(
      `outside-acceptance: no scratch copy ${source}; pass --scratch DIR or set KRN_OUTSIDE_SCRATCH to the directory holding the ${stack} copy`,
    );
  const dir = join(options.scratch, 'runs', `${stack}-${Date.now()}`);
  owned.push(dir);
  const krn = join(root, 'bin/krn');
  const rowEnv = {
    ...process.env,
    PATH: hookPath(
      root,
      [goToolchainBin(miseInstalls()), process.env.PATH]
        .filter((part): part is string => part !== undefined)
        .join(delimiter),
    ),
    KRN_APP_REPOSITORY: repo,
    ...scratchRegistryEnv(options.scratch),
  };
  const git = (args: string[], cwd = dir) =>
    run('git', [...appCredentialArgs(repo), ...args], cwd);
  const visibility = remoteVisibility(root, repo);
  const seedGit = (args: string[]) =>
    run('git', [...rowCredentialArgs(repo, visibility, true), ...args], dir);
  if (!existsSync(join(source, '.git')))
    throw new Error(
      `outside-acceptance: no scratch copy at ${source} (pass --scratch or KRN_OUTSIDE_SCRATCH)`,
    );
  const manifestPath = join(source, 'UPSTREAM.json');
  const refusal = publishRefusal(
    hiddenRow
      ? JSON.stringify({ url: hiddenRow.upstream, license: hiddenRow.license })
      : existsSync(manifestPath)
        ? readFileSync(manifestPath, 'utf8')
        : undefined,
    visibility,
  );
  if (refusal !== undefined)
    throw new Error(`outside-acceptance: ${stack}: ${refusal}`);
  const log = run('git', ['log', '--format=%H %P|%s'], source)
    .output.split('\n')
    .filter(Boolean)
    .map((line) => {
      const [head = '', subject = ''] = line.split('|');
      const [sha = '', parent] = head.split(' ');
      return { sha, parent: parent || undefined, subject };
    });
  const base = hiddenRow
    ? run('git', ['rev-parse', `${hiddenRow.fix}^`], source).output.trim()
    : baseCommit(log);
  if (!/^[0-9a-f]{40}$/u.test(base))
    throw new Error(
      `outside-acceptance: ${stack}: no parent of the fix commit`,
    );
  let pushed = false;
  const dropOwnedLaneBranches = (): void => {
    const tasksDir = join(dir, 'tasks');
    if (!existsSync(tasksDir)) return;
    const ids = readdirSync(tasksDir)
      .filter((name) => name.endsWith('.json'))
      .map((name) => name.slice(0, -'.json'.length));
    const heads = git(['ls-remote', '--heads', 'origin'])
      .output.split('\n')
      .map((line) => line.split('\t')[1]?.replace('refs/heads/', ''))
      .filter((name): name is string => name !== undefined);
    const owned = ownedLaneBranches(
      ids,
      heads,
      (id) => {
        if (git(['fetch', '--quiet', 'origin', id]).status !== 0)
          return undefined;
        return git(['log', '--format=%s', '--max-parents=0', 'FETCH_HEAD'])
          .output.trim()
          .split('\n')[0];
      },
      stack,
    );
    for (const id of owned) git(['push', 'origin', '--delete', id]);
  };
  try {
    mkdirSync(dirname(dir), { recursive: true });
    for (const step of [['clone', '--quiet', '--no-checkout', source, dir]])
      if (run('git', step, options.scratch).status !== 0)
        throw new Error('clone failed');
    git(['remote', 'set-url', 'origin', repoUrl(repo)]);
    git(['checkout', '--quiet', '-B', branch, base]);
    // The upstream's own branch names must not leak into adoption: it would pick the stale tip as the base.
    git(['branch', '-D', 'master', 'main']);
    git(['remote', 'set-head', 'origin', '--delete']);
    for (const file of workflowFiles(git(['ls-files']).output.split('\n')))
      git(['rm', '--quiet', '--force', '--', file]);
    for (const [target, from] of Object.entries(hiddenRow?.support ?? {})) {
      mkdirSync(dirname(join(dir, target)), { recursive: true });
      writeFileSync(join(dir, target), readFileSync(join(root, from)));
      git(['add', '--', target]);
    }
    // An orphan checkout keeps the base tree in the index; the commit has no parent.
    git(['checkout', '--quiet', '--orphan', `${branch}-orphan`]);
    git(['commit', '--quiet', '-m', `chore: orphan base for ${stack}`]);
    git(['branch', '-M', branch]);
    pushed =
      seedGit(['push', '--force', 'origin', `${branch}:refs/heads/${branch}`])
        .status === 0;
    if (!pushed) throw new Error('push of the orphan base failed');
    let config: AdoptFlags = {};
    const configPath = join(source, 'krn.json');
    if (hiddenRow) {
      if (hiddenRow.test !== undefined) config.test = hiddenRow.test;
      if (hiddenRow.install !== undefined) config.install = hiddenRow.install;
      if (hiddenRow.related !== undefined) config.related = hiddenRow.related;
    } else if (existsSync(configPath))
      config = JSON.parse(readFileSync(configPath, 'utf8')) as AdoptFlags;
    // The test command is the delivery's own result when the base has no test file it names (the first task adds it):
    // adopt then detects the base's contract instead of being handed a command that runs nothing.
    const baseFiles = git(['ls-files']).output.split('\n');
    const named =
      config.test === undefined
        ? undefined
        : namedTests(config.test, baseFiles);
    const { test: _delivered, ...withoutTest } = config;
    const adoptConfig: AdoptFlags =
      named?.named && named.matched.length === 0 ? withoutTest : config;
    const adopt = run(krn, adoptArgs(dir, adoptConfig), dir, adoptEnv(rowEnv));
    const keep = (name: string, text: string) =>
      appendFileSync(
        join(dirname(options.summary), `${stack}.log`),
        `## ${name}\n${text}\n`,
      );
    keep('adopt', adopt.output);
    dropOwnedLaneBranches();
    // Adopt cannot take install or related without --ref: carry them from the scratch copy's krn.json.
    const clonePath = join(dir, 'krn.json');
    if (existsSync(clonePath))
      writeFileSync(
        clonePath,
        `${JSON.stringify({ ...JSON.parse(readFileSync(clonePath, 'utf8')), ...pick(config, branch) }, null, 2)}\n`,
      );
    // A vacuous base admits only the bootstrap task (it adds the first test); adopt seeds it only into a fresh tasks/.
    const vacuous =
      existsSync(clonePath) &&
      JSON.parse(readFileSync(clonePath, 'utf8')).vacuous === true;
    const created = new Date().toISOString().slice(0, 10);
    const seed = hiddenRow
      ? hiddenSeedTask(hiddenRow, created)
      : seedTask(stack, config.test, created, vacuous);
    writeSeedTask(dir, seed);
    git(['add', '-A']);
    git(['commit', '--quiet', '-m', 'chore: adopt krn']);
    seedGit(['push', 'origin', branch]);
    const drain = run(
      krn,
      [
        'lane',
        'run',
        '--ready',
        '--max',
        String(options.max),
        '--window-hours',
        String(options.windowHours),
      ],
      dir,
      rowEnv,
    );
    keep('drain', drain.output);
    let hidden: HiddenResult = 'none';
    let note: string | undefined;
    let metrics: RowMetrics | undefined;
    if (hiddenRow) {
      // The upstream fix's test files are restored over the merged tree, then run: the drain never saw them.
      git(['fetch', '--quiet', 'origin', branch]);
      git(['checkout', '--quiet', '--force', '--detach', 'FETCH_HEAD']);
      const merged = git(['rev-parse', 'HEAD']).output.trim().slice(0, 7);
      // The row's existing suite on the worker's tree, before any hidden file is restored.
      const suite = hiddenRow.suite
        ? spawnSync('sh', ['-c', hiddenRow.suite], {
            cwd: dir,
            encoding: 'utf8',
            env: { ...rowEnv, KRN_ROOT: root },
            maxBuffer: 1 << 28,
          })
        : undefined;
      const suiteCases = caseCounts(
        `${suite?.stdout ?? ''}${suite?.stderr ?? ''}`,
      );
      const regressions =
        suite === undefined
          ? undefined
          : suite.status === 0
            ? 0
            : suiteCases === undefined
              ? 1
              : suiteCases.total - suiteCases.passed || 1;
      for (const path of hiddenRow.hidden) {
        const shown = run('git', ['show', `${hiddenRow.fix}:${path}`], source);
        if (shown.status !== 0)
          throw new Error(
            `outside-acceptance: ${stack}: ${path} not in the fix`,
          );
        mkdirSync(dirname(join(dir, path)), { recursive: true });
        writeFileSync(join(dir, path), shown.output);
      }
      const graded = spawnSync('sh', ['-c', hiddenRow.hiddenVerify], {
        cwd: dir,
        encoding: 'utf8',
        env: { ...rowEnv, KRN_ROOT: root },
        maxBuffer: 1 << 28,
      });
      keep('hidden', `${graded.stdout ?? ''}${graded.stderr ?? ''}`);
      hidden = hiddenResult(graded.status ?? 70);
      metrics = {
        cases: caseCounts(`${graded.stdout ?? ''}${graded.stderr ?? ''}`),
        regressions,
        refusals: refusedRecords(readExposures(dir)).length,
      };
      const failedNames = failedCases(
        `${graded.stdout ?? ''}${graded.stderr ?? ''}`,
      );
      if (failedNames.length > 0) metrics.failed = failedNames;
      note = `merged ${merged} fix ${hiddenRow.fix.slice(0, 7)}`;
    }
    collectRow(
      dir,
      stack,
      krn,
      root,
      failureArgs(stack, hidden, drain.status ?? 70),
    );
    checkouts.push(dir);
    const hook = {
      commit: hookTreeCommit(rowEnv, dir),
      head: run('git', ['rev-parse', 'HEAD'], root).output.trim(),
    };
    keep('hook', `${hookCell(hook)}`);
    return gradedRow({
      repo,
      hook,
      hidden,
      ...(metrics === undefined ? {} : { metrics }),
      ...(note === undefined ? {} : { note }),
      stack,
      adoptExit: adopt.status,
      firstPr: drainFacts(0, drain.output).prs[0] ?? 'none',
      drain: drainFacts(drain.status, drain.output),
    });
  } finally {
    if (pushed) {
      dropOwnedLaneBranches();
      git(['push', 'origin', '--delete', branch]);
    }
  }
}

if (import.meta.main) {
  const root = resolve(import.meta.dirname, '..');
  const options = parseOptions(process.argv.slice(2), root);
  const explicitStacks = process.argv
    .slice(2)
    .flatMap((arg, i, all) =>
      arg === '--stack' ? [all[i + 1] as string] : [],
    );
  mkdirSync(dirname(options.summary), { recursive: true });
  if (!existsSync(options.summary))
    appendFileSync(options.summary, `${summaryHeader}\n`);
  let failed = 0;
  const hiddenRows = options.taskFile
    ? parseTaskFile(readFileSync(options.taskFile, 'utf8'))
    : undefined;
  const picked =
    hiddenRows === undefined
      ? options.stacks.map((stack) => ({ stack, hidden: undefined }))
      : hiddenRows
          .filter(
            (row) =>
              explicitStacks.length === 0 || explicitStacks.includes(row.stack),
          )
          .map((row) => ({ stack: row.stack, hidden: row }));
  const checkouts: string[] = [];
  const owned: string[] = [];
  const repeated = Array.from({ length: options.reps }, () => picked).flat();
  for (const { stack, hidden } of repeated) {
    let row: string;
    try {
      row = acceptStack(stack, options, root, hidden, checkouts, owned);
    } catch (error) {
      row = failedRow(stack, options.repos, error);
    }
    appendFileSync(options.summary, `${row}\n`);
    console.log(row);
    if (!rowGreen(row)) failed += 1;
  }
  const harvest = harvestRows(checkouts, root);
  writeFileSync(options.harvest, `${harvest.join('\n')}\n`);
  for (const line of harvest) console.log(line);
  // A red row keeps its clone: the session transcript and lane logs there are the evidence.
  if (failed === 0) sweepOwnedRows(owned);
  process.exit(failed === 0 ? 0 : 1);
}
