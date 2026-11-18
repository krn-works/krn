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
import { CliUsageError } from '../cli-kit/usage-error.ts';
import { claudeDir } from '../harness/claude.ts';
import {
  CONTRACT_FILE,
  contractConventions,
  contractTracker,
  detectStack,
} from '../repo/contract.ts';
import { pruneRegistry, registryPath } from './adopted-registry.ts';
import { ingestCandidate } from './candidate-ingest.ts';
import { isUnservedType } from './decisions.ts';
import {
  appendExposure,
  effectRows,
  effectTotals,
  exposureOf,
  readExposures,
  servedOverlap,
} from './exposures.ts';
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
  parseResearchCandidate,
  proposalFileName,
  RESEARCH_DIR,
  renderBulletHarvest,
  renderHarvest,
  type Sourced,
  staleResearch,
} from './proposals.ts';
import { recordsInForce, retirable, retireInFile } from './retire.ts';
import { harvestRules, harvestSkills } from './skill-harvest.ts';
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
import { renderReview, reviewStandards } from './standards-review.ts';
import { usage } from './standards-verbs.ts';
import { NO_MATCH, queryOutcome, renderHit } from './worker-packet.ts';

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
  // A command enforcement reaches the product CLI (one owner for shared resolution) through these, not through PATH.
  env.KRN_NODE = process.execPath;
  env.KRN_MAIN = krnMain;
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
  if (isWordPress(root)) needs.add('wordpress');
  if (needs.has('wordpress') || hasFrontendBuild(root)) needs.add('frontend');
  return stack === undefined ? { adopted, needs } : { stack, adopted, needs };
}

function readText(path: string): string {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return '';
  }
}

/** WordPress: a classic or Bedrock tree, or a Composer project requiring WordPress or Bedrock. */
function isWordPress(root: string): boolean {
  return (
    ['wp-config.php', 'wp-content', 'web/wp-config.php', 'web/app'].some(
      (path) => existsSync(join(root, path)),
    ) ||
    /"(?:roots\/(?:bedrock|wordpress)|johnpbloch\/wordpress[\w-]*)"/u.test(
      readText(join(root, 'composer.json')),
    ) ||
    /^\s*Theme Name:/mu.test(readText(join(root, 'style.css'))) ||
    hasPluginHeader(root)
  );
}

/** A plugin: a top-level PHP file whose opening comment names the plugin. */
function hasPluginHeader(root: string): boolean {
  try {
    return readdirSync(root).some(
      (name) =>
        name.endsWith('.php') &&
        /^[ \t*@]*Plugin Name:/mu.test(
          readText(join(root, name)).slice(0, 8192),
        ),
    );
  } catch {
    return false;
  }
}

/** A package.json that depends on a CSS or asset build tool. */
function hasFrontendBuild(root: string): boolean {
  return /"(?:vite|sass|postcss|tailwindcss|@tailwindcss\/[\w-]+)"/u.test(
    readText(join(root, 'package.json')),
  );
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
      return (done.error as NodeJS.ErrnoException).code === 'ETIMEDOUT'
        ? {
            exit: null,
            detail: `timed out after ${timeoutMs} ms`,
            timedOut: true,
          }
        : { exit: null, detail: done.error.message };
    if (done.status === null)
      return { exit: null, detail: `killed by ${done.signal}` };
    return {
      exit: done.status,
      detail: done.status === 0 ? '' : tail(done.stderr || done.stdout),
    };
  };
}

/**
 * Per record, whether its own enforcement fails in `root`: true on a non-zero exit, false on exit 0,
 * null when the record is unknown, advisory, or its run timed out or was killed (it proves nothing).
 */
