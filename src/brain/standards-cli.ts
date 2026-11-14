// `krn standards check [--root DIR]`: run the enforcement of every standard that applies to one
// repository (the shipped pack plus its .agents/standards.json) and print one PASS or FAIL line.
// `krn standards propose` writes a retro lesson as a tracked proposal file in a repository;
// `krn standards harvest` groups the proposals of adopted repositories into pack candidates.
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CliUsageError } from '../cli/usage-error.ts';
import {
  CONTRACT_FILE,
  contractTracker,
  detectStack,
} from '../repo/contract.ts';
import { globalDrift, installGlobal } from './global-standards.ts';
import {
  formatProposal,
  harvestCandidates,
  harvestInstructionBullets,
  INSTRUCTION_FILES,
  type InstructionSource,
  normalizeText,
  PROPOSAL_KINDS,
  PROPOSALS_DIR,
  type ProposalKind,
  parseProposal,
  proposalFileName,
  renderBulletHarvest,
  renderHarvest,
  type Sourced,
} from './proposals.ts';
import {
  appliesTo,
  assertNoClash,
  checkStandards,
  type Enforce,
  type Failure,
  inForce,
  type Need,
  parsePack,
  parseStandards,
  promotionFailures,
  type Repository,
  type Standard,
  StandardsDataError,
  type Report as StandardsReport,
  splitProject,
} from './standards.ts';

export const usage =
  'usage: krn standards check [--root DIR] | install --global [--check] | propose --text TEXT --kind check|template|skill|prose --evidence REF [--evidence REF]... [--root DIR] | harvest [REPO...] [--root DIR] | harvest --repos DIR... [--repos-file FILE]';

/** The pack KRN ships, relative to the product root. */
export const PACK = 'standards/records.json';
/** A project's own standards, relative to its root; they add to the pack and never share a pack id. */
export const PROJECT_STANDARDS = '.agents/standards.json';
/** The host-local list of adopted repositories `harvest` reads when given none: a JSON array of paths, untracked because it names private repositories. */
export const ADOPTED_LIST = '.krn/adopted.json';
/** How long one enforcement may run before it counts as failed. */
export const ENFORCEMENT_TIMEOUT_MS = 60_000;

const productRoot = fileURLToPath(new URL('../..', import.meta.url));
const krnMain = fileURLToPath(new URL('../cli/main.ts', import.meta.url));

/** The checked root is missing, unreadable or not a repository's own top level. */
export class StandardsInputError extends Error {
  readonly exitCode = 66;
}

function parseFile(
  root: string,
  path: string,
  parse: (value: unknown) => Standard[] = parseStandards,
): Standard[] {
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
    return parse(value);
  } catch (error) {
    if (error instanceof StandardsDataError)
      throw new StandardsDataError(`${path}: ${error.message}`);
    throw error;
  }
}

/** The pack KRN ships (or the one under `product`, for tests). */
export function readPack(product: string = productRoot): Standard[] {
  return parseFile(product, PACK, parsePack);
}

/** The project's standards file, empty when the repository has none. */
export function readProject(root: string): Standard[] {
  return existsSync(join(root, PROJECT_STANDARDS))
    ? parseFile(root, PROJECT_STANDARDS)
    : [];
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
    throw new StandardsInputError(`krn standards: ${root} is not a directory`);
  const top = spawnSync('git', ['-C', root, 'rev-parse', '--show-toplevel'], {
    encoding: 'utf8',
    env: environment(),
  });
  if (top.status !== 0)
    throw new StandardsInputError(
      `krn standards: ${root} is not a git repository (${top.stderr.trim() || `git exit ${top.status}`})`,
    );
  const real = realpathSync(root);
  const toplevel = realpathSync(top.stdout.trim());
  if (real !== toplevel)
    throw new StandardsInputError(
      `krn standards: ${root} is not the top level of its git repository (${toplevel})`,
    );
  return real;
}

