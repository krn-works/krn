import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  closeSync,
  lstatSync,
  mkdirSync,
  openSync,
  realpathSync,
  writeSync,
} from 'node:fs';
import {
  isAbsolute,
  join,
  matchesGlob,
  relative,
  resolve,
  sep,
} from 'node:path';
import { TEST_FILE_GLOB } from '../../scripts/test-suite.mjs';
import {
  type RedFirstReport,
  redFirst,
  temporaryDirectory,
} from '../flow/repository.ts';
import {
  type ChangeContract,
  deterministicCauses,
  type RedFirstResult,
} from '../flow/types.ts';

export const verifySteps = [
  'lint',
  'check',
  'targeted',
  'red-first',
  'preflight',
  'diff-check',
] as const;

export type VerifyStep = (typeof verifySteps)[number];
export type VerifyStatus = 'PASS' | 'FAIL' | 'SKIP';

export interface VerifyOptions {
  readonly base: string;
  readonly observers?: readonly string[];
  readonly skipped?: readonly VerifyStep[];
}

export interface VerifyLine {
  readonly step: VerifyStep | 'overall';
  readonly status: VerifyStatus;
  readonly detail: string;
}

export interface VerifyResult {
  readonly lines: readonly VerifyLine[];
  readonly exitCode: 0 | 1 | 75;
  readonly headSha: string;
}

export interface CommandResult {
  readonly exitCode: number | null;
  readonly signal?: NodeJS.Signals | null;
  readonly timedOut?: boolean;
  readonly logTruncated?: boolean;
}

export type CommandRunner = (
  command: string,
  args: readonly string[],
  cwd: string,
  logPath: string,
) => CommandResult | Promise<CommandResult>;

export type RedFirstRunner = (
  root: string,
  base: string,
  head: string,
) => Promise<RedFirstReport>;

export interface VerifyDependencies {
  readonly cwd?: string;
  readonly commandRunner?: CommandRunner;
  readonly redFirst?: RedFirstRunner;
}

export class VerifyUsageError extends Error {
  readonly exitCode = 64;

  constructor(message: string) {
    super(message);
    this.name = 'VerifyUsageError';
  }
}

export class VerifyDirtyTreeError extends Error {
  readonly exitCode = 75;

  constructor(message = 'tracked worktree is dirty; commit first') {
    super(message);
    this.name = 'VerifyDirtyTreeError';
  }
}

export class VerifyInternalError extends Error {
  readonly exitCode = 70;

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'VerifyInternalError';
  }
}

const usage = [
  'Usage: krn verify --base <rev> [--observer <test-file>]... [--skip <step>]...',
  'Exit codes: 0 pass, 1 verification failed or incomplete (a --skip step), 64 usage error, 70 internal error, 75 dirty tracked worktree (commit first).',
].join('\n');

export function parseVerifyArgs(args: readonly string[]): VerifyOptions {
  let base: string | undefined;
  const observers: string[] = [];
  const skipped = new Set<VerifyStep>();

  for (let index = 0; index < args.length; index++) {
    const flag = args[index];
    const value = args[index + 1];
    if (flag !== '--base' && flag !== '--observer' && flag !== '--skip')
      throw new VerifyUsageError(`${usage}\nUnknown option: ${flag}`);
    if (!value || value.startsWith('--'))
      throw new VerifyUsageError(`${usage}\nMissing value for ${flag}`);
    index++;

    if (flag === '--base') {
      if (base !== undefined)
        throw new VerifyUsageError(`${usage}\n--base may be specified once`);
      base = value;
    } else if (flag === '--observer') {
      if (observers.length >= 64)
        throw new VerifyUsageError('--observer accepts at most 64 files');
      observers.push(value);
    } else {
      if (value === 'overall')
        throw new VerifyUsageError('overall cannot be skipped');
      if (!(verifySteps as readonly string[]).includes(value))
        throw new VerifyUsageError(`unknown step for --skip: ${value}`);
      skipped.add(value as VerifyStep);
    }
  }

  if (!base) throw new VerifyUsageError(`${usage}\nMissing --base`);
  return {
    base,
    ...(observers.length ? { observers } : {}),
    ...(skipped.size ? { skipped: [...skipped] } : {}),
  };
}

function runGit(cwd: string, args: readonly string[]) {
  return spawnSync('git', [...args], {
    cwd,
    encoding: 'utf8',
    timeout: 30_000,
    maxBuffer: 4 * 1024 * 1024,
  });
}

