// Parse the explicit local review command and print its exact SHA-bound result.
import { lstatSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { runReview } from './index.ts';
import { PriorRecordError } from './prior.ts';
import { appendOverride } from './record.ts';
import { repoRoot, resolveCommit, validateSha } from './repository.ts';
import {
  attemptRecordPath,
  type PullReader,
  ReviewBudgetError,
  readPullRequest,
  verifyPullRequest,
} from './series.ts';
import {
  panelRoles,
  type ReviewReasoningEffort,
  reasoningEffortSchema,
  reviewInputSchema,
  roleSchema,
} from './types.ts';

export type ReviewCommandOutcome =
  | 'PASS'
  | 'FAIL'
  | 'INCOMPLETE'
  | 'OVERRIDE'
  | 'PREPASS_BLOCKING';

export class ReviewUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReviewUsageError';
  }
}

function value(args: readonly string[], flag: string): string {
  const index = args.indexOf(flag);
  const result = index < 0 ? undefined : args[index + 1];
  if (!result || result.startsWith('--'))
    throw new ReviewUsageError(`missing ${flag}`);
  return result;
}

function panelValue(args: readonly string[]): (typeof panelRoles)[number][] {
  const roles = value(args, '--panel')
    .split(',')
    .map((role) => role.trim());
  const parsed = roleSchema.array().min(1).safeParse(roles);
  if (!parsed.success || new Set(roles).size !== roles.length)
    throw new ReviewUsageError('--panel must contain unique judge roles');
  return parsed.data;
}

function reasoningEffortValue(args: readonly string[]): ReviewReasoningEffort {
  if (!args.includes('--reasoning-effort')) return 'high';
  const parsed = reasoningEffortSchema.safeParse(
    value(args, '--reasoning-effort'),
  );
  if (!parsed.success)
    throw new ReviewUsageError(
      '--reasoning-effort must be one of low, medium, high, xhigh, max',
    );
  return parsed.data;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isProcessSpawnError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'syscall' in error &&
    typeof error.syscall === 'string' &&
    error.syscall.startsWith('spawnSync ')
  );
}

function reviewRepository(repo: string): string {
  try {
    return repoRoot(repo);
  } catch (error) {
    if (isProcessSpawnError(error)) throw error;
    throw new ReviewUsageError(errorMessage(error));
  }
}

function reviewCommit(
  root: string,
  input: string,
  flag: '--base' | '--head',
): string {
  try {
    return flag === '--head'
      ? validateSha(root, input)
      : resolveCommit(root, input);
  } catch (error) {
    if (isProcessSpawnError(error)) throw error;
    throw new ReviewUsageError(errorMessage(error));
  }
}

function reviewLens(input: string): string {
  const path = resolve(input);
  let contents: string;
  try {
    if (!statSync(path).isFile())
      throw new ReviewUsageError('--lens must name a regular file');
    contents = readFileSync(path, 'utf8');
  } catch (error) {
    if (error instanceof ReviewUsageError) throw error;
    throw new ReviewUsageError(`--lens cannot be read: ${errorMessage(error)}`);
  }
  if (!contents.trim()) throw new ReviewUsageError('--lens file is empty');
  if (Buffer.byteLength(contents) > 32 * 1024)
    throw new ReviewUsageError('--lens file exceeds 32 KB');
  return path;
}

function reviewChecklist(args: readonly string[]): string | undefined {
  const prepass = args.includes('--prepass');
  const hasChecklist = args.includes('--checklist');
  if (!prepass) {
    if (hasChecklist)
      throw new ReviewUsageError('--checklist requires --prepass');
    return undefined;
  }
  const path = resolve(value(args, '--checklist'));
  let contents: string;
  try {
    if (!lstatSync(path).isFile())
      throw new ReviewUsageError('--checklist must name a regular file');
    contents = readFileSync(path, 'utf8');
  } catch (error) {
    if (error instanceof ReviewUsageError) throw error;
    throw new ReviewUsageError(
      `--checklist cannot be read: ${errorMessage(error)}`,
    );
  }
  if (!contents.trim() || contents.includes('\0'))
    throw new ReviewUsageError(
      '--checklist must be a non-empty plain-text list',
    );
  if (Buffer.byteLength(contents) > 32 * 1024)
    throw new ReviewUsageError('--checklist file exceeds 32 KB');
  return contents;
}