/** The stack, adoption and tracker of `root`, a repository top level. */
export function repositoryFacts(root: string): Repository {
  const needs = new Set<Need>();
  if (contractTracker(root) === 'krn') needs.add('tracker');
  const adopted = existsSync(join(root, CONTRACT_FILE)) || needs.has('tracker');
  // A Composer project without PHPUnit has no detected test stack but is still PHP.
  const stack =
    detectStack(root)?.stack ??
    (existsSync(join(root, 'composer.json')) ? 'php' : undefined);
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

type Evaluation =
  | { readonly verdict: Verdict }
  | {
      readonly report: StandardsReport;
      readonly failures: Failure[];
      readonly blocking: Failure[];
      readonly records: Standard[];
      readonly project: Standard[];
      readonly inherited: Standard[];
      readonly applicable: Standard[];
      readonly repository: Repository;
    };

function evaluate(
  root: string,
  asOf: string,
  options: { readonly pack?: string; readonly timeoutMs?: number },
): Evaluation {
  let records: Standard[];
  let project: Standard[];
  let copies: Standard[];
  try {
    records = readPack(options.pack);
    const split = splitProject(readProject(root));
    project = split.own;
    copies = split.inherited;
    // A project adds standards and never replaces one it inherits: a same-id record would silently
    // neutralise a pack standard. The check runs the root's own commands, so it is for trusted roots.
    assertNoClash(records, project, PROJECT_STANDARDS);
  } catch (error) {
    if (
      !(error instanceof StandardsDataError) &&
      !(error instanceof StandardsInputError)
    )
      throw error;
    return {
      verdict: {
        exitCode: error.exitCode,
        lines: [`FAIL standards: ${error.message}`],
      },
    };
  }
  // An inherited copy runs as the pack's current record; one the pack no longer holds is stale.
  const packIds = new Set(records.map((standard) => standard.id));
  const stale: Failure[] = copies
    .filter((standard) => !packIds.has(standard.id))
    .map((standard) => ({
      id: standard.id,
      message: `inherited from krn but no longer in its pack; rerun krn adopt to refresh ${PROJECT_STANDARDS}`,
    }));
  const repository = repositoryFacts(root);
  const inherited = records.filter((standard) =>
    appliesTo(standard, repository),
  );
  const applicable = [...inherited, ...project];
  const report = checkStandards(applicable, {
    asOf,
    enforce: enforcer(root, options.timeoutMs ?? ENFORCEMENT_TIMEOUT_MS),
  });
  // The pack's own promotion rule: a record harvested from proposals recurs and is enforced.
  const promotion = promotionFailures(records);
  const structural: Failure[] = [...promotion, ...stale];
  if (report.enforced === 0)
    structural.push({ id: root, message: 'no enforced standard applies' });
  const failures: Failure[] = [...structural, ...report.failures];
  const blocking: Failure[] = [...structural, ...report.blocking];
  return {
    report,
    failures,
    blocking,
    records,
    project,
    inherited,
    applicable,
    repository,
  };
}

/** Every failing standard of `root` with its tier, for a caller that reports gaps instead of a verdict. */
export function standardsFailures(
  root: string,
  asOf: string,
  options: { readonly pack?: string; readonly timeoutMs?: number } = {},
): readonly Failure[] {
  const evaluated = evaluate(root, asOf, options);
  return 'verdict' in evaluated ? [] : evaluated.failures;
}

export function standardsCheck(
  root: string,
  asOf: string,
  options: { readonly pack?: string; readonly timeoutMs?: number } = {},
): Verdict {
  const evaluated = evaluate(root, asOf, options);
  if ('verdict' in evaluated) return evaluated.verdict;
  const {
    report,
    failures,
    blocking,
    records,
    project,
    inherited,
    applicable,
    repository,
  } = evaluated;
  const reported = failures.filter((failure) => !blocking.includes(failure));
  const { floor, reflex, finish } = report.tiers;
  const perTier = `floor ${floor.failed}/${floor.enforced}, reflex ${reflex.failed}/${reflex.enforced}, finish ${finish.failed}/${finish.enforced} failed/enforced`;
  const counts = `${report.enforced} enforced, ${failures.length} failed, ${report.advisory} advisory; ${perTier}`;
  const summary = `${counts}; ${applicable.length} standards apply to ${root} (${inherited.length} of ${records.length} pack, ${project.length} project; stack ${repository.stack ?? 'none'}; krn ${repository.adopted ? 'adopted' : 'not adopted'})`;
  const notes = reported.map(
    (failure) =>
      `${failure.id}: ${failure.message} (${failure.tier === 'reflex' ? 'waived reflex' : 'finish'}, reported only)`,
  );
  if (blocking.length === 0)
    return { exitCode: 0, lines: [...notes, `PASS standards: ${summary}`] };
  return {
    exitCode: 1,
    lines: [
      ...blocking.map((failure) => `${failure.id}: ${failure.message}`),
      ...notes,
      `FAIL standards: ${summary}`,
    ],
  };
}

/**
 * The failures of the project's own standards file that must stop a worker: floor and unwaived
 * reflex. Runs only the records in `.agents/standards.json` that apply and are in force (the
 * pack is not read), so the Stop hook stays fast; no file or no record means nothing blocks.
 */
export function standardsBlockers(
  root: string,
  asOf: string,
  timeoutMs: number = ENFORCEMENT_TIMEOUT_MS,
): string[] {
  const repository = repositoryFacts(root);
  const applicable = readProject(root).filter(
    (standard) =>
      appliesTo(standard, repository) &&
      inForce(standard, asOf) &&
      standard.audience === 'worker',
  );
  const report = checkStandards(applicable, {
    asOf,
    enforce: enforcer(root, timeoutMs),
  });
  return report.blocking.map(
    (failure) =>
      `${failure.id} (${failure.tier ?? 'standard'}): ${failure.message}`,
  );
}

function flags(
  rest: readonly string[],
  repeatable: ReadonlySet<string>,
  single: ReadonlySet<string>,
): { values: Map<string, string[]>; positional: string[] } {
  const values = new Map<string, string[]>();
  const positional: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const flag = rest[i] ?? '';
    if (!flag.startsWith('-')) {
      positional.push(flag);
      continue;
    }
    const value = rest[i + 1];
    if (
      (!repeatable.has(flag) && !single.has(flag)) ||
      value === undefined ||
      value.startsWith('-') ||
      (single.has(flag) && values.has(flag))
    )
      throw new CliUsageError(usage);
    values.set(flag, [...(values.get(flag) ?? []), value]);
    i++;
  }
  return { values, positional };
}

