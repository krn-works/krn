import { spawnSync } from 'node:child_process';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { BOOTSTRAP_TASK_TITLE } from '../src/adopt/adopt.ts';
import { namedTests } from '../src/adopt/canary.ts';

// One command reruns the outside acceptance: for each scratch copy it pushes a fresh orphan base
// outside/<stack> to krn-works/krn, adopts, drains the ready tasks unattended, appends one graded
// row to the summary and always deletes the branch. The logic up to main() is pure and tested.

export const remoteUrl = 'https://github.com/krn-works/krn.git';
export const summaryHeader =
  'repo/branch | stack | adopt exit | first-test PR | drain exit | PRs (all merged) | sessions (approx) | USD (approx)';
const defaultStacks = ['php', 'npm', 'py'];

export interface RunOptions {
  stacks: string[];
  scratch: string;
  max: number;
  windowHours: number;
  summary: string;
}

/** The only branches this script may push or delete: orphan bases outside/<stack>. */
export function outsideBranch(stack: string): string {
  if (!/^[a-z][a-z0-9-]*$/u.test(stack))
    throw new Error(`outside-acceptance: bad stack name: ${stack}`);
  return `outside/${stack}`;
}

export function parseOptions(
  args: string[],
  root: string,
  scratch = process.env.KRN_OUTSIDE_SCRATCH ?? join(tmpdir(), 'krn-outside'),
): RunOptions {
  const options: RunOptions = {
    stacks: [],
    scratch,
    max: 1,
    windowHours: 8,
    summary: join(root, '.krn/runs/outside/summary.txt'),
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
    else if (arg === '--summary') options.summary = resolve(value());
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
  test?: string;
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
  return { exitCode, sessions, merged, prs, usd: Math.round(usd * 100) / 100 };
}

export interface RowInput {
  stack: string;
  adoptExit: number;
  firstPr: string;
  drain: DrainFacts | undefined;
  note?: string;
}

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
    `krn-works/krn ${outsideBranch(stack)}`,
    stack,
    String(adoptExit),
    firstPr,
    drain === undefined ? 'not run' : String(drain.exitCode),
    prs,
    drain === undefined ? '0' : String(drain.sessions),
    `$${(drain?.usd ?? 0).toFixed(2)}`,
  ];
  const row = cells.join(' | ');
  return input.note === undefined ? row : `${row} | ${input.note}`;
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

/** The krn.json keys adopt has no flag for. */
export function pick(config: AdoptFlags): AdoptFlags {
  const kept: AdoptFlags = {};
  if (config.install !== undefined) kept.install = config.install;
  if (config.related !== undefined) kept.related = config.related;
  return kept;
}

const run = (
  command: string,
  args: string[],
  cwd: string,
): { status: number; output: string } => {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    maxBuffer: 1 << 28,
  });
  return {
    status: result.status ?? 70,
    output: `${result.stdout ?? ''}${result.stderr ?? ''}`,
  };
};

function credentialConfig(root: string): string[] {
  const helper = `!'${process.execPath}' '${join(root, 'scripts/github-app-token.ts')}' git-credential`;
  return [
    '-c',
    'credential.https://github.com.helper=',
    '-c',
    `credential.https://github.com.helper=${helper}`,
  ];
}

