// `krn standards check [--root DIR]`: run the enforcement of every standard that applies to one
// repository (the shipped pack plus its .agents/standards.json) and print one PASS or FAIL line.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CliUsageError } from '../cli/usage-error.ts';
import {
  CONTRACT_FILE,
  contractTracker,
  detectStack,
} from '../repo/contract.ts';
import {
  appliesTo,
  checkStandards,
  type Enforce,
  type Failure,
  type Need,
  parseStandards,
  type Repository,
  type Standard,
  StandardsDataError,
} from './standards.ts';

export const usage = 'usage: krn standards check [--root DIR]';

/** The pack KRN ships, relative to the product root. */
export const PACK = 'standards/records.json';
/** A project's own standards, relative to its root; they add to the pack and never share a pack id. */
export const PROJECT_STANDARDS = '.agents/standards.json';
/** How long one enforcement may run before it counts as failed. */
export const ENFORCEMENT_TIMEOUT_MS = 60_000;

const productRoot = fileURLToPath(new URL('../..', import.meta.url));
const krnMain = fileURLToPath(new URL('../cli/main.ts', import.meta.url));

/** The checked root is missing, unreadable or not a repository's own top level. */
export class StandardsInputError extends Error {
  readonly exitCode = 66;
}

function parseFile(root: string, path: string): Standard[] {
  let source: string;
  try {
    source = readFileSync(join(root, path), 'utf8');
  } catch (error) {
    throw new StandardsInputError(
      `${path}: cannot read (${(error as Error).message})`,
    );
  }
  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch (error) {
    throw new StandardsDataError(
      `${path}: not JSON (${(error as Error).message})`,
    );
  }
  try {
    return parseStandards(value);
  } catch (error) {
    if (error instanceof StandardsDataError)
      throw new StandardsDataError(`${path}: ${error.message}`);
    throw error;
  }
}

/** Git variables a caller (a hook, a worktree) may export that would point git at another repository. */
const GIT_LOCATION = [
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_OBJECT_DIRECTORY',
  'GIT_COMMON_DIR',
  'GIT_PREFIX',
];

function environment(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const name of GIT_LOCATION) delete env[name];
  return env;
}

/** Refuses a root that is not a directory or not the top level of its own git repository. */
export function repositoryRoot(root: string): string {
  if (!existsSync(root) || !statSync(root).isDirectory())
    throw new StandardsInputError(
      `krn standards check: ${root} is not a directory`,
    );
  const top = spawnSync('git', ['-C', root, 'rev-parse', '--show-toplevel'], {
    encoding: 'utf8',
    env: environment(),
  });
  if (top.status !== 0)
    throw new StandardsInputError(
      `krn standards check: ${root} is not a git repository (${top.stderr.trim() || `git exit ${top.status}`})`,
    );
  const real = realpathSync(root);
  const toplevel = realpathSync(top.stdout.trim());
  if (real !== toplevel)
    throw new StandardsInputError(
      `krn standards check: ${root} is not the top level of its git repository (${toplevel})`,
    );
  return real;
}

/** The stack, adoption and tracker of `root`, a repository top level. */
export function repositoryFacts(root: string): Repository {
  const needs = new Set<Need>();
  if (contractTracker(root) === 'krn') needs.add('tracker');
  const adopted = existsSync(join(root, CONTRACT_FILE)) || needs.has('tracker');
  const stack = detectStack(root)?.stack;
  return stack === undefined ? { adopted, needs } : { stack, adopted, needs };
}

function tail(output: string): string {
  const lines = output.trim().split('\n');
  const last = lines.at(-1)?.trim() ?? '';
  return last.length > 200 ? `${last.slice(0, 200)}...` : last;
}

