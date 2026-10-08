// Process and repository boundaries for deterministic red-first evaluation.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
} from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { type RedFirstResult, redFirstSchema } from './types.ts';

const testPath = /^test\/.+\.test\.(?:ts|js|mjs|cjs)$/u;
const missingImport =
  /ERR_MODULE_NOT_FOUND|ERR_PACKAGE_PATH_NOT_EXPORTED|ERR_UNSUPPORTED_DIR_IMPORT|Cannot find (?:module|package)|Module not found/u;
const assertionFailure = /AssertionError|ERR_ASSERTION|assert\./u;

export function command(
  file: string,
  args: readonly string[],
  cwd: string,
  timeout = 30000,
): {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
} {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const result = spawnSync(file, [...args], {
    cwd,
    encoding: 'utf8',
    timeout,
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
  const result = command('git', ['-C', root, ...args], root);
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

function overlayAtBase(
  root: string,
  scratch: string,
  base: string,
  head: string,
  files: readonly string[],
): void {
  git(scratch, ['checkout', '--detach', base]);
  if (files.length) git(scratch, ['checkout', head, '--', ...files]);
  const dependencies = join(root, 'node_modules');
  if (existsSync(dependencies) && !existsSync(join(scratch, 'node_modules')))
    symlinkSync(dependencies, join(scratch, 'node_modules'), 'dir');
}

function classifyTest(scratch: string, path: string): RedFirstResult {
  const started = Date.now();
  const result = command(process.execPath, ['--test', path], scratch, 120000);
  const output = `${result.stdout}\n${result.stderr}`;
  const classification =
    result.status === 0
      ? 'pass'
      : missingImport.test(output)
        ? 'procedural'
        : assertionFailure.test(output)
          ? 'assertion'
          : 'other';
  return redFirstSchema.parse({
    path,
    classification,
    exitCode: result.status,
    durationMs: Date.now() - started,
    outputSha256: createHash('sha256').update(output).digest('hex'),
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
  const parent = mkdtempSync(join(temporaryDirectory(root), 'red-first-'));
  const scratch = join(parent, 'repo');
  try {
    git(root, ['clone', '--quiet', '--no-hardlinks', root, scratch]);
    overlayAtBase(root, scratch, baseSha, head, files);
    const results = files.map((path) => classifyTest(scratch, path));
    return { baseSha, headSha: head, results };
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
}
