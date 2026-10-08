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
} from 'node:fs';
import { isAbsolute, join } from 'node:path';
import type { Job } from '../core/index.ts';
import { stateDirectory } from '../foreman/state.ts';
import {
  addWorktree,
  cleanupWorktrees,
  createWorktreeDirectory,
  execute,
} from '../verdict/sandbox.ts';
import { type RedFirstResult, redFirstSchema } from './types.ts';

const testPath = /^test\/.+\.test\.(?:ts|js|mjs|cjs)$/u;
const nodeResolutionFailure =
  /\bERR_(?:MODULE_NOT_FOUND|PACKAGE_PATH_NOT_EXPORTED|PACKAGE_IMPORT_NOT_DEFINED|INVALID_MODULE_SPECIFIER|INVALID_PACKAGE_CONFIG|INVALID_PACKAGE_TARGET|UNSUPPORTED_DIR_IMPORT|UNSUPPORTED_RESOLVE_REQUEST|UNSUPPORTED_ESM_URL_SCHEME|UNKNOWN_FILE_EXTENSION|UNKNOWN_BUILTIN_MODULE|REQUIRE_ESM)\b|Cannot find (?:module|package)\b|Module not found\b|does not provide an export named|Named export .+ not found/u;
const assertionFailure = /AssertionError|ERR_ASSERTION|assert\./u;

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
    .filter((path) => path && testPath.test(path))
    .sort();
}

function classifyTest(
  root: string,
  scratch: string,
  sha: string,
  path: string,
): RedFirstResult {
  const started = Date.now();
  const id = `red-first-${randomUUID()}`;
  const job: Job = {
    id,
    issue: 'red-first',
    worktree: scratch,
  };
  const evidence = execute(
    root,
    scratch,
    job,
    id,
    [process.execPath, '--test', path],
    120000,
    sha,
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
  const classification =
    evidence.exitCode === 0
      ? 'pass'
      : nodeResolutionFailure.test(output)
        ? 'procedural'
        : assertionFailure.test(output)
          ? 'assertion'
          : 'other';
  return redFirstSchema.parse({
    path,
    classification,
    exitCode: evidence.exitCode,
    durationMs: Date.now() - started,
    outputSha256: evidence.sha256,
    summary: output.slice(-2000),
  });
}

export function redFirst(
  rootInput: string,
  base: string,
  headInput: string,
): {
  readonly baseSha: string;
  readonly headSha: string;
  readonly results: readonly RedFirstResult[];
} {
  const root = repoRoot(rootInput);
  const head = validateSha(root, headInput);
  const baseSha = resolveCommit(root, base);
  const files = changedTestFiles(root, baseSha, head);
  const temporary = temporaryDirectory(root);
  const copies: string[] = [];
  try {
    const results = files.map((path) => {
      const scratch = createWorktreeDirectory(temporary);
      copies.push(scratch);
      addWorktree(root, scratch, baseSha);
      git(scratch, ['checkout', head, '--', ...files]);
      return classifyTest(root, scratch, baseSha, path);
    });
    return { baseSha, headSha: head, results };
  } finally {
    cleanupWorktrees(root, copies);
  }
}