const ROOT = new Set(['--root']);

function checkCommand(rest: readonly string[]): void {
  const { values, positional } = flags(rest, new Set(), ROOT);
  if (positional.length > 0) throw new CliUsageError(usage);
  const root = repositoryRoot(
    resolve(values.get('--root')?.[0] ?? process.cwd()),
  );
  const verdict = standardsCheck(root, new Date().toISOString().slice(0, 10));
  const verdictLine = verdict.lines.at(-1) ?? '';
  for (const line of verdict.lines.slice(0, -1))
    process.stderr.write(`${line}\n`);
  process.stdout.write(`${verdictLine}\n`);
  process.exitCode = verdict.exitCode;
}

/** Writes one proposal file into `root`; an equal lesson already proposed there is kept, not duplicated. */
export function propose(
  root: string,
  input: {
    readonly text: string;
    readonly kind: string;
    readonly evidence: readonly string[];
  },
  asOf: string,
): { readonly file: string; readonly created: boolean } {
  const proposal = parseProposal({
    text: input.text,
    kind: input.kind,
    evidence: [...input.evidence],
    recorded_at: asOf,
  });
  const file = `${PROPOSALS_DIR}/${proposalFileName(proposal.text)}`;
  const path = join(root, file);
  if (existsSync(path)) {
    const existing = parseProposal(
      JSON.parse(readFileSync(path, 'utf8')),
      file,
    );
    if (normalizeText(existing.text) === normalizeText(proposal.text))
      return { file, created: false };
    throw new StandardsDataError(
      `${file} already holds another lesson: ${existing.text}`,
    );
  }
  mkdirSync(join(root, PROPOSALS_DIR), { recursive: true });
  writeFileSync(path, formatProposal(proposal));
  return { file, created: true };
}

function proposeCommand(rest: readonly string[]): void {
  const { values, positional } = flags(
    rest,
    new Set(['--evidence']),
    new Set(['--root', '--text', '--kind']),
  );
  const text = values.get('--text')?.[0];
  const kind = values.get('--kind')?.[0];
  const evidence = values.get('--evidence') ?? [];
  if (
    positional.length > 0 ||
    text === undefined ||
    kind === undefined ||
    evidence.length === 0
  )
    throw new CliUsageError(usage);
  if (!PROPOSAL_KINDS.includes(kind as ProposalKind))
    throw new CliUsageError(
      `krn standards propose: --kind must be one of ${PROPOSAL_KINDS.join(', ')}, got ${JSON.stringify(kind)}\n${usage}`,
    );
  const root = repositoryRoot(
    resolve(values.get('--root')?.[0] ?? process.cwd()),
  );
  const { file, created } = propose(
    root,
    { text, kind, evidence },
    new Date().toISOString().slice(0, 10),
  );
  process.stdout.write(
    `${created ? 'proposed' : 'already proposed'} ${file}; commit it with the slice\n`,
  );
}

/** The repositories `harvest` reads when given none: the paths in `<root>/.krn/adopted.json`. */
export function adoptedRepositories(root: string): string[] {
  const path = join(root, ADOPTED_LIST);
  if (!existsSync(path))
    throw new StandardsInputError(
      `krn standards harvest: no repository given and no ${ADOPTED_LIST} in ${root}`,
    );
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new StandardsDataError(
      `${ADOPTED_LIST}: not JSON (${(error as Error).message})`,
    );
  }
  if (
    !Array.isArray(value) ||
    value.some((entry) => typeof entry !== 'string' || entry.trim() === '')
  )
    throw new StandardsDataError(
      `${ADOPTED_LIST}: expected a JSON array of repository paths`,
    );
  return (value as string[]).map((entry) =>
    isAbsolute(entry) ? entry : resolve(root, entry),
  );
}