function gitText(
  root: string,
  args: readonly string[],
  message: string,
): string {
  const result = runGit(root, args);
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(message);
  return result.stdout.trim();
}

function repositoryRoot(cwd: string): string {
  const result = runGit(cwd, ['rev-parse', '--show-toplevel']);
  if (result.error || result.status !== 0)
    throw new VerifyUsageError('krn verify must run inside a Git worktree');
  return realpathSync(result.stdout.trim());
}

function trackedTreeIsDirty(root: string): boolean {
  return (
    gitText(
      root,
      ['status', '--porcelain=v1', '--untracked-files=no'],
      'unable to inspect tracked worktree state',
    ).length > 0
  );
}

function resolveCommit(root: string, reference: string, label: string): string {
  const result = runGit(root, [
    'rev-parse',
    '--verify',
    '--end-of-options',
    `${reference}^{commit}`,
  ]);
  if (result.error || result.status !== 0)
    throw new VerifyUsageError(`${label} does not resolve to a commit`);
  return result.stdout.trim();
}

function assertBaseAncestor(root: string, base: string, head: string): void {
  const result = runGit(root, ['merge-base', '--is-ancestor', base, head]);
  if (result.error) throw result.error;
  if (result.status === 1)
    throw new VerifyUsageError('--base must be an ancestor of HEAD');
  if (result.status !== 0) throw new Error('unable to compare base with HEAD');
}

function isInside(root: string, path: string): boolean {
  const fromRoot = relative(root, path);
  return (
    fromRoot.length > 0 &&
    !isAbsolute(fromRoot) &&
    fromRoot !== '..' &&
    !fromRoot.startsWith(`..${sep}`)
  );
}

function validateObserver(root: string, head: string, observer: string): void {
  if (
    observer.length === 0 ||
    isAbsolute(observer) ||
    observer.includes('\\') ||
    /[\p{Cc}]/u.test(observer) ||
    observer.split('/').some((part) => part === '..' || part === '.')
  )
    throw new VerifyUsageError(
      `observer must be a repo-relative path without dot segments: ${observer}`,
    );
  if (!matchesGlob(observer, TEST_FILE_GLOB))
    throw new VerifyUsageError(
      `observer must match ${TEST_FILE_GLOB}: ${observer}`,
    );

  const object = runGit(root, ['cat-file', '-e', `${head}:${observer}`]);
  if (object.error) throw object.error;
  if (object.status !== 0)
    throw new VerifyUsageError(`observer does not exist at HEAD: ${observer}`);
  const tree = runGit(root, [
    '--literal-pathspecs',
    'ls-tree',
    '-z',
    head,
    '--',
    observer,
  ]);
  if (tree.error) throw tree.error;
  if (tree.status !== 0)
    throw new VerifyUsageError(`observer does not exist at HEAD: ${observer}`);
  const entries = tree.stdout.split('\0').filter(Boolean);
  const entry = entries.find(
    (value) => value.slice(value.indexOf('\t') + 1) === observer,
  );
  if (!entry || !/^(?:100644|100755) blob /u.test(entry))
    throw new VerifyUsageError(
      `observer must be a regular file at HEAD: ${observer}`,
    );

  const absolute = resolve(root, observer);
  if (!isInside(root, absolute))
    throw new VerifyUsageError(
      `observer must stay inside the repository: ${observer}`,
    );
  try {
    const actual = realpathSync(absolute);
    if (!isInside(root, actual) || !lstatSync(absolute).isFile())
      throw new VerifyUsageError(
        `observer must be a regular file inside the repository: ${observer}`,
      );
  } catch (error) {
    if (error instanceof VerifyUsageError) throw error;
    throw new VerifyUsageError(`observer does not exist at HEAD: ${observer}`);
  }
}

function changedTestFiles(root: string, base: string, head: string): string[] {
  const result = runGit(root, [
    'diff',
    '--no-renames',
    '--name-only',
    '--diff-filter=ACMT',
    '-z',
    base,
    head,
    '--',
    'test',
  ]);
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error('unable to list changed test files');
  return result.stdout
    .split('\0')
    .filter((path) => path && matchesGlob(path, TEST_FILE_GLOB))
    .sort();
}

const MAX_LOG_BYTES = 8 * 1024 * 1024;
const LOG_TRUNCATED_MARKER = Buffer.from('\n[log truncated]\n');

