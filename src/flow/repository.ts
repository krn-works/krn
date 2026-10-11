// Process and repository boundaries for deterministic red-first evaluation.
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { isAbsolute, join, matchesGlob } from 'node:path';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import { TEST_FILE_GLOB } from '../../scripts/test-suite.mjs';
import type { Job } from '../core/index.ts';
import { stateDirectory } from '../foreman/state.ts';
import {
  addWorktree,
  cleanupWorktrees,
  createWorktreeDirectory,
  execute,
} from '../verdict/sandbox.ts';
import { type RedFirstResult, redFirstSchema } from './types.ts';

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
});

// The reporter receives Node's structured test events, not candidate stdout.
// Keep only failure metadata so arbitrary test output cannot become verdict data.
const nodeTestReporter = `
import { Transform } from 'node:stream';
const knownCodes = new Set(${JSON.stringify([
  ...nodeResolutionCodes,
  'ERR_ASSERTION',
  'ERR_TEST_FAILURE',
])});
let testFailure = false;
const errorCodes = new Set();
const causeCodes = new Set();
export default new Transform({
  writableObjectMode: true,
  transform(event, _encoding, callback) {
    if (event?.type === 'test:fail') {
      testFailure = true;
      const error = event.data?.details?.error;
      const cause = error?.cause;
      if (knownCodes.has(error?.code)) errorCodes.add(error.code);
      if (cause && typeof cause === 'object') {
        if (knownCodes.has(cause.code)) causeCodes.add(cause.code);
      }
    }
    callback();
  },
  flush(callback) {
    this.push(JSON.stringify({
      testFailure,
      errorCodes: [...errorCodes],
      causeCodes: [...causeCodes],
    }) + '\\n');
    callback();
  },
});
`;
function nodeTestWrapper(testModulePath: string): string {
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
    '--diff-filter=ACM',
    `${base}..${head}`,
    '--',
    'test',
  ])
    .split('\n')
    .filter((path) => path && matchesGlob(path, TEST_FILE_GLOB))
    .sort();
}

export function classifyNodeTestOutput(
  exitCode: number | null,
  output: string,
): RedFirstResult['classification'] {
  if (exitCode === 0) return 'pass';
  let report: z.infer<typeof nodeTestReportSchema>;
  try {
    report = nodeTestReportSchema.parse(JSON.parse(output));
  } catch {
    return 'other';
  }
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
    return 'procedural';
  return 'other';
}

async function classifyTest(
  root: string,
  scratch: string,
  side: 'base' | 'head',
  sha: string,
  path: string,
  signal?: AbortSignal,
): Promise<RedFirstResult> {
  const started = Date.now();
  const id = `red-first-${randomUUID()}`;
  const job: Job = {
    id,
    issue: 'red-first',
    worktree: scratch,
  };
  const reporterPath = join(scratch, `.krn-redfirst-reporter-${id}.mjs`);
  const wrapperPath = join(scratch, `.krn-redfirst-wrapper-${id}.mjs`);
  writeFileSync(reporterPath, nodeTestReporter, {
    flag: 'wx',
    mode: 0o400,
  });
  writeFileSync(wrapperPath, nodeTestWrapper(join(scratch, path)), {
    flag: 'wx',
    mode: 0o400,
  });
  const evidence = await execute(
    root,
    scratch,
    job,
    id,
    [
      process.execPath,
      '--test',
      `--test-reporter=${reporterPath}`,
      wrapperPath,
    ],
    120000,
    sha,
    signal,
  );
  for (const helper of [reporterPath, wrapperPath]) {
    try {
      unlinkSync(helper);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
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
  const classification = classifyNodeTestOutput(evidence.exitCode, output);
  return redFirstSchema.parse({
    path,
    side,
    sha,
    classification,
    exitCode: evidence.exitCode,
    durationMs: Date.now() - started,
    outputSha256: evidence.sha256,
    summary: output.slice(-2000),
  });
}

export async function redFirst(
  rootInput: string,
  base: string,
  headInput: string,
  signal?: AbortSignal,
): Promise<RedFirstReport> {
  const root = repoRoot(rootInput);
  const head = validateSha(root, headInput);
  const baseSha = resolveCommit(root, base);
  const files = changedTestFiles(root, baseSha, head);
  const temporary = temporaryDirectory(root);
  const copies: string[] = [];
  try {
    const results: RedFirstResult[] = [];
    for (const [side, sha] of [
      ['base', baseSha],
      ['head', head],
    ] as const) {
      for (const path of files) {
        const scratch = createWorktreeDirectory(temporary);
        copies.push(scratch);
        await addWorktree(root, scratch, side === 'base' ? baseSha : head);
        if (side === 'base') git(scratch, ['checkout', head, '--', ...files]);
        results.push(
          await classifyTest(root, scratch, side, sha, path, signal),
        );
      }
    }
    return { baseSha, headSha: head, results };
  } finally {
    await cleanupWorktrees(root, copies);
  }
}