/** Every proposal of one repository top level, in file-name order; none when it has no proposals. */
export function readProposals(root: string): Sourced[] {
  const dir = join(root, PROPOSALS_DIR);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith('.json'))
    .sort()
    .map((name) => {
      const file = `${PROPOSALS_DIR}/${name}`;
      let value: unknown;
      try {
        value = JSON.parse(readFileSync(join(root, file), 'utf8'));
      } catch (error) {
        throw new StandardsDataError(
          `${root}/${file}: not JSON (${(error as Error).message})`,
        );
      }
      return {
        origin: basename(root),
        repository: root,
        file,
        proposal: parseProposal(value, `${root}/${file}`),
      };
    });
}

/** Groups the proposals of `repositories` (repository top levels) into report lines. */
export function standardsHarvest(repositories: readonly string[]): string[] {
  const roots = [...new Set(repositories.map((path) => repositoryRoot(path)))];
  const sourced = roots.flatMap(readProposals);
  return renderHarvest(harvestCandidates(sourced), roots.length);
}

/** The paths of a `--repos-file`: one per line, blank lines and `#` comments ignored; relative to the file. */
export function repositoryList(file: string): string[] {
  if (!existsSync(file))
    throw new StandardsInputError(`krn standards harvest: no file ${file}`);
  return readFileSync(file, 'utf8')
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#'))
    .map((line) => resolve(dirname(file), line));
}

/** Recurring AGENTS.md and CLAUDE.md bullets of the named directories (read as data, never written). */
export function instructionHarvest(directories: readonly string[]): string[] {
  const roots = [...new Set(directories.map((path) => resolve(path)))];
  const sources: InstructionSource[] = [];
  for (const root of roots) {
    if (!existsSync(root))
      throw new StandardsInputError(
        `krn standards harvest: no directory ${root}`,
      );
    for (const file of INSTRUCTION_FILES) {
      const path = join(root, file);
      if (existsSync(path))
        sources.push({
          repository: root,
          origin: basename(root),
          file,
          text: readFileSync(path, 'utf8'),
        });
    }
  }
  return renderBulletHarvest(harvestInstructionBullets(sources), roots.length);
}

function harvestCommand(rest: readonly string[]): void {
  const parsed = flags(
    rest,
    new Set(['--repos']),
    new Set(['--root', '--repos-file']),
  );
  const { values, positional } = parsed;
  if (values.has('--repos') || values.has('--repos-file')) {
    const file = values.get('--repos-file')?.[0];
    const directories = [
      ...(values.get('--repos') ?? []),
      ...positional,
      ...(file === undefined ? [] : repositoryList(resolve(file))),
    ];
    if (directories.length === 0) throw new CliUsageError(usage);
    for (const line of instructionHarvest(directories))
      process.stdout.write(`${line}\n`);
    return;
  }
  const repositories =
    positional.length > 0
      ? positional.map((path) => resolve(path))
      : adoptedRepositories(
          resolve(values.get('--root')?.[0] ?? process.cwd()),
        );
  for (const line of standardsHarvest(repositories))
    process.stdout.write(`${line}\n`);
}

function installCommand(rest: readonly string[]): void {
  const flagSet = new Set(rest);
  if (
    !flagSet.has('--global') ||
    rest.some((f) => f !== '--global' && f !== '--check') ||
    flagSet.size !== rest.length
  )
    throw new CliUsageError(usage);
  const asOf = new Date().toISOString().slice(0, 10);
  const home = homedir();
  if (flagSet.has('--check')) {
    const drift = globalDrift(home, productRoot, asOf);
    for (const line of drift) process.stderr.write(`${line}\n`);
    process.stdout.write(
      drift.length === 0
        ? 'PASS global standards\n'
        : `FAIL global standards: ${drift.length} drift\n`,
    );
    process.exitCode = drift.length === 0 ? 0 : 1;
    return;
  }
  const changed = installGlobal(home, productRoot, asOf);
  process.stdout.write(
    `global standards: ${changed.length === 0 ? 'unchanged' : `wrote ${changed.join(', ')}`}\n`,
  );
}

export function standardsCommand(args: string[]): void {
  const [verb, ...rest] = args;
  if (verb === 'check') checkCommand(rest);
  else if (verb === 'install') installCommand(rest);
  else if (verb === 'propose') proposeCommand(rest);
  else if (verb === 'harvest') harvestCommand(rest);
  else throw new CliUsageError(usage);
}