function writeAll(descriptor: number, chunk: Buffer): void {
  let offset = 0;
  while (offset < chunk.byteLength)
    offset += writeSync(descriptor, chunk, offset, chunk.byteLength - offset);
}

function defaultCommandRunner(
  command: string,
  args: readonly string[],
  cwd: string,
  logPath: string,
): Promise<CommandResult> {
  return new Promise((resolveResult, rejectResult) => {
    const descriptor = openSync(logPath, 'wx', 0o600);
    const maxOutputBytes = MAX_LOG_BYTES - LOG_TRUNCATED_MARKER.length;
    let outputBytes = 0;
    let logTruncated = false;
    let timedOut = false;
    let settled = false;
    let timeoutTimer: NodeJS.Timeout | undefined;
    let killTimer: NodeJS.Timeout | undefined;
    let writeError: unknown;
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(command, [...args], {
        cwd,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      closeSync(descriptor);
      rejectResult(error);
      return;
    }
    const append = (chunk: Buffer): void => {
      try {
        if (logTruncated || writeError) return;
        const remaining = maxOutputBytes - outputBytes;
        if (chunk.byteLength <= remaining) {
          if (chunk.byteLength > 0) writeAll(descriptor, chunk);
          outputBytes += chunk.byteLength;
          return;
        }
        if (remaining > 0) writeAll(descriptor, chunk.subarray(0, remaining));
        writeAll(descriptor, LOG_TRUNCATED_MARKER);
        logTruncated = true;
      } catch (error) {
        writeError = error;
        child.kill('SIGTERM');
      }
    };
    const finish = (result: Omit<CommandResult, 'logTruncated'>): void => {
      if (settled) return;
      settled = true;
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (killTimer) clearTimeout(killTimer);
      try {
        closeSync(descriptor);
      } catch (error) {
        rejectResult(error);
        return;
      }
      if (writeError) {
        rejectResult(writeError);
        return;
      }
      resolveResult({ ...result, logTruncated });
    };

    child.stdout?.on('data', append);
    child.stderr?.on('data', append);
    child.once('error', () => finish({ exitCode: null }));
    child.once('close', (exitCode, signal) =>
      finish({ exitCode, signal, timedOut }),
    );
    timeoutTimer = setTimeout(
      () => {
        timedOut = true;
        child.kill('SIGTERM');
        killTimer = setTimeout(() => child.kill('SIGKILL'), 5000);
      },
      30 * 60 * 1000,
    );
  });
}

function boundedDetail(value: string): string {
  return value.length <= 200 ? value : `${value.slice(0, 197)}...`;
}

function line(
  step: VerifyLine['step'],
  status: VerifyStatus,
  detail: string,
): VerifyLine {
  return { step, status, detail: boundedDetail(detail) };
}

interface RedFirstRow {
  readonly path: string;
  readonly ok: boolean;
  readonly isRed: boolean;
  readonly text: string;
}

function baseClassificationFailure(
  path: string,
  classification: RedFirstResult['classification'],
): string {
  const shownPath = shortPath(path);
  if (classification === 'missing-module')
    return `${shownPath} base=missing-module (import, not assertion)`;
  return `${shownPath} base=${classification} (not assertion)`;
}

function formatRedFirst(
  report: RedFirstReport,
  changedTests: readonly string[],
  observers: readonly string[],
): VerifyLine {
  const explicit = observers.length > 0;
  const contracts: readonly ChangeContract[] = report.contracts ?? [];
  const admissionCauses = deterministicCauses(report.results, contracts);
  const failures = [
    ...admissionCauses.map(
      ({ path, cause }) => `${shortPath(path)} cause:${cause}`,
    ),
    ...report.results.flatMap((result) =>
      result.cause
        ? [`${shortPath(result.path)} ${result.side}=cause:${result.cause}`]
        : [],
    ),
    ...contracts.flatMap((contract) => [
      ...(contract.cause
        ? [`${shortPath(contract.path)} cause:${contract.cause}`]
        : []),
      ...(contract.red?.cause
        ? [`${shortPath(contract.path)} base=cause:${contract.red.cause}`]
        : []),
      ...(contract.green.cause
        ? [`${shortPath(contract.path)} head=cause:${contract.green.cause}`]
        : []),
      ...(!contract.proven &&
      !admissionCauses.some(
        (cause) =>
          cause.path === contract.path && cause.commit === contract.commit,
      )
        ? [`${shortPath(contract.path)} cause:contract not proven`]
        : []),
      ...(contract.kind === 'red->green' &&
      contract.red &&
      contract.red.classification !== 'assertion'
        ? [
            baseClassificationFailure(
              contract.path,
              contract.red.classification,
            ),
          ]
        : []),
    ]),
  ];

  const runsFor = (path: string, side: 'base' | 'head') =>
    report.results.filter(
      (result) => result.path === path && result.side === side,
    );
  const changedRows: RedFirstRow[] = changedTests.map((path) => {
    const baseRuns = runsFor(path, 'base');
    const headRuns = runsFor(path, 'head');
    const base = baseRuns[0]?.classification;
    const head = headRuns[0]?.classification;
    for (const result of baseRuns) {
      if (
        result.classification !== 'pass' &&
        result.classification !== 'assertion'
      )
        failures.push(baseClassificationFailure(path, result.classification));
    }
    if (!baseRuns.length || !headRuns.length)
      return {
        path,
        ok: false,
        isRed: false,
        text: `${shortPath(path)} missing=${[
          ...(!baseRuns.length ? ['base'] : []),
          ...(!headRuns.length ? ['head'] : []),
        ].join(',')}`,
      };
    const headOk = headRuns.every(
      (result) => !result.cause && result.classification === 'pass',
    );
    if (!headOk)
      failures.push(
        ...headRuns
          .filter((result) => result.classification !== 'pass' || result.cause)
          .map((result) =>
            result.cause
              ? `${shortPath(path)} head=cause:${result.cause}`
              : `${shortPath(path)} head=${result.classification}`,
          ),
      );
    return {
      path,
      ok: headOk,
      isRed: base === 'assertion',
      text: `${shortPath(path)} base=${base} head=${head}${base === 'pass' ? ' (changed, not red)' : ''}`,
    };
  });

  const observerRows: RedFirstRow[] = observers.map((path) => {
    const baseRuns = runsFor(path, 'base');
    if (!baseRuns.length)
      return {
        path,
        ok: false,
        isRed: false,
        text: `${shortPath(path)} missing=base`,
      };
    const isRed = baseRuns.every(
      (result) => !result.cause && result.classification === 'assertion',
    );
    if (!isRed) {
      for (const result of baseRuns) {
        if (result.cause)
          failures.push(`${shortPath(path)} base=cause:${result.cause}`);
        else if (result.classification !== 'assertion')
          failures.push(baseClassificationFailure(path, result.classification));
      }
    }
    return {
      path,
      ok: isRed,
      isRed,
      text: `${shortPath(path)} base=${baseRuns[0]?.classification}`,
    };
  });

  if (
    !explicit &&
    changedTests.length > 0 &&
    !changedRows.some((row) => row.isRed)
  )
    failures.push('no changed test is red at base');

  const uniqueFailures = [
    ...new Set([
      ...failures,
      ...changedRows.filter((row) => !row.ok).map((row) => row.text),
      ...observerRows.filter((row) => !row.ok).map((row) => row.text),
    ]),
  ];
  if (uniqueFailures.length)
    return line('red-first', 'FAIL', formatFileList(uniqueFailures));
  if (changedTests.length === 0 && observers.length === 0)
    return line('red-first', 'SKIP', 'no observer test files');

  const summaryRows = [
    ...changedRows.map((row) => row.text),
    ...observerRows
      .filter((row) => !changedTests.includes(row.path))
      .map((row) => row.text),
  ];
  return line('red-first', 'PASS', formatFileList(summaryRows));
}

function shortPath(path: string): string {
  return path.length <= 48 ? path : `…${path.slice(-47)}`;
}

function formatFileList(files: readonly string[]): string {
  const shown: string[] = [];
  for (const file of files.slice(0, 5)) {
    const remainingAfter = files.length - shown.length - 1;
    const marker = remainingAfter > 0 ? ` +${remainingAfter} more` : '';
    const candidate = [...shown, file].join('; ') + marker;
    if (candidate.length > 200 && shown.length > 0) break;
    shown.push(file.length > 140 ? `${file.slice(0, 137)}...` : file);
  }
  const remainder = files.length - shown.length;
  const suffix = remainder > 0 ? ` +${remainder} more` : '';
  const output = `${shown.join('; ')}${suffix}`;
  return boundedDetail(output || 'no observer results');
}

function commandFailureDetail(
  logRelative: string,
  result: CommandResult,
): string {
  const cause = result.timedOut
    ? 'timeout'
    : result.signal
      ? `signal=${result.signal}`
      : `exit=${result.exitCode ?? 'spawn'}`;
  const truncated = result.logTruncated ? ' log truncated' : '';
  return `${cause}${truncated} log=${logRelative}`;
}

export async function runVerify(
  options: VerifyOptions,
  dependencies: VerifyDependencies = {},
): Promise<VerifyResult> {
  const root = repositoryRoot(dependencies.cwd ?? process.cwd());
  const head = resolveCommit(root, 'HEAD', 'HEAD');
  if (trackedTreeIsDirty(root)) throw new VerifyDirtyTreeError();
  const base = resolveCommit(root, options.base, '--base');
  assertBaseAncestor(root, base, head);

  const explicitObservers = [...new Set(options.observers ?? [])];
  for (const observer of explicitObservers)
    validateObserver(root, head, observer);
  const changed = changedTestFiles(root, base, head);
  const targeted = [...new Set([...explicitObservers, ...changed])];
  const temp = temporaryDirectory(root);
  const logDirectory = join(temp, `verify-${randomUUID()}`);
  mkdirSync(logDirectory, { mode: 0o700 });
  const commandRunner = dependencies.commandRunner ?? defaultCommandRunner;
  const redFirstRunner = dependencies.redFirst ?? redFirst;
  const skipped = new Set(options.skipped ?? []);
  const lines: VerifyLine[] = [];
  let failed = false;

  const runCommandStep = async (
    step: VerifyStep,
    command: string,
    args: readonly string[],
  ): Promise<void> => {
    if (skipped.has(step)) {
      lines.push(line(step, 'SKIP', 'skipped by flag'));
      return;
    }
    const logPath = join(logDirectory, `${step}.log`);
    const logRelative = relative(root, logPath).split(sep).join('/');
    const result = await commandRunner(command, args, root, logPath);
    if (result.exitCode === 0 && !result.timedOut && !result.signal)
      lines.push(
        line(
          step,
          'PASS',
          result.logTruncated ? 'completed; log truncated' : 'completed',
        ),
      );
    else {
      failed = true;
      lines.push(line(step, 'FAIL', commandFailureDetail(logRelative, result)));
    }
  };

  await runCommandStep('lint', 'npm', ['run', 'lint']);
  await runCommandStep('check', 'npm', ['run', 'check']);
  if (skipped.has('targeted'))
    lines.push(line('targeted', 'SKIP', 'skipped by flag'));
  else if (!targeted.length)
    lines.push(line('targeted', 'SKIP', 'no changed test files'));
  else
    await runCommandStep('targeted', 'node', [
      'scripts/test-suite.mjs',
      ...targeted,
    ]);

  if (skipped.has('red-first'))
    lines.push(line('red-first', 'SKIP', 'skipped by flag'));
  else {
    const report = await redFirstRunner(root, base, head);
    const redLine = formatRedFirst(report, changed, explicitObservers);
    if (redLine.status === 'FAIL') failed = true;
    lines.push(redLine);
  }

  await runCommandStep('preflight', 'npm', ['run', 'preflight']);
  await runCommandStep('diff-check', 'git', ['diff', '--check', base, head]);

  const finalHead = resolveCommit(root, 'HEAD', 'HEAD');
  const headMoved = finalHead !== head;
  const finalDirty = trackedTreeIsDirty(root);
  // A flag-skipped step leaves the verification incomplete: exit 0 means
  // every step ran, so a partial run never reads as PASS.
  const skippedSteps = lines
    .filter(
      (entry) => entry.status === 'SKIP' && entry.detail === 'skipped by flag',
    )
    .map((entry) => entry.step);
  const exitCode: VerifyResult['exitCode'] = headMoved
    ? 1
    : finalDirty
      ? 75
      : failed || skippedSteps.length
        ? 1
        : 0;
  const overallDetail = headMoved
    ? `head moved (${head} -> ${finalHead})`
    : finalDirty
      ? 'tracked worktree is dirty; commit first'
      : !failed && skippedSteps.length
        ? `incomplete: skipped ${skippedSteps.join(',')} head=${head}`
        : `head=${head}`;
  lines.push(line('overall', exitCode === 0 ? 'PASS' : 'FAIL', overallDetail));
  return { lines, exitCode, headSha: head };
}
