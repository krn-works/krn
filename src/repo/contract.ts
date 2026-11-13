// The repo contract: how KRN tests, checks and branches in one repository, whatever its stack.
// A tracked krn.json declares it; any field it leaves out is detected from the repository's own files.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export type Tracker = 'krn' | 'none';

export interface RepoContract {
  /** Branch lanes start from and the Stop check diffs against. */
  readonly base: string;
  /** Full test suite, a shell command run at the repository root. */
  readonly test: string;
  /** Tests for chosen files: a shell command where {files} becomes the space-separated paths. */
  readonly related?: string;
  /** Quick local check before a commit; the test command when absent. */
  readonly fast?: string;
  /** Whole-tree invariant tests the Stop check runs on every change: space-separated paths or path prefixes. */
  readonly guard?: string;
  /** JSON file of the repository's conventions (brain records) the lane packet reads, relative to the root. */
  readonly conventions?: string;
  readonly tracker: Tracker;
}

export interface ResolvedContract {
  readonly contract: RepoContract;
  /** krn.json when the file exists (its fields win), else detected. */
  readonly source: 'krn.json' | 'detected';
  /** The stack detection recognised, or undefined when krn.json named every command. */
  readonly stack?: string;
}

export const CONTRACT_FILE = 'krn.json';
const FIELDS = [
  'base',
  'test',
  'related',
  'fast',
  'guard',
  'conventions',
  'tracker',
] as const;

/** Where conventions live when krn.json does not name a file. */
export const DEFAULT_CONVENTIONS = '.krn/conventions.json';

export class ContractError extends Error {}

type Declared = { -readonly [K in keyof RepoContract]?: RepoContract[K] };

export function parseContractFile(text: string): Declared {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new ContractError(
      `${CONTRACT_FILE}: not JSON (${(error as Error).message})`,
    );
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw))
    throw new ContractError(`${CONTRACT_FILE}: expected an object`);
  const out: Declared = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!(FIELDS as readonly string[]).includes(key))
      throw new ContractError(
        `${CONTRACT_FILE}: unknown field "${key}" (fields: ${FIELDS.join(', ')})`,
      );
    if (typeof value !== 'string' || value.trim() === '')
      throw new ContractError(
        `${CONTRACT_FILE}: "${key}" must be a non-empty string`,
      );
    if (key === 'tracker') {
      if (value !== 'krn' && value !== 'none')
        throw new ContractError(
          `${CONTRACT_FILE}: "tracker" must be "krn" or "none"`,
        );
      out.tracker = value;
    } else if (key === 'related' && !value.includes('{files}'))
      throw new ContractError(
        `${CONTRACT_FILE}: "related" must contain {files}`,
      );
    else out[key as Exclude<(typeof FIELDS)[number], 'tracker'>] = value;
  }
  return out;
}

interface Detected {
  stack: string;
  test: string;
  related?: string;
  fast?: string;
}