export function recordChecks(
  root: string,
  ids: readonly string[],
  timeoutMs: number = ENFORCEMENT_TIMEOUT_MS,
): Record<string, boolean | null> {
  const known = new Map<string, Standard>();
  try {
    for (const standard of readPack()) known.set(standard.id, standard);
  } catch {
    /* No readable pack: only the project's records can be checked. */
  }
  for (const standard of readProject(root)) known.set(standard.id, standard);
  const enforce = enforcer(root, timeoutMs);
  return Object.fromEntries(
    [...new Set(ids)].map((id) => {
      const enforcement = known.get(id)?.enforcement;
      if (enforcement === undefined || enforcement.kind === 'advisory')
        return [id, null] as const;
      const outcome = enforce(enforcement);
      if (outcome.timedOut === true || outcome.exit === null)
        return [id, null] as const;
      return [id, outcome.exit !== 0] as const;
    }),
  );
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
  // A pack record without a layer and without enforcement is edit-moment guidance harvested from a
  // skill: the edit hook serves it, no check can judge it.
  const inherited = records.filter(
    (standard) =>
      appliesTo(standard, repository) &&
      !(
        standard.layer === undefined && standard.enforcement.kind === 'advisory'
      ),
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
  options: {
    readonly pack?: string;
    readonly timeoutMs?: number;
    /** Judge one record only: other standards, red or not, do not change the verdict. */
    readonly record?: string;
  } = {},
): Verdict {
  const evaluated = evaluate(root, asOf, options);
  if ('verdict' in evaluated) return evaluated.verdict;
  if (options.record !== undefined) {
    const id = options.record;
    if (!evaluated.applicable.some((standard) => standard.id === id))
      return {
        exitCode: 1,
        lines: [
          `${id}: no standard with this id applies to ${root}`,
          `FAIL standards: record ${id} not found`,
        ],
      };
    const own = evaluated.failures.filter((failure) => failure.id === id);
    const late = evaluated.report.timedOut.filter((item) => item.id === id);
    if (own.length === 0 && late.length > 0)
      return {
        exitCode: 0,
        lines: [
          ...late.map((item) => `${item.id}: ${item.message}`),
          `PASS standards: record ${id} timed out, not judged`,
        ],
      };
    if (own.length === 0)
      return { exitCode: 0, lines: [`PASS standards: record ${id} passes`] };
    return {
      exitCode: 1,
      lines: [
        ...own.map((failure) => `${failure.id}: ${failure.message}`),
        `FAIL standards: record ${id} fails`,
      ],
    };
  }
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
  const late = report.timedOut.length;
  const counts = `${report.enforced} enforced, ${failures.length} failed${late > 0 ? `, ${late} timed-out` : ''}, ${report.advisory} advisory; ${perTier}`;
  const summary = `${counts}; ${applicable.length} standards apply to ${root} (${inherited.length} of ${records.length} pack, ${project.length} project; stack ${repository.stack ?? 'none'}; krn ${repository.adopted ? 'adopted' : 'not adopted'})`;
  const notes = [
    ...reported.map(
      (failure) =>
        `${failure.id}: ${failure.message} (${failure.tier === 'reflex' ? 'waived reflex' : 'finish'}, reported only)`,
    ),
    ...report.timedOut.map(
      (item) => `${item.id}: ${item.message} (not judged, never blocking)`,
    ),
  ];
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
  const why = new Map(
    applicable.map((standard) => [standard.id, standard.why]),
  );
  // The diff's offending lines of the records that stop the session: a waived reflex and a finish record are skipped.
  const stopping = applicable.filter(
    (standard) =>
      standard.tier === 'floor' ||
      (standard.tier === 'reflex' && standard.waiver === undefined),
  );
  const at = new Map<string, string[]>();
  for (const hit of reviewStandards(root, stopping).violations)
    at.set(hit.id, [...(at.get(hit.id) ?? []), `${hit.file}:${hit.line}`]);
  return report.blocking.map((failure) => {
    const reason = why.get(failure.id);
    const where = at.get(failure.id);
    return `${failure.id} (${failure.tier ?? 'standard'}): ${failure.message}${where ? `\n  at: ${where.join(', ')}` : ''}${reason ? `\n  why: ${reason}` : ''}`;
  });
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
const CHECK_FLAGS = new Set(['--root', '--record']);

export function checkCommand(rest: readonly string[]): void {
  const { values, positional } = flags(rest, new Set(), CHECK_FLAGS);
  if (positional.length > 0) throw new CliUsageError(usage);
  const root = repositoryRoot(
    resolve(values.get('--root')?.[0] ?? process.cwd()),
  );
  const asOf = new Date().toISOString().slice(0, 10);
  const verdict = standardsCheck(root, asOf, {
    ...(values.has('--record') && {
      record: values.get('--record')?.[0] as string,
    }),
  });
  const verdictLine = verdict.lines.at(-1) ?? '';
  for (const line of verdict.lines.slice(0, -1))
    process.stderr.write(`${line}\n`);
  process.stdout.write(`${verdictLine}\n`);
  process.exitCode = verdict.exitCode;
}

/** `krn standards review [--root DIR]`: the enforced records the diff can break, with offending file:line; exit 1 on a violation. */
export function reviewCommand(rest: readonly string[]): void {
  const { values, positional } = flags(rest, new Set(), ROOT);
  if (positional.length > 0) throw new CliUsageError(usage);
  const root = repositoryRoot(
    resolve(values.get('--root')?.[0] ?? process.cwd()),
  );
  const asOf = new Date().toISOString().slice(0, 10);
  const repository = repositoryFacts(root);
  const standards = [
    ...readPack().filter((standard) => appliesTo(standard, repository)),
    ...readProject(root),
  ].filter((standard) => inForce(standard, asOf));
  const review = reviewStandards(root, standards);
  const lines = renderReview(review);
  for (const line of lines.slice(0, -1)) process.stderr.write(`${line}\n`);
  process.stdout.write(`${lines.at(-1)}\n`);
  process.exitCode = review.violations.length === 0 ? 0 : 1;
}

/** `krn standards query --stale-research [--root DIR]`: research candidates past their window with no merged PR and no retire verdict; one row each, then a count. */
function staleResearchCommand(rest: readonly string[]): void {
  const { values, positional } = flags(
    rest.filter((arg) => arg !== '--stale-research'),
    new Set(),
    ROOT,
  );
  if (positional.length > 0) throw new CliUsageError(usage);
  const root = repositoryRoot(
    resolve(values.get('--root')?.[0] ?? process.cwd()),
  );
  const dir = join(root, RESEARCH_DIR);
  const names = existsSync(dir)
    ? readdirSync(dir)
        .filter((name) => name.endsWith('.json'))
        .sort()
    : [];
  const stale = staleResearch(
    names.map((name) => {
      const file = join(dir, name);
      let value: unknown;
      try {
        value = JSON.parse(readFileSync(file, 'utf8'));
      } catch (error) {
        throw new StandardsDataError(
          `${file}: not JSON (${(error as Error).message})`,
        );
      }
      return parseResearchCandidate(value, file);
    }),
    new Date().toISOString().slice(0, 10),
  );
  for (const c of stale)
    process.stdout.write(`${c.id}\t${c.recorded_at}\t${c.claim}\n`);
  process.stdout.write(`stale-research: ${stale.length}\n`);
}

const QUERY_SINGLE = new Set([
  '--root',
  '--stack',
  '--budget',
  '--task',
  '--type',
]);

/** The main checkout of a repository (a worktree logs to its main), where the exposure log lives. */
function mainCheckout(root: string): string {
  const common = spawnSync(
    'git',
    ['-C', root, 'rev-parse', '--git-common-dir'],
    {
      encoding: 'utf8',
      env: environment(),
    },
  );
  return common.status === 0
    ? dirname(resolve(root, common.stdout.trim()))
    : root;
}

/** `krn standards query TEXT`: the ranked records that apply to what the session is doing now; each shown record is logged as a "query" exposure. */
export function queryCommand(rest: readonly string[]): void {
  if (rest.includes('--stale-research')) {
    staleResearchCommand(rest);
    return;
  }
  const json = rest.includes('--json');
  const { values, positional } = flags(
    rest.filter((arg) => arg !== '--json'),
    new Set(['--file']),
    QUERY_SINGLE,
  );
  const text = positional.join(' ').trim();
  const budgetText = values.get('--budget')?.[0];
  const budget = budgetText === undefined ? undefined : Number(budgetText);
  if (text === '' || (budget !== undefined && !(budget > 0)))
    throw new CliUsageError(usage);
  const root = repositoryRoot(
    resolve(values.get('--root')?.[0] ?? process.cwd()),
  );
  const stack = values.get('--stack')?.[0];
  const task = values.get('--task')?.[0];
  const type = values.get('--type')?.[0];
  const { hits, withheld } = queryOutcome(root, {
    ...(type === undefined ? {} : { type }),
    text,
    files: values.get('--file') ?? [],
    asOf: new Date().toISOString().slice(0, 10),
    ...(stack === undefined ? {} : { stack }),
    ...(task === undefined ? {} : { task }),
    ...(budget === undefined ? {} : { budget }),
  });
  if (hits.length > 0 && !(type !== undefined && isUnservedType(type)))
    try {
      appendExposure(
        mainCheckout(root),
        exposureOf({
          run: process.env.CLAUDE_SESSION_ID ?? `query-${Date.now()}`,
          task,
          channel: 'query',
          served: hits.map((hit) => hit.id),
          withheld,
          laneOk: true,
        }),
      );
    } catch {
      /* The log is evidence, never a reason to lose the answer. */
    }
  process.stdout.write(
    json
      ? `${JSON.stringify(hits)}\n`
      : `${hits.length === 0 ? NO_MATCH : hits.map(renderHit).join('\n')}\n`,
  );
}

export function effectCommand(rest: readonly string[]): void {
  const overlapOnly = rest.includes('--overlap');
  const { values, positional } = flags(
    rest.filter((arg) => arg !== '--overlap'),
    new Set(),
    ROOT,
  );
  if (positional.length > 0) throw new CliUsageError(usage);
  const root = repositoryRoot(
    resolve(values.get('--root')?.[0] ?? process.cwd()),
  );
  const exposures = readExposures(root);
  if (overlapOnly) {
    const overlap = servedOverlap(exposures);
    process.stdout.write(
      overlap === null
        ? 'overlap: fewer than 2 tasks served\n'
        : `overlap: mean Jaccard ${overlap.mean.toFixed(2)} over ${overlap.pairs} pair(s) of ${overlap.tasks} task(s)\n`,
    );
    return;
  }
  const rows = effectRows(exposures);
  process.stdout.write(
    `${[`effect: ${exposures.length} run(s), ${rows.length} record(s)`, ...rows].join('\n')}\n`,
  );
}

/** The records files a repository owns, relative to its root: the conventions file and the project standards. */
function ownRecordFiles(root: string): string[] {
  return [contractConventions(root), PROJECT_STANDARDS].filter((file) =>
    existsSync(join(root, file)),
  );
}

export function retireCommand(rest: readonly string[]): void {
  const write = rest.includes('--write');
  const { values, positional } = flags(
    rest.filter((arg) => arg !== '--write'),
    new Set(),
    ROOT,
  );
  if (positional.length > 0) throw new CliUsageError(usage);
  const root = repositoryRoot(
    resolve(values.get('--root')?.[0] ?? process.cwd()),
  );
  const asOf = new Date().toISOString().slice(0, 10);
  const files = ownRecordFiles(root);
  const inForce = new Set(
    files.flatMap((file) => recordsInForce(join(root, file), asOf)),
  );
  const exposures = readExposures(root);
  const ids = retirable(exposures, inForce);
  const totals = effectTotals(exposures);
  const lines = ids.map((id) => {
    const t = totals.get(id);
    return `${id}: served ${t?.servedScoped ?? 0} scoped (violated ${t?.servedViolated ?? 0}) withheld ${t?.withheldScoped ?? 0} scoped (violated ${t?.withheldViolated ?? 0})`;
  });
  const set = new Set(ids);
  const changed = write
    ? files.flatMap((file) => retireInFile(join(root, file), set, asOf))
    : [];
  process.stdout.write(
    `${[`retire: ${ids.length} record(s) show no effect${write ? `, valid_to ${asOf} written to ${changed.length}` : ' (dry run, --write edits valid_to)'}`, ...lines].join('\n')}\n`,
  );
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

export function proposeCommand(rest: readonly string[]): void {
  const { values, positional } = flags(
    rest,
    new Set(['--evidence']),
    new Set(['--root', '--text', '--kind', '--from-candidate']),
  );
  const candidateFile = values.get('--from-candidate')?.[0];
  if (candidateFile !== undefined) {
    if (positional.length > 0 || values.size > (values.has('--root') ? 2 : 1))
      throw new CliUsageError(usage);
    const root = repositoryRoot(
      resolve(values.get('--root')?.[0] ?? process.cwd()),
    );
    const { file, created } = ingestCandidate(
      root,
      resolve(candidateFile),
      new Date().toISOString().slice(0, 10),
    );
    process.stdout.write(
      `${created ? 'ingested' : 'already ingested'} ${file}; commit it with the slice\n`,
    );
    return;
  }
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

/** The repositories of the host registry `krn adopt` writes; an error when none is registered. */
export function hostRepositories(): string[] {
  const file = registryPath();
  const { roots: listed, pruned } = pruneRegistry(file);
  if (pruned > 0)
    process.stderr.write(`pruned ${pruned} missing paths from ${file}\n`);
  if (listed.length === 0)
    throw new StandardsInputError(
      `krn standards harvest: no repository given and none registered in ${file}`,
    );
  return listed;
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
export function standardsHarvest(
  repositories: readonly string[],
  extra: (root: string) => Sourced[] = () => [],
): string[] {
  const roots = [...new Set(repositories.map((path) => repositoryRoot(path)))];
  const sourced = roots.flatMap((root) => [
    ...readProposals(root),
    ...extra(root),
  ]);
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

/** The skill directories a harvest reads: the Claude one, plus the agents one when it reads rules. */
function skillDirectories(rules: boolean): string[] {
  return rules ? [claudeDir, '.agents'] : [claudeDir];
}

/**
 * Prints the harvested records of the skill files of a repository as a JSON array: one trial
 * record per skill, or with `rules` the accepted scoped rule records of the skills it holds
 * (`.claude/skills` and `.agents/skills`); reads the repository, never writes it.
 */
function skillsHarvest(
  repository: string,
  commitFlag?: string,
  rules = false,
): void {
  const roots = skillDirectories(rules).filter((dir) =>
    existsSync(join(repository, dir, 'skills')),
  );
  if (roots.length === 0)
    throw new StandardsInputError(
      `krn standards: ${join(repository, claudeDir, 'skills')} holds no skills (<name>/SKILL.md)`,
    );
  const sources = roots.flatMap((dir) => {
    const directory = join(repository, dir, 'skills');
    return readdirSync(directory)
      .sort()
      .filter((name) => existsSync(join(directory, name, 'SKILL.md')))
      .map((name) => ({
        path: `${dir}/skills/${name}/SKILL.md`,
        text: readFileSync(join(directory, name, 'SKILL.md'), 'utf8'),
      }));
  });
  const logged = spawnSync(
    'git',
    [
      '-C',
      repository,
      'log',
      '-1',
      '--format=%H',
      '--',
      ...roots.map((dir) => `${dir}/skills`),
    ],
    { encoding: 'utf8', env: environment() },
  );
  const commit = commitFlag ?? logged.stdout.trim();
  if (!/^[0-9a-f]{40}$/u.test(commit))
    throw new StandardsInputError(
      `krn standards: no commit of ${join(repository, roots[0] ?? claudeDir, 'skills')}; name one with --commit SHA`,
    );
  const today = new Date().toISOString().slice(0, 10);
  const records = rules
    ? harvestRules(sources, commit, today)
    : harvestSkills(sources, commit, today);
  process.stdout.write(`${JSON.stringify(records, null, 2)}\n`);
}

/** A `--repos` with no directory after it names the registered adopted repositories. */
function bareRepos(rest: readonly string[]): boolean {
  const at = rest.indexOf('--repos');
  if (at < 0) return false;
  const next = rest[at + 1];
  return next === undefined || next.startsWith('-');
}

export function harvestCommand(rest: readonly string[]): void {
  const everyAdopted = bareRepos(rest);
  const rules = rest.includes('--rules');
  const parsed = flags(
    rest.filter(
      (arg) => arg !== '--rules' && !(everyAdopted && arg === '--repos'),
    ),
    new Set(['--repos']),
    new Set(['--root', '--repos-file', '--skills', '--commit']),
  );
  const { values, positional } = parsed;
  const skills = values.get('--skills')?.[0];
  if (skills !== undefined) {
    skillsHarvest(resolve(skills), values.get('--commit')?.[0], rules);
    return;
  }
  if (everyAdopted || values.has('--repos') || values.has('--repos-file')) {
    const file = values.get('--repos-file')?.[0];
    const directories = [
      ...(values.get('--repos') ?? []),
      ...(everyAdopted ? hostRepositories() : []),
      ...positional,
      ...(file === undefined ? [] : repositoryList(resolve(file))),
    ];
    if (directories.length === 0) throw new CliUsageError(usage);
    for (const line of instructionHarvest(directories))
      process.stdout.write(`${line}\n`);
    return;
  }
  const rootFlag = values.get('--root')?.[0];
  const repositories =
    positional.length > 0
      ? positional.map((path) => resolve(path))
      : rootFlag === undefined
        ? hostRepositories()
        : adoptedRepositories(resolve(rootFlag));
  for (const line of standardsHarvest(repositories))
    process.stdout.write(`${line}\n`);
}

export function installCommand(rest: readonly string[]): void {
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