/** Runs an enforcement in `root` with a timeout; exit null when killed or not started. */
export function enforcer(root: string, timeoutMs: number): Enforce {
  return (enforcement) => {
    const [command, args] =
      enforcement.kind === 'command'
        ? ['sh', ['-c', enforcement.run]]
        : [process.execPath, [krnMain, ...enforcement.args]];
    const done = spawnSync(command, args, {
      cwd: root,
      encoding: 'utf8',
      env: environment(),
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: timeoutMs,
      killSignal: 'SIGKILL',
    });
    if (done.error !== undefined && done.status === null)
      return {
        exit: null,
        detail:
          (done.error as NodeJS.ErrnoException).code === 'ETIMEDOUT'
            ? `timed out after ${timeoutMs} ms`
            : done.error.message,
      };
    if (done.status === null)
      return { exit: null, detail: `killed by ${done.signal}` };
    return {
      exit: done.status,
      detail: done.status === 0 ? '' : tail(done.stderr || done.stdout),
    };
  };
}

export type Verdict = { readonly exitCode: number; readonly lines: string[] };

export function standardsCheck(
  root: string,
  asOf: string,
  options: { readonly pack?: string; readonly timeoutMs?: number } = {},
): Verdict {
  let records: Standard[];
  let project: Standard[] = [];
  try {
    records = parseFile(options.pack ?? productRoot, PACK);
    if (existsSync(join(root, PROJECT_STANDARDS)))
      project = parseFile(root, PROJECT_STANDARDS);
  } catch (error) {
    if (
      !(error instanceof StandardsDataError) &&
      !(error instanceof StandardsInputError)
    )
      throw error;
    return {
      exitCode: error.exitCode,
      lines: [`FAIL standards: ${error.message}`],
    };
  }
  // A project adds standards and never replaces one it inherits: a same-id record would silently
  // neutralise a pack standard. The check runs the root's own commands, so it is for trusted roots.
  const packIds = new Set(records.map((standard) => standard.id));
  const clash = project.filter((standard) => packIds.has(standard.id));
  if (clash.length > 0)
    return {
      exitCode: 65,
      lines: [
        `FAIL standards: ${PROJECT_STANDARDS} redefines pack standard ${clash.map((standard) => standard.id).join(', ')}; give a project standard its own id`,
      ],
    };
  const repository = repositoryFacts(root);
  const inherited = records.filter((standard) =>
    appliesTo(standard, repository),
  );
  const applicable = [...inherited, ...project];
  const report = checkStandards(applicable, {
    asOf,
    enforce: enforcer(root, options.timeoutMs ?? ENFORCEMENT_TIMEOUT_MS),
  });
  const failures: Failure[] = [...report.failures];
  if (report.enforced === 0)
    failures.push({ id: root, message: 'no enforced standard applies' });
  const counts = `${report.enforced} enforced, ${report.failures.length} failed, ${report.advisory} advisory`;
  const summary = `${counts}; ${applicable.length} standards apply to ${root} (${inherited.length} of ${records.length} pack, ${project.length} project; stack ${repository.stack ?? 'none'}; krn ${repository.adopted ? 'adopted' : 'not adopted'})`;
  if (failures.length === 0)
    return { exitCode: 0, lines: [`PASS standards: ${summary}`] };
  return {
    exitCode: 1,
    lines: [
      ...failures.map((failure) => `${failure.id}: ${failure.message}`),
      `FAIL standards: ${summary}`,
    ],
  };
}

function parse(args: readonly string[]): { root: string } {
  const [verb, ...rest] = args;
  if (verb !== 'check') throw new CliUsageError(usage);
  let root = process.cwd();
  for (let i = 0; i < rest.length; i++) {
    const value = rest[i + 1];
    if (rest[i] === '--root' && value !== undefined && !value.startsWith('-')) {
      root = value;
      i++;
    } else throw new CliUsageError(usage);
  }
  return { root: repositoryRoot(resolve(root)) };
}

export function standardsCommand(args: string[]): void {
  const { root } = parse(args);
  const verdict = standardsCheck(root, new Date().toISOString().slice(0, 10));
  const verdictLine = verdict.lines.at(-1) ?? '';
  for (const line of verdict.lines.slice(0, -1))
    process.stderr.write(`${line}\n`);
  process.stdout.write(`${verdictLine}\n`);
  process.exitCode = verdict.exitCode;
}