function acceptStack(stack: string, options: RunOptions, root: string): string {
  const branch = outsideBranch(stack);
  const source = join(options.scratch, stack);
  const dir = join(options.scratch, 'runs', `${stack}-${Date.now()}`);
  const krn = join(root, 'bin/krn');
  const git = (args: string[], cwd = dir) =>
    run('git', [...credentialConfig(root), ...args], cwd);
  if (!existsSync(join(source, '.git')))
    throw new Error(
      `outside-acceptance: no scratch copy at ${source} (pass --scratch or KRN_OUTSIDE_SCRATCH)`,
    );
  const log = run('git', ['log', '--format=%H %P|%s'], source)
    .output.split('\n')
    .filter(Boolean)
    .map((line) => {
      const [head = '', subject = ''] = line.split('|');
      const [sha = '', parent] = head.split(' ');
      return { sha, parent: parent || undefined, subject };
    });
  const base = baseCommit(log);
  let pushed = false;
  try {
    mkdirSync(dirname(dir), { recursive: true });
    for (const step of [['clone', '--quiet', '--no-checkout', source, dir]])
      if (run('git', step, options.scratch).status !== 0)
        throw new Error('clone failed');
    git(['remote', 'set-url', 'origin', remoteUrl]);
    git(['checkout', '--quiet', '-B', branch, base]);
    // An orphan checkout keeps the base tree in the index; the commit has no parent.
    git(['checkout', '--quiet', '--orphan', `${branch}-orphan`]);
    git(['commit', '--quiet', '-m', `chore: orphan base for ${stack}`]);
    git(['branch', '-M', branch]);
    pushed =
      git(['push', '--force', 'origin', `${branch}:refs/heads/${branch}`])
        .status === 0;
    if (!pushed) throw new Error('push of the orphan base failed');
    let config: AdoptFlags = {};
    const configPath = join(source, 'krn.json');
    if (existsSync(configPath))
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
    const adopt = run(krn, adoptArgs(dir, adoptConfig), dir);
    const keep = (name: string, text: string) =>
      appendFileSync(
        join(dirname(options.summary), `${stack}.log`),
        `## ${name}\n${text}\n`,
      );
    keep('adopt', adopt.output);
    // Adopt cannot take install or related without --ref: carry them from the scratch copy's krn.json.
    const clonePath = join(dir, 'krn.json');
    if (existsSync(clonePath))
      writeFileSync(
        clonePath,
        `${JSON.stringify({ ...JSON.parse(readFileSync(clonePath, 'utf8')), ...pick(config) }, null, 2)}\n`,
      );
    // A vacuous base admits only the bootstrap task (it adds the first test); adopt seeds it only into a fresh tasks/.
    const vacuous =
      existsSync(clonePath) &&
      JSON.parse(readFileSync(clonePath, 'utf8')).vacuous === true;
    const seed = seedTask(
      stack,
      config.test,
      new Date().toISOString().slice(0, 10),
      vacuous,
    );
    writeFileSync(join(dir, seed.file), seed.text);
    git(['add', '-A']);
    git(['commit', '--quiet', '-m', 'chore: adopt krn']);
    git(['push', 'origin', branch]);
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
    );
    keep('drain', drain.output);
    return gradedRow({
      stack,
      adoptExit: adopt.status,
      firstPr: drainFacts(0, drain.output).prs[0] ?? 'none',
      drain: drainFacts(drain.status, drain.output),
    });
  } finally {
    if (pushed) git(['push', 'origin', '--delete', branch]);
  }
}

if (import.meta.main) {
  const root = resolve(import.meta.dirname, '..');
  const options = parseOptions(process.argv.slice(2), root);
  mkdirSync(dirname(options.summary), { recursive: true });
  if (!existsSync(options.summary))
    appendFileSync(options.summary, `${summaryHeader}\n`);
  let failed = 0;
  for (const stack of options.stacks) {
    let row: string;
    try {
      row = acceptStack(stack, options, root);
    } catch (error) {
      row = gradedRow({
        stack,
        adoptExit: 1,
        firstPr: 'none',
        drain: undefined,
        note: error instanceof Error ? error.message : String(error),
      });
    }
    appendFileSync(options.summary, `${row}\n`);
    console.log(row);
    if (/\| 0 \| [^|]*\(all merged\)/u.test(row) === false) failed += 1;
  }
  // A red row keeps its clone: the session transcript and lane logs there are the evidence.
  if (failed === 0)
    rmSync(join(options.scratch, 'runs'), { recursive: true, force: true });
  process.exit(failed === 0 ? 0 : 1);
}
