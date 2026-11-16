// Host-applied remediation: the two failing standards a sandboxed lane cannot finish (it cannot
// create .github/workflows or a lockfile) are written here by the host, from the init skeletons.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Failure } from '../brain/standards.ts';
import {
  type CiCommands,
  ciWorkflow,
  detectInitStack,
  type InitStack,
} from './init.ts';
import { GATE_KEYS, workflowGates } from './workflow-gates.ts';

export interface HostRemediation {
  /** Files the host wrote. */
  written: string[];
  /** Standards the host tried and could not fix, with the reason; they stay failing. */
  unfixed: string[];
}

const CI_STANDARD = 's-gate-in-ci';
const LOCKFILE_STANDARD = 's-lockfile-committed';

/** The commands an existing project's CI needs besides the skeleton test command. */
function commandsFor(root: string, stack: InitStack): CiCommands {
  const contract = contractCommands(root);
  if (contract.test !== undefined) return contract;
  if (stack === 'ts') {
    const locked = existsSync(join(root, 'package-lock.json'));
    return {
      install: locked ? 'npm ci' : 'npm install',
      test: scriptDefined(root, 'test') ? 'npm test' : undefined,
    };
  }
  if (stack === 'python')
    return {
      install: existsSync(join(root, 'requirements.txt'))
        ? 'python -m pip install -r requirements.txt'
        : undefined,
      test: existsSync(join(root, 'tests'))
        ? 'python -m unittest discover -s tests'
        : undefined,
    };
  return {};
}

/** The install and test commands krn.json records, which adopt detected from the repository. */
function contractCommands(root: string): CiCommands {
  try {
    const body: unknown = JSON.parse(
      readFileSync(join(root, 'krn.json'), 'utf8'),
    );
    const read = (key: string) => {
      const value = (body as Record<string, unknown>)[key];
      return typeof value === 'string' && value !== '' ? value : undefined;
    };
    // A vacuous contract records a placeholder that only fails: the workflow then runs the stack's own
    // test command, which the first task delivers, so the CI standard needs no later workflow edit.
    const vacuous = (body as Record<string, unknown>).vacuous === true;
    return {
      install: read('install'),
      lint: read('lint'),
      typecheck: read('typecheck'),
      test: vacuous ? undefined : read('test'),
    };
  } catch {
    return {};
  }
}

function scriptDefined(root: string, name: string): boolean {
  try {
    const manifest: unknown = JSON.parse(
      readFileSync(join(root, 'package.json'), 'utf8'),
    );
    const scripts = (manifest as { scripts?: Record<string, unknown> }).scripts;
    return typeof scripts?.[name] === 'string';
  } catch {
    return false;
  }
}

/** Writes the CI workflow, or says why none was written. */
function writeCi(root: string): { file: string } | { reason: string } {
  const stack = detectInitStack(root);
  if (stack === undefined)
    return { reason: 'no stack detected to write a workflow for' };
  // A ci.yml of the repository's own keeps running; the call that proves tests goes beside it.
  const file = existsSync(join(root, '.github/workflows/ci.yml'))
    ? '.github/workflows/krn-ci.yml'
    : '.github/workflows/ci.yml';
  if (existsSync(join(root, file))) return { reason: `${file} already exists` };
  // Fill gaps, never duplicate: a contract gate another workflow already runs gets no step here.
  const contract = contractCommands(root);
  const gates = workflowGates(root, contract);
  const omit = GATE_KEYS.filter((key) => (gates.runBy[key]?.length ?? 0) > 0);
  if (omit.length > 0 && gates.missing.length === 0)
    return {
      reason: `every contract gate already runs in ${[...new Set(Object.values(gates.runBy).flat())].join(', ')}`,
    };
  const commands = {
    lint: contract.lint,
    typecheck: contract.typecheck,
    ...commandsFor(root, stack),
  };
  mkdirSync(dirname(join(root, file)), { recursive: true });
  writeFileSync(join(root, file), ciWorkflow(stack, commands, false, omit));
  return { file };
}

/** Runs npm's lockfile-only install in `root`, so the lockfile follows package.json; throws npm's last line on failure. */
export function syncLockfile(root: string): void {
  const locked = spawnSync(
    'npm',
    [
      'install',
      '--package-lock-only',
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
    ],
    { cwd: root, encoding: 'utf8' },
  );
  if (locked.status !== 0)
    throw new Error(
      `npm install --package-lock-only exited ${locked.status ?? 'without a status'}: ${(locked.stderr || locked.stdout).trim().split('\n').pop()}`,
    );
}

function writeLockfile(root: string): string | undefined {
  if (!existsSync(join(root, 'package.json'))) return undefined;
  if (existsSync(join(root, 'package-lock.json'))) return undefined;
  syncLockfile(root);
  return 'package-lock.json';
}

/**
 * Writes the CI workflow of a failing `s-gate-in-ci` and the lockfile of a failing
 * `s-lockfile-committed` into the working tree. Nothing is committed or pushed: the files are the
 * adopter's to review, and a refused workflow push is a decide record at ship, not a lane BLOCKER.
 */
export function remediateHost(
  root: string,
  failures: readonly Failure[],
): HostRemediation {
  const result: HostRemediation = { written: [], unfixed: [] };
  const failing = new Set(failures.map((failure) => failure.id));
  if (failing.has(LOCKFILE_STANDARD)) {
    try {
      const file = writeLockfile(root);
      if (file !== undefined) result.written.push(file);
    } catch (error) {
      result.unfixed.push(`${LOCKFILE_STANDARD}: ${(error as Error).message}`);
    }
  }
  if (failing.has(CI_STANDARD)) {
    const ci = writeCi(root);
    if ('reason' in ci) result.unfixed.push(`${CI_STANDARD}: ${ci.reason}`);
    else result.written.push(ci.file);
  }
  // The lockfile standard reads `git ls-files`: a written file counts once it is staged.
  if (result.written.length > 0)
    spawnSync('git', ['add', '--', ...result.written], { cwd: root });
  return result;
}