export async function reviewCommand(
  args: readonly string[],
  options: {
    readonly codexExecutable?: string;
    readonly readPull?: PullReader;
  } = {},
): Promise<ReviewCommandOutcome | undefined> {
  if (args.includes('--help')) {
    process.stdout.write(
      [
        'Usage: krn review --repo <path> --base <ref> --head <sha> --lens <path>',
        '  [--panel standards,spec,adversarial] [--reasoning-effort low|medium|high|xhigh|max]',
        '  [--prepass --checklist <path>] [--prior-record <path>]',
        '  [--pr <number>] [--budget-exception <path>]',
        'PR-bound reviews verify authoritative PR metadata and reserve one of two repo-common attempts before deterministic checks or judges.',
        'Each additional attempt requires a separate operator exception JSON bound to canonical repository, PR, baseRef, exact ordinal and headSha, with authority and evidence.',
        'Round two: --prior-record accepts a first-round FAIL record (regular non-symlink file, at most 1 MB, different head) to verify prior BLOCKING findings.',
        'After two attempts the lead decides; acceptance override does not grant review budget. A second-round record cannot be used as --prior-record.',
        'Prior verification requires the same panel roles. Deterministic checks always block, including under acceptance override.',
        'Only unresolved prior findings and new regressions in changed files block; other new findings are advisory.',
        'With --prior-record, --prepass --checklist supplies a panel search aid without a separate blocking prepass.',
        'Override: krn review --repo <path> --head <sha> [--pr <number> --base <sha>] --override --reason <text> --evidence <text>',
        '',
      ].join('\n'),
    );
    return undefined;
  }
  const controller = new AbortController();
  const abort = () => controller.abort();
  process.on('SIGINT', abort);
  process.on('SIGTERM', abort);
  process.on('SIGHUP', abort);
  try {
    return await runReviewCommand(args, controller, options);
  } catch (error) {
    if (error instanceof PriorRecordError || error instanceof ReviewBudgetError)
      throw new ReviewUsageError(error.message);
    if (!controller.signal.aborted) throw error;
    process.exitCode = 130;
    return undefined;
  } finally {
    process.off('SIGINT', abort);
    process.off('SIGTERM', abort);
    process.off('SIGHUP', abort);
  }
}

async function runReviewCommand(
  args: readonly string[],
  controller: AbortController,
  options: {
    readonly codexExecutable?: string;
    readonly readPull?: PullReader;
  },
): Promise<ReviewCommandOutcome> {
  const switches = new Set(['--prepass', '--override']);
  const flags = new Set([
    '--repo',
    '--base',
    '--head',
    '--lens',
    '--panel',
    '--reasoning-effort',
    '--checklist',
    '--prior-record',
    '--host',
    '--pr',
    '--budget-exception',
    '--reason',
    '--evidence',
  ]);
  const seen = new Set<string>();
  for (let index = 0; index < args.length; index++) {
    const flag = args[index];
    if (!flag || seen.has(flag) || (!switches.has(flag) && !flags.has(flag)))
      throw new ReviewUsageError(
        `unknown or duplicate review argument: ${flag}`,
      );
    seen.add(flag);
    if (!switches.has(flag)) {
      value(args, flag);
      index++;
    }
  }
  const reasoningEffort = reasoningEffortValue(args);
  const repo = value(args, '--repo');
  const headInput = value(args, '--head');
  const pr = args.includes('--pr') ? Number(value(args, '--pr')) : undefined;
  if (
    pr !== undefined &&
    (!/^[1-9]\d*$/u.test(value(args, '--pr')) || !Number.isSafeInteger(pr))
  )
    throw new ReviewUsageError('--pr must be a positive safe integer');
  if (args.includes('--override')) {
    if (args.includes('--prior-record'))
      throw new ReviewUsageError(
        '--prior-record cannot be combined with --override',
      );
    if (args.includes('--budget-exception'))
      throw new ReviewUsageError('acceptance override cannot grant budget');
    const root = reviewRepository(repo);
    const head = reviewCommit(root, headInput, '--head');
    const identity =
      pr === undefined
        ? undefined
        : verifyPullRequest(
            await (options.readPull ?? readPullRequest)(root, pr),
            pr,
            reviewCommit(root, value(args, '--base'), '--base'),
            head,
          );
    const record = appendOverride(
      root,
      head,
      {
        reason: value(args, '--reason'),
        evidence: value(args, '--evidence'),
      },
      identity,
    );
    process.stdout.write(
      `${JSON.stringify({ headSha: record.headSha, override: record.override })}\n`,
    );
    return 'OVERRIDE';
  }
  const host = args.includes('--host') ? value(args, '--host') : 'codex';
  if (host !== 'codex')
    throw new ReviewUsageError('--host currently supports codex only');
  const baseInput = value(args, '--base');
  const lens = reviewLens(value(args, '--lens'));
  const checklist = reviewChecklist(args);
  const panel = args.includes('--panel') ? panelValue(args) : [...panelRoles];
  const root = reviewRepository(repo);
  const base = reviewCommit(root, baseInput, '--base');
  const head = reviewCommit(root, headInput, '--head');
  const parsed = reviewInputSchema.safeParse({
    repo: root,
    base,
    head,
    lens,
    panel,
    reasoningEffort,
    ...(args.includes('--prior-record')
      ? { priorRecord: value(args, '--prior-record') }
      : {}),
    ...(checklist === undefined ? {} : { prepassChecklist: checklist }),
    ...(pr === undefined ? {} : { pr }),
    ...(args.includes('--budget-exception')
      ? { budgetException: value(args, '--budget-exception') }
      : {}),
  });
  if (!parsed.success) throw new ReviewUsageError(parsed.error.message);
  const record = await runReview({
    ...parsed.data,
    signal: controller.signal,
    ...(options.readPull ? { readPull: options.readPull } : {}),
    ...(options.codexExecutable
      ? { codexExecutable: options.codexExecutable }
      : {}),
  });
  const path = record.attempt
    ? attemptRecordPath(root, record.attempt)
    : resolve(root, '.krn', 'runs', 'review', record.headSha, 'record.json');
  if (record.panelVerdict === undefined) {
    process.stdout.write(
      `${JSON.stringify({ headSha: record.headSha, prepass: record.prepass, record: path })}\n`,
    );
    return 'PREPASS_BLOCKING';
  }
  process.stdout.write(
    `${JSON.stringify({ headSha: record.headSha, panelVerdict: record.panelVerdict, record: path, judges: record.judges })}\n`,
  );
  return record.panelVerdict;
}
