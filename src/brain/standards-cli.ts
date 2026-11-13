// `krn standards check [--root DIR]`: validate the shipped standards pack and the standards that
// apply to one repository, then print one PASS or FAIL verdict line.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CliUsageError } from '../cli/usage-error.ts';
import { contractTracker, detectStack } from '../repo/contract.ts';
import {
  appliesTo,
  checkStandards,
  health,
  type Need,
  type Problem,
  parseStandards,
  type ReadFile,
  type Repository,
  type Standard,
  StandardsDataError,
} from './standards.ts';

export const usage = 'usage: krn standards check [--root DIR]';

/** The pack KRN ships, relative to the product root. */
export const PACK = 'standards/records.json';
/** A project's own standards, relative to its root; a project record wins over a pack record of its id. */
export const PROJECT_STANDARDS = '.agents/standards.json';

const productRoot = fileURLToPath(new URL('../..', import.meta.url));

/** A reader of files under `root`: a directory reads as empty text, a missing path as undefined. */
export function rootReader(root: string): ReadFile {
  return (path) => {
    const full = join(root, path);
    if (!existsSync(full)) return undefined;
    return statSync(full).isDirectory() ? '' : readFileSync(full, 'utf8');
  };
}

function parseFile(root: string, path: string): Standard[] {
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(join(root, path), 'utf8'));
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

/** The stack and the needs (tracker, CI workflows, a git remote) that `root` offers. */
export function repositoryFacts(root: string): Repository {
  const needs = new Set<Need>();
  if (contractTracker(root) === 'krn') needs.add('tracker');
  if (existsSync(join(root, '.github', 'workflows'))) needs.add('ci');
  const remotes = spawnSync('git', ['-C', root, 'remote'], {
    encoding: 'utf8',
  });
  if (remotes.status === 0 && remotes.stdout.trim() !== '') needs.add('remote');
  const stack = detectStack(root)?.stack;
  return stack === undefined ? { needs } : { stack, needs };
}

export type Verdict = { readonly exitCode: number; readonly lines: string[] };

export function standardsCheck(
  root: string,
  asOf: string,
  pack = productRoot,
): Verdict {
  const problems: Problem[] = [];
  let records: Standard[];
  let project: Standard[] = [];
  try {
    records = parseFile(pack, PACK);
    if (existsSync(join(root, PROJECT_STANDARDS)))
      project = parseFile(root, PROJECT_STANDARDS);
  } catch (error) {
    if (!(error instanceof StandardsDataError)) throw error;
    return {
      exitCode: error.exitCode,
      lines: [`FAIL standards: ${error.message}`],
    };
  }
  problems.push(...checkStandards(records, { asOf, read: rootReader(pack) }));
  problems.push(
    ...checkStandards(project, { asOf, read: rootReader(root) }).map(
      (problem) => ({ ...problem, id: `${PROJECT_STANDARDS} ${problem.id}` }),
    ),
  );
  const repository = repositoryFacts(root);
  const own = new Set(project.map((standard) => standard.id));
  const inherited = records.filter(
    (standard) => !own.has(standard.id) && appliesTo(standard, repository),
  );
  const applicable = [...inherited, ...project];
  if (applicable.length === 0)
    problems.push({ id: root, message: 'no standard applies' });
  const pulse = health(records, asOf);
  const summary = `${applicable.length} standards apply to ${root} (${inherited.length} of ${records.length} pack, ${project.length} project; stack ${repository.stack ?? 'none'}; check/template ${Math.round(pulse.enforced * 100)}%, stale ${pulse.stale}, worker prose ${pulse.workerProse})`;
  if (problems.length === 0)
    return { exitCode: 0, lines: [`PASS standards: ${summary}`] };
  return {
    exitCode: 1,
    lines: [
      ...problems.map((problem) => `${problem.id}: ${problem.message}`),
      `FAIL standards: ${problems.length} problem${problems.length === 1 ? '' : 's'}; ${summary}`,
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
  const full = resolve(root);
  if (!existsSync(full) || !statSync(full).isDirectory())
    throw new CliUsageError(`krn standards check: ${root} is not a directory`);
  return { root: full };
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
