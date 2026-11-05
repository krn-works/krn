// Process and repository boundaries for deterministic red-first evaluation.
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmdirSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { extname, isAbsolute, join, matchesGlob, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { z } from 'zod';
import { resolveGoToolchain } from '../../scripts/isolation-gate.mjs';
import { TEST_FILE_GLOB } from '../../scripts/test-suite.mjs';
import type { Job } from '../core/index.ts';
import { stateDirectory } from '../foreman/state.ts';
import {
  createWorktreeDirectory,
  execute,
  quarantineVerdictTree,
  removeVerdictTreeOwner,
  TeardownUnconfirmed,
} from '../verdict/sandbox.ts';
import {
  type ChangeContract,
  type RedFirstResult,
  redFirstSchema,
} from './types.ts';

const nodeResolutionCodes = new Set([
  'ERR_MODULE_NOT_FOUND',
  'MODULE_NOT_FOUND',
  'ERR_PACKAGE_PATH_NOT_EXPORTED',
  'ERR_PACKAGE_IMPORT_NOT_DEFINED',
  'ERR_INVALID_MODULE_SPECIFIER',
  'ERR_INVALID_PACKAGE_CONFIG',
  'ERR_INVALID_PACKAGE_TARGET',
  'ERR_UNSUPPORTED_DIR_IMPORT',
  'ERR_UNSUPPORTED_RESOLVE_REQUEST',
  'ERR_UNSUPPORTED_ESM_URL_SCHEME',
  'ERR_UNKNOWN_FILE_EXTENSION',
  'ERR_UNKNOWN_BUILTIN_MODULE',
  'ERR_REQUIRE_ESM',
  'ERR_MODULE_LINKING',
]);
const nodeTestReportSchema = z.object({
  testFailure: z.boolean(),
  errorCodes: z.array(z.string()),
  causeCodes: z.array(z.string()),
  diagnostics: z.string().max(2048).default(''),
  skipped: z.number().int().nonnegative().default(0),
  isolationSkipped: z.number().int().nonnegative().default(0),
  timeout: z.boolean().default(false),
  missingModules: z.array(z.string()).default([]),
});
const nodeTestReportPrefix = 'KRN_NODE_TEST_REPORT:';
const runnerConfigErrorPrefix = 'KRN_RUNNER_CONFIG_ERROR:';
// Review checks already run inside isolation; nested isolation is unavailable.
// Share this declaration across the reporter parent and the candidate child.
// The check sandbox mounts the caller's Go toolchain when the host resolves it.
const reviewSandboxCapabilities = {
  go: resolveGoToolchain()
    ? { available: true, reason: '' }
    : { available: false, reason: 'Go toolchain unavailable' },
  bwrap: {
    available: false,
    reason: 'review sandbox runs no nested isolation',
  },
  systemdUserScope: {
    available: false,
    reason: 'review sandbox runs no nested isolation',
  },
};

// Keep candidate diagnostics observable while classification consumes only error codes.
export const nodeTestReporter = `
import { Transform } from 'node:stream';
const knownCodes = new Set(${JSON.stringify([
  ...nodeResolutionCodes,
  'ERR_ASSERTION',
  'ERR_TEST_FAILURE',
])});
let testFailure = false;
const errorCodes = new Set();
const causeCodes = new Set();
let diagnostics = '';
let skipped = 0;
let isolationSkipped = 0;
let isolationSummary = 0;
let timeout = false;
const missingModules = new Set();
const capabilities = ${JSON.stringify(reviewSandboxCapabilities)};
function capabilitySkip(reason) {
  if (typeof reason !== 'string') return false;
  const labels = { 'bwrap user namespaces': 'bwrap', 'systemd user scopes': 'systemdUserScope', 'Go toolchain': 'go' };
  const missing = /^SKIP\\(isolation\\): .+ \\u{2014} missing (.+)$/u.exec(reason)?.[1]?.split(', ');
  return missing?.length > 0 && missing.every((label) => capabilities[labels[label]]?.available === false);
}
function appendDiagnostic(message) {
  if (typeof message !== 'string' || !message) return;
  diagnostics = (diagnostics + message).slice(-2048);
}
export default new Transform({
  writableObjectMode: true,
  transform(event, _encoding, callback) {
    if (event?.type === 'test:stdout' || event?.type === 'test:stderr') {
      appendDiagnostic(event.data?.message);
      const summary = /Isolation-dependent tests skipped: (\\d+)/u.exec(event.data?.message ?? '');
      if (summary) isolationSummary = Math.max(isolationSummary, Number(summary[1]));
    }
    if (event?.type === 'test:pass' && event.data?.skip) {
      skipped++;
      if (capabilitySkip(event.data.skip)) isolationSkipped++;
    }
    if (event?.type === 'test:fail') {
      testFailure = true;
      const error = event.data?.details?.error;
      const cause = error?.cause;
      for (const failure of [error, cause]) {
        if (failure?.failureType === 'testTimeoutFailure') timeout = true;
        if (failure?.code === 'ERR_MODULE_NOT_FOUND' && typeof failure.url === 'string') missingModules.add(failure.url);
      }
      if (knownCodes.has(error?.code)) {
        errorCodes.add(error.code);
        appendDiagnostic('\\n' + error.code);
      }
      appendDiagnostic(error?.message ? '\\n' + error.message : '');
      if (cause && typeof cause === 'object') {
        if (knownCodes.has(cause.code)) {
          causeCodes.add(cause.code);
          appendDiagnostic('\\n' + cause.code);
        }
        appendDiagnostic(cause.message ? '\\n' + cause.message : '');
      }
    }
    callback();
  },
  flush(callback) {
    let retainedDiagnostics = diagnostics;
    let report = JSON.stringify({
      testFailure,
      skipped: Math.max(skipped, isolationSummary), isolationSkipped, timeout,
      missingModules: [...missingModules].slice(0, 1).map((url) => url.slice(0, 768)),
      errorCodes: [...errorCodes],
      causeCodes: [...causeCodes],
      diagnostics: retainedDiagnostics,
    });
    while (
      Buffer.byteLength(report, 'utf8') > 1600 &&
      retainedDiagnostics.length > 0
    ) {
      retainedDiagnostics = retainedDiagnostics.slice(
        Math.ceil(retainedDiagnostics.length / 2),
      );
      report = JSON.stringify({
        testFailure,
        skipped: Math.max(skipped, isolationSummary), isolationSkipped, timeout,
        missingModules: [...missingModules].slice(0, 1).map((url) => url.slice(0, 768)),
        errorCodes: [...errorCodes],
        causeCodes: [...causeCodes],
        diagnostics: retainedDiagnostics,
      });
    }
    this.push('${nodeTestReportPrefix}' + report + '\\n');
    callback();
  },
});
`;
export function nodeTestWrapper(testModulePath: string): string {
  const testModuleUrl = pathToFileURL(testModulePath).href;
  return `
import { test } from 'node:test';
// Keep the candidate path visible to tests that inspect argv[1].
process.argv[1] = ${JSON.stringify(testModulePath)};
try {
  await import(${JSON.stringify(testModuleUrl)});
} catch (error) {
  const failure = error instanceof SyntaxError
    ? Object.assign(new Error(error.message, { cause: error }), { code: 'ERR_MODULE_LINKING' })
    : error;
  test('candidate test module load', () => { throw failure; });
}
`;
}

export interface RedFirstReport {
  readonly baseSha: string;
  readonly headSha: string;
  readonly results: readonly RedFirstResult[];
  readonly contracts?: readonly ChangeContract[];
}

function gitOutput(
  root: string,
  args: readonly string[],
): {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
} {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const result = spawnSync('git', ['-C', root, ...args], {
    cwd: root,
    encoding: 'utf8',
    timeout: 30000,
    maxBuffer: 1024 * 1024,
    env,
  });
  if (
    result.error &&
    result.status === null &&
    !result.stdout &&
    !result.stderr
  )
    throw result.error;
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

export function git(root: string, args: readonly string[]): string {
  const result = gitOutput(root, args);
  if (result.status !== 0)
    throw new Error(result.stderr || `git ${args.join(' ')} failed`);
  return result.stdout.trim();
}

// NUL delimiters preserve tabs and newlines in git paths. Empty path marks malformed data.
export function diffStat(
  root: string,
  base: string,
  sha: string,
): import('./tier.ts').DiffEntry[] {
  const output = gitOutput(root, [
    'diff',
    '--numstat',
    '-z',
    '--no-renames',
    base,
    sha,
  ]);
  if (output.status !== 0)
    throw new Error(output.stderr || 'git diff --numstat failed');
  if (!output.stdout) return [];
  const chunks = output.stdout.split('\0');
  const terminated = chunks.pop() === '';
  const entries = chunks.map((chunk) => {
    const match = /^(\d+|-)\t(\d+|-)\t([\s\S]+)$/u.exec(chunk);
    if (!match) return { path: '', added: null, deleted: null };
    const added = match[1] === '-' ? null : Number(match[1]);
    const deleted = match[2] === '-' ? null : Number(match[2]);
    if (
      (added !== null && !Number.isSafeInteger(added)) ||
      (deleted !== null && !Number.isSafeInteger(deleted))
    )
      return { path: '', added: null, deleted: null };
    return { path: match[3] ?? '', added, deleted };
  });
  if (!terminated) entries.push({ path: '', added: null, deleted: null });
  return entries;
}

export function changedPaths(
  root: string,
  prior: string,
  head: string,
): string[] {
  const result = gitOutput(root, [
    'diff',
    '--no-renames',
    '--name-only',
    '-z',
    prior,
    head,
    '--',
  ]);
  if (result.status !== 0)
    throw new Error(result.stderr || 'git diff between review heads failed');
  return result.stdout.split('\0').filter((path) => path.length > 0);
}

export function repoRoot(input: string): string {
  if (!isAbsolute(input)) throw new Error('--repo must be an absolute path');
  const root = realpathSync(input);
  if (git(root, ['rev-parse', '--show-toplevel']) !== root)
    throw new Error('--repo must be the repository root');
  return root;
}

export function validateSha(root: string, input: string): string {
  if (!/^[a-f0-9]{40,64}$/iu.test(input))
    throw new Error('--head must be a full commit SHA');
  const sha = git(root, ['rev-parse', '--verify', `${input}^{commit}`]);
  if (sha.toLowerCase() !== input.toLowerCase())
    throw new Error('--head must identify the exact commit SHA');
  return sha;
}

export function resolveCommit(root: string, reference: string): string {
  return git(root, [
    'rev-parse',
    '--verify',
    '--end-of-options',
    `${reference}^{commit}`,
  ]);
}

export function temporaryDirectory(root: string): string {
  const state = join(root, '.krn');
  mkdirSync(state, { recursive: true, mode: 0o700 });
  if (realpathSync(state) !== state)
    throw new Error('unsafe repository state directory');
  const temporary = join(state, 'tmp');
  mkdirSync(temporary, { recursive: true, mode: 0o700 });
  if (realpathSync(temporary) !== temporary)
    throw new Error('unsafe repository temporary directory');
  return temporary;
}

function changedTestFiles(root: string, base: string, head: string): string[] {
  return git(root, [
    'diff',
    '--no-renames',
    '--name-only',
    '--diff-filter=ACMT',
    '-z',
    `${base}..${head}`,
    '--',
    'test',
  ])
    .split('\0')
    .filter((path) => path && matchesGlob(path, TEST_FILE_GLOB))
    .sort();
}

function createCandidateCopy(
  root: string,
  copy: string,
  sha: string,
  source: string,
): void {
  git(root, ['clone', '--quiet', '--no-hardlinks', '--dissociate', root, copy]);
  git(copy, ['fetch', '--quiet', root, ...new Set([sha, source])]);
  git(copy, ['checkout', '--quiet', '--detach', sha]);
}

function cleanupCandidateCopies(copies: readonly string[]): void {
  const errors: unknown[] = [];
  for (const copy of copies) {
    try {
      rmSync(copy, { recursive: true, force: true });
      removeVerdictTreeOwner(copy);
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length)
    throw new AggregateError(errors, 'red-first candidate cleanup failed');
}

export function classifyNodeTestOutput(
  exitCode: number | null,
  output: string,
  context?: { readonly root: string; readonly addedPaths: readonly string[] },
): RedFirstResult['classification'] {
  if (exitCode === 124) return 'timeout';
  let report: z.infer<typeof nodeTestReportSchema>;
  try {
    report = parseNodeTestReport(output);
  } catch {
    return exitCode === 0 &&
      !/Isolation-dependent tests skipped: [1-9]\d*/u.test(output)
      ? 'pass'
      : /Isolation-dependent tests skipped: [1-9]\d*/u.test(output)
        ? 'skipped'
        : 'other';
  }
  if (report.timeout) return 'timeout';
  if (report.skipped > 0 && !report.testFailure) return 'skipped';
  if (exitCode === 0) return 'pass';
  if (
    report.testFailure &&
    (report.errorCodes.includes('ERR_ASSERTION') ||
      report.causeCodes.includes('ERR_ASSERTION'))
  )
    return 'assertion';
  if (
    report.testFailure &&
    [...report.errorCodes, ...report.causeCodes].some((code) =>
      nodeResolutionCodes.has(code),
    )
  )
    return context &&
      report.missingModules.some((url) => {
        try {
          const path = relative(context.root, fileURLToPath(url));
          return safeRepositoryPath(path) && context.addedPaths.includes(path);
        } catch {
          return false;
        }
      })
      ? 'missing-module'
      : 'procedural';
  return 'other';
}

function parseNodeTestReport(
  output: string,
): z.infer<typeof nodeTestReportSchema> {
  const lines = output.split(/\r?\n/u);
  const reportLine = lines.find((line) =>
    line.startsWith(nodeTestReportPrefix),
  );
  const payload = reportLine
    ? reportLine.slice(nodeTestReportPrefix.length)
    : (lines[0] ?? '');
  return nodeTestReportSchema.parse(JSON.parse(payload));
}

export function summarizeNodeTestOutput(output: string): string {
  try {
    const report = parseNodeTestReport(output);
    const lines = output.split(/\r?\n/u);
    const prefixedLine = lines.findIndex((line) =>
      line.startsWith(nodeTestReportPrefix),
    );
    const reportIndex = prefixedLine >= 0 ? prefixedLine : 0;
    const trailingDiagnostics = lines
      .filter((_line, index) => index !== reportIndex)
      .join('\n');
    return [report.diagnostics, trailingDiagnostics]
      .filter(Boolean)
      .join('\n')
      .slice(-2000);
  } catch {
    return output.slice(-2000);
  }
}

// Runner configuration is trusted only from the review base. Both its syntax and
// every import's tree entry are validated before candidate code can execute.
function safeRepositoryPath(path: string): boolean {
  return (
    !isAbsolute(path) &&
    !/[\\\0\r\n:]/u.test(path) &&
    path
      .split('/')
      .every((part) => part !== '' && part !== '.' && part !== '..')
  );
}

const runnerConfigSchema = z.strictObject({
  version: z.literal(1),
  testFile: z.strictObject({
    import: z.array(z.string().refine(safeRepositoryPath)),
  }),
});

function regularGitFile(root: string, sha: string, path: string): boolean {
  if (!safeRepositoryPath(path)) return false;
  const parts = path.split('/');
  for (let index = 1; index <= parts.length; index++) {
    const entry = git(root, [
      '--literal-pathspecs',
      'ls-tree',
      sha,
      '--',
      parts.slice(0, index).join('/'),
    ]);
    const mode = entry.split(' ')[0];
    if (
      index < parts.length
        ? mode !== '040000'
        : !['100644', '100755'].includes(mode ?? '')
    )
      return false;
  }
  return true;
}

type RunnerModule = { path: string; source: string };

function readRunnerConfig(root: string, base: string): readonly RunnerModule[] {
  const entry = git(root, ['ls-tree', base, '--', 'krn.review.json']);
  if (!entry) return [];
  if (!regularGitFile(root, base, 'krn.review.json'))
    throw new Error('krn.review.json must be a regular file without symlinks');
  const config = runnerConfigSchema.parse(
    JSON.parse(git(root, ['show', `${base}:krn.review.json`])),
  );
  return config.testFile.import.map((module) => {
    if (!regularGitFile(root, base, module))
      throw new Error(
        `runner import must be a regular repository file: ${module}`,
      );
    const blob = gitOutput(root, ['show', `${base}:${module}`]);
    if (blob.status !== 0)
      throw new Error(blob.stderr || `cannot read runner import: ${module}`);
    return { path: module, source: blob.stdout };
  });
}

// Do not probe nested bwrap: it can leave orphans in the sandbox process monitor.
// CI mode lets the gate report these declared capability skips.
const runnerEnvironment = `
process.env.CI = 'true';
process.env.KRN_ISOLATION_GATE_PRELOAD = '1';
process.env.KRN_ISOLATION_CAPABILITIES = ${JSON.stringify(JSON.stringify(reviewSandboxCapabilities))};
`;

export function runnerSetup(importPaths: readonly string[]): string {
  return `
import { registerHooks } from 'node:module';
${runnerEnvironment}
const configuredModules = new Set(${JSON.stringify(importPaths.map((path) => pathToFileURL(path).href))});
// Preloads run before Node can start the test reporter. Keep their failures
// distinct from test assertions and flush a bounded diagnostic before exiting.
process.setUncaughtExceptionCaptureCallback((error) => {
  const message = String(error?.stack ?? error).slice(-1500);
  // The executor retains a byte-limited tail, so keep the marker last even
  // when diagnostics contain multibyte characters or escaped control codes.
  process.stderr.write(JSON.stringify(message) + '\\n' + ${JSON.stringify(runnerConfigErrorPrefix)} + '\\n', () => process.exit(65));
});
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (configuredModules.has(context.parentURL) && !specifier.startsWith('node:'))
      throw new Error('runner imports must be self-contained (node: imports only): ' + specifier);
    return nextResolve(specifier, context);
  },
});
export function runnerImportsLoaded() {
  process.setUncaughtExceptionCaptureCallback(null);
}

`;
}

export function readyShim(environmentPath: string): string {
  return `import { runnerImportsLoaded } from ${JSON.stringify(pathToFileURL(environmentPath).href)};\nrunnerImportsLoaded();\n`;
}

export function asciiHelperSource(source: string): string {
  return Array.from(source, (character) => {
    const codePoint = character.codePointAt(0)!;
    return codePoint < 0x80 ? character : `\\u{${codePoint.toString(16)}}`;
  }).join('');
}

export function writeHelperSource(
  path: string,
  source: string,
  ascii = false,
): void {
  writeFileSync(path, ascii ? asciiHelperSource(source) : source, {
    flag: 'wx',
    mode: 0o400,
  });
}

function removeHelper(path: string): void {
  try {
    unlinkSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

function dataError(
  path: string,
  side: 'base' | 'head',
  sha: string,
  cause: 'runner-config' | 'contract' | undefined,
  error: unknown,
): RedFirstResult {
  const summary = (
    error instanceof Error ? error.message : String(error)
  ).slice(0, 2000);
  return {
    path,
    side,
    sha,
    classification: 'procedural',
    exitCode: 65,
    durationMs: 0,
    outputSha256: createHash('sha256').update(summary).digest('hex'),
    summary,
    ...(cause ? { cause } : {}),
  };
}

type ContractDeclaration = {
  commit: string;
  parent: string;
  path: string;
  kind: ChangeContract['kind'];
};
export function contractDeclarations(
  root: string,
  base: string,
  head: string,
): { declarations: ContractDeclaration[]; errors: RedFirstResult[] } {
  const declarations: ContractDeclaration[] = [];
  const errors: RedFirstResult[] = [];
  for (const commit of git(root, [
    'rev-list',
    '--reverse',
    '--topo-order',
    `${base}..${head}`,
  ])
    .split('\n')
    .filter(Boolean)) {
    const message = git(root, ['show', '-s', '--format=%B', commit]);
    const parsed = spawnSync('git', ['interpret-trailers', '--parse'], {
      cwd: root,
      input: message,
      encoding: 'utf8',
      timeout: 30000,
      maxBuffer: 1024 * 1024,
    });
    if (parsed.status !== 0) {
      errors.push(
        dataError(
          'Change-contract',
          'head',
          head,
          'contract',
          'cannot parse commit trailers',
        ),
      );
      continue;
    }
    const seen = new Set<string>();
    for (const line of parsed.stdout.split(/\r?\n/u)) {
      if (!/^Change-contract:/iu.test(line)) continue;
      const value = line.slice(line.indexOf(':') + 1).trim();
      const match = /^(.*):(red->green|green->green)$/u.exec(value);
      const path = match?.[1];
      const kind = match?.[2];
      if (
        !path ||
        (kind !== 'red->green' && kind !== 'green->green') ||
        !safeRepositoryPath(path) ||
        !matchesGlob(path, TEST_FILE_GLOB) ||
        seen.has(path)
      ) {
        errors.push(
          dataError(
            path || 'Change-contract',
            'head',
            head,
            'contract',
            `invalid or duplicate Change-contract in ${commit}: ${value}`,
          ),
        );
        continue;
      }
      seen.add(path);
      const parent = git(root, ['rev-parse', `${commit}^1`]);
      declarations.push({ commit, parent, path, kind });
    }
  }
  return { declarations, errors };
}

async function classifyTest(
  root: string,
  scratch: string,
  side: 'base' | 'head',
  sha: string,
  baseSha: string,
  headSha: string,
  path: string,
  imports: readonly RunnerModule[],
  run: typeof execute,
  signal?: AbortSignal,
): Promise<RedFirstResult> {
  const started = Date.now();
  const id = `red-first-${randomUUID()}`;
  const job: Job = { id, issue: 'red-first', worktree: scratch };
  const helpers: string[] = [];
  let retainHelpers = false;
  const helper = (
    role: string,
    source: string,
    extension = '.mjs',
    ascii = true,
  ) => {
    const helperPath = join(scratch, `.krn-redfirst-${role}-${id}${extension}`);
    writeHelperSource(helperPath, source, ascii);
    helpers.push(helperPath);
    return helperPath;
  };
  try {
    const reporterPath = helper('reporter', nodeTestReporter);
    const wrapperPath = helper('wrapper', nodeTestWrapper(join(scratch, path)));
    // Copy the exact base blobs, preserving module format and bytes. Candidate
    // trees never supply runner code, even for contract parents before the base.
    const importPaths = imports.map((module, index) =>
      helper(
        `runner-${index}`,
        module.source,
        extname(module.path) || '.mjs',
        false,
      ),
    );
    const environmentPath = helper('environment', runnerSetup(importPaths));
    const readyPath = helper('ready', readyShim(environmentPath));
    const evidence = await run(
      root,
      scratch,
      job,
      id,
      [
        process.execPath,
        ...(imports.length ? ['--import', environmentPath] : []),
        ...importPaths.flatMap((module) => [
          '--import',
          pathToFileURL(module).href,
        ]),
        ...(imports.length ? ['--import', readyPath] : []),
        '--test',
        `--test-reporter=${reporterPath}`,
        wrapperPath,
      ],
      120000,
      sha,
      signal,
      baseSha,
    );
    const diagnostics = join(stateDirectory(job), 'diagnostics');
    if (realpathSync(diagnostics) !== diagnostics)
      throw new Error('unsafe red-first diagnostic directory');
    const tailFile = readdirSync(diagnostics).find((name) =>
      name.startsWith(`${sha}-${id}-`),
    );
    if (!tailFile) throw new Error(`missing sandbox diagnostic for ${path}`);
    const tailPath = join(diagnostics, tailFile);
    const tailStat = lstatSync(tailPath);
    if (tailStat.isSymbolicLink() || !tailStat.isFile())
      throw new Error('unsafe red-first diagnostic file');
    const output = readFileSync(tailPath, 'utf8');
    unlinkSync(tailPath);
    for (const directory of [diagnostics, stateDirectory(job)]) {
      try {
        rmdirSync(directory);
      } catch (error) {
        if (
          !['ENOENT', 'ENOTEMPTY'].includes(
            (error as NodeJS.ErrnoException).code ?? '',
          )
        )
          throw error;
      }
    }
    const addedPaths =
      side === 'base'
        ? git(root, [
            'diff',
            '--no-renames',
            '--name-only',
            '--diff-filter=A',
            '-z',
            sha,
            headSha,
            '--',
          ]).split('\0')
        : [];
    const runnerConfigFailed = output.includes(runnerConfigErrorPrefix);
    const classification = runnerConfigFailed
      ? 'procedural'
      : classifyNodeTestOutput(evidence.exitCode, output, {
          root: scratch,
          addedPaths,
        });
    let capability = false;
    if (classification === 'skipped' && imports.length > 0) {
      const report = parseNodeTestReport(output);
      capability =
        report.skipped > 0 &&
        report.skipped === report.isolationSkipped &&
        !report.testFailure;
    }
    return redFirstSchema.parse({
      path,
      side,
      sha,
      classification,
      exitCode: evidence.exitCode,
      durationMs: Date.now() - started,
      outputSha256: evidence.sha256,
      summary: summarizeNodeTestOutput(output),
      ...(runnerConfigFailed ? { cause: 'runner-config' } : {}),
      ...(capability ? { cause: 'capability', proven: false } : {}),
    });
  } catch (error) {
    if (error instanceof TeardownUnconfirmed) {
      retainHelpers = true;
      throw error;
    }
    if (signal?.aborted) throw error;
    return dataError(path, side, sha, undefined, error);
  } finally {
    if (!retainHelpers) for (const helper of helpers) removeHelper(helper);
  }
}

export async function redFirst(
  rootInput: string,
  base: string,
  headInput: string,
  signal?: AbortSignal,
  /** Transport seam for tests; the CLI always uses the isolated executor. */
  run: typeof execute = execute,
): Promise<RedFirstReport> {
  const root = repoRoot(rootInput);
  const head = validateSha(root, headInput);
  const baseSha = resolveCommit(root, base);
  const files = changedTestFiles(root, baseSha, head);
  const { declarations, errors } = contractDeclarations(root, baseSha, head);
  let imports: readonly RunnerModule[];
  try {
    imports = readRunnerConfig(root, baseSha);
  } catch (error) {
    return {
      baseSha,
      headSha: head,
      contracts: [],
      results: [
        dataError('krn.review.json', 'head', head, 'runner-config', error),
      ],
    };
  }
  const temporary = temporaryDirectory(root);
  const copies: string[] = [];
  const quarantined = new Set<string>();
  const cache = new Map<string, Promise<RedFirstResult>>();
  const evaluate = (
    side: 'base' | 'head',
    sha: string,
    source: string,
    path: string,
  ): Promise<RedFirstResult> => {
    const key = JSON.stringify([side, sha, source, path]);
    const existing = cache.get(key);
    if (existing) return existing;
    const pending = (async () => {
      if (!regularGitFile(root, source, path))
        return dataError(
          path,
          side,
          sha,
          'contract',
          `test must exist as a regular file at ${source}: ${path}`,
        );
      if (
        git(root, ['--literal-pathspecs', 'ls-tree', sha, '--', path]) &&
        !regularGitFile(root, sha, path)
      )
        return dataError(
          path,
          side,
          sha,
          'contract',
          `test must be a regular file at ${sha}: ${path}`,
        );
      const scratch = await createWorktreeDirectory(temporary, root);
      copies.push(scratch);
      try {
        createCandidateCopy(root, scratch, sha, source);
        if (source !== sha) {
          // Validate the receiver's parents too: checkout must never follow a
          // symlink from the earlier tree while overlaying a newly added test.
          const parts = path.split('/');
          for (let index = 1; index < parts.length; index++) {
            const entry = git(root, [
              'ls-tree',
              sha,
              '--',
              parts.slice(0, index).join('/'),
            ]);
            if (entry && !entry.startsWith('040000 '))
              return dataError(
                path,
                side,
                sha,
                'contract',
                'unsafe test parent',
              );
          }
          git(scratch, ['--literal-pathspecs', 'checkout', source, '--', path]);
        }
        return await classifyTest(
          root,
          scratch,
          side,
          sha,
          baseSha,
          head,
          path,
          imports,
          run,
          signal,
        );
      } catch (error) {
        // A scope may still be reading this exact workspace and its helpers.
        if (error instanceof TeardownUnconfirmed) {
          quarantined.add(scratch);
          quarantineVerdictTree(scratch);
        }
        throw error;
      } finally {
        if (!quarantined.has(scratch)) cleanupCandidateCopies([scratch]);
      }
    })();
    cache.set(key, pending);
    return pending;
  };
  try {
    const results: RedFirstResult[] = [...errors];
    for (const [side, sha] of [
      ['base', baseSha],
      ['head', head],
    ] as const) {
      for (const path of files)
        results.push(await evaluate(side, sha, head, path));
    }
    const contracts: ChangeContract[] = [];
    for (const declaration of declarations) {
      const { commit, parent, path, kind } = declaration;
      const red =
        kind === 'red->green'
          ? await evaluate('base', parent, commit, path)
          : undefined;
      const green = await evaluate('head', head, head, path);
      const proven =
        green.classification === 'pass' &&
        (kind === 'green->green' ||
          red?.classification === 'assertion' ||
          red?.classification === 'missing-module');
      contracts.push({
        commit,
        path,
        kind,
        ...(red ? { red } : {}),
        green,
        proven,
        ...(!proven &&
        (red?.cause === 'capability' || green.cause === 'capability')
          ? { cause: 'capability' as const }
          : {}),
      });
    }
    return { baseSha, headSha: head, results, contracts };
  } finally {
    cleanupCandidateCopies(copies.filter((copy) => !quarantined.has(copy)));
  }
}