function readJson(path: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(readFileSync(path, 'utf8'));
    return typeof value === 'object' && value !== null
      ? (value as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

function detectNode(root: string): Detected | undefined {
  const pkg = readJson(join(root, 'package.json'));
  if (!pkg) return undefined;
  const scripts = (pkg.scripts ?? {}) as Record<string, unknown>;
  const script = typeof scripts.test === 'string' ? scripts.test : '';
  // npm init writes a test script that only fails.
  if (script === '' || /no test specified/.test(script)) return undefined;
  const pm = existsSync(join(root, 'pnpm-lock.yaml'))
    ? 'pnpm'
    : existsSync(join(root, 'yarn.lock'))
      ? 'yarn'
      : existsSync(join(root, 'bun.lockb')) ||
          existsSync(join(root, 'bun.lock'))
        ? 'bun'
        : 'npm';
  const run = pm === 'npm' ? 'npm run' : pm;
  const runner = /\bvitest\b/.test(script)
    ? `${pm === 'npm' ? 'npx' : `${pm} exec`} vitest run {files}`
    : /\bjest\b/.test(script)
      ? `${pm === 'npm' ? 'npx' : `${pm} exec`} jest {files}`
      : /\bnode\b[^&|;]*--test\b/.test(script)
        ? 'node --test {files}'
        : undefined;
  return {
    stack: `node/${pm}`,
    test: `${pm} test`,
    ...(runner ? { related: runner } : {}),
    ...(typeof scripts.fast === 'string' ? { fast: `${run} fast` } : {}),
  };
}

function detectPython(root: string): Detected | undefined {
  const markers = [
    'pyproject.toml',
    'pytest.ini',
    'setup.cfg',
    'tox.ini',
    'setup.py',
  ];
  if (!markers.some((file) => existsSync(join(root, file)))) return undefined;
  const pytest = existsSync(join(root, 'uv.lock'))
    ? 'uv run pytest'
    : existsSync(join(root, 'poetry.lock'))
      ? 'poetry run pytest'
      : 'python -m pytest';
  return { stack: 'python', test: pytest, related: `${pytest} {files}` };
}

function detectMakeTest(root: string): Detected | undefined {
  try {
    const text = readFileSync(join(root, 'Makefile'), 'utf8');
    return /^test:/m.test(text)
      ? { stack: 'make', test: 'make test' }
      : undefined;
  } catch {
    return undefined;
  }
}

// First match wins: an explicit runner file beats a generic Makefile target.
export function detectStack(root: string): Detected | undefined {
  if (existsSync(join(root, 'Cargo.toml')))
    return { stack: 'rust', test: 'cargo test' };
  if (existsSync(join(root, 'go.mod')))
    return {
      stack: 'go',
      test: 'go test ./...',
      related: 'go test {files}',
    };
  return detectNode(root) ?? detectPython(root) ?? detectMakeTest(root);
}

function git(root: string, args: string[]): string | undefined {
  try {
    return execFileSync('git', args, {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return undefined;
  }
}

// The remote's default branch, else a local main or master, else the current branch.
export function detectBase(root: string): string {
  const remoteHead = git(root, [
    'symbolic-ref',
    '--short',
    'refs/remotes/origin/HEAD',
  ]);
  if (remoteHead) return remoteHead.replace(/^origin\//, '');
  for (const name of ['main', 'master'])
    if (git(root, ['rev-parse', '--verify', '--quiet', `refs/heads/${name}`]))
      return name;
  return git(root, ['branch', '--show-current']) || 'main';
}

function declaredContract(root: string): Declared | undefined {
  const file = join(root, CONTRACT_FILE);
  return existsSync(file)
    ? parseContractFile(readFileSync(file, 'utf8'))
    : undefined;
}

/** The branch lanes start from: krn.json `base`, else detected; it needs no test command. */
export function contractBase(root: string): string {
  return declaredContract(root)?.base ?? detectBase(root);
}

/** The conventions file, relative to the root: krn.json `conventions`, else `.krn/conventions.json`; it needs no test command. */
export function contractConventions(root: string): string {
  return declaredContract(root)?.conventions ?? DEFAULT_CONVENTIONS;
}

/** Whether work items live in tasks/: krn.json `tracker`, else a tasks/ directory means krn. */
export function contractTracker(root: string): Tracker {
  return (
    declaredContract(root)?.tracker ??
    (existsSync(join(root, 'tasks')) ? 'krn' : 'none')
  );
}

export function resolveContract(root: string): ResolvedContract {
  const found = findContract(root);
  if (found === undefined)
    throw new ContractError(
      `no test command: KRN recognises Cargo.toml, go.mod, package.json with a test script, pyproject.toml/pytest.ini/setup.cfg/tox.ini/setup.py, or a Makefile test target; otherwise write ${CONTRACT_FILE} with {"test": "<command>"}`,
    );
  return found;
}

/** The contract, or undefined when neither krn.json nor detection names a test command; a malformed krn.json still throws. */
export function findContract(root: string): ResolvedContract | undefined {
  const declared = declaredContract(root);
  const needsDetection =
    declared?.test === undefined ||
    declared.related === undefined ||
    declared.fast === undefined;
  const detected = needsDetection ? detectStack(root) : undefined;
  const test = declared?.test ?? detected?.test;
  if (test === undefined) return undefined;
  const related = declared?.related ?? detected?.related;
  const fast = declared?.fast ?? detected?.fast;
  const contract: RepoContract = {
    base: declared?.base ?? detectBase(root),
    test,
    ...(related ? { related } : {}),
    ...(fast ? { fast } : {}),
    ...(declared?.guard ? { guard: declared.guard } : {}),
    ...(declared?.conventions ? { conventions: declared.conventions } : {}),
    tracker: contractTracker(root),
  };
  return {
    contract,
    source: declared ? 'krn.json' : 'detected',
    ...(detected ? { stack: detected.stack } : {}),
  };
}

/** The related-test command for these files, or the full test command when the stack has none. */
export function relatedCommand(
  contract: RepoContract,
  files: readonly string[],
): string {
  if (!contract.related || files.length === 0) return contract.test;
  const quoted = files.map((f) => `'${f.replaceAll("'", `'\\''`)}'`).join(' ');
  return contract.related.replaceAll('{files}', quoted);
}
