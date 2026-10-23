// Parse the explicit local review command and print its exact SHA-bound result.
import { readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { validateHostLockPath } from './host-lock.ts';
import { runReview } from './index.ts';
import { appendOverride } from './record.ts';
import { repoRoot, resolveCommit, validateSha } from './repository.ts';
import {
  panelRoles,
  type ReviewReasoningEffort,
  reasoningEffortSchema,
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
    if (!statSync(path).isFile())
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

function reviewHostLock(args: readonly string[]): string | undefined {
  if (!args.includes('--host-lock')) return undefined;
  const path = value(args, '--host-lock');
  try {
    validateHostLockPath(path);
  } catch (error) {
    throw new ReviewUsageError(errorMessage(error));
  }
  return path;
}

export async function reviewCommand(
  args: readonly string[],
  options: { readonly codexExecutable?: string } = {},
): Promise<ReviewCommandOutcome | undefined> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  process.on('SIGINT', abort);
  process.on('SIGTERM', abort);
  process.on('SIGHUP', abort);
  try {
    return await runReviewCommand(args, controller, options);
  } catch (error) {
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
  options: { readonly codexExecutable?: string },
): Promise<ReviewCommandOutcome> {
  // Keep the lock path explicit on the CLI instead of accepting an env alias.
  if (process.env.KRN_REVIEW_HOST_LOCK !== undefined)
    throw new ReviewUsageError(
      'KRN_REVIEW_HOST_LOCK is unsupported; pass the path with --host-lock',
    );
  // An override skips red-first, so a host lock would have no work to guard.
  if (args.includes('--override') && args.includes('--host-lock'))
    throw new ReviewUsageError('--host-lock cannot be used with --override');
  const reasoningEffort = reasoningEffortValue(args);
  const repo = value(args, '--repo');
  const headInput = value(args, '--head');
  if (args.includes('--override')) {
    const root = reviewRepository(repo);
    const head = reviewCommit(root, headInput, '--head');
    const record = appendOverride(root, head, {
      reason: value(args, '--reason'),
      evidence: value(args, '--evidence'),
    });
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
  const hostLock = reviewHostLock(args);
  const panel = args.includes('--panel') ? panelValue(args) : [...panelRoles];
  const root = reviewRepository(repo);
  const base = reviewCommit(root, baseInput, '--base');
  const head = reviewCommit(root, headInput, '--head');
  const record = await runReview({
    repo: root,
    base,
    head,
    lens,
    panel,
    reasoningEffort,
    ...(checklist === undefined ? {} : { prepassChecklist: checklist }),
    ...(hostLock === undefined ? {} : { hostLock }),
    signal: controller.signal,
    ...(options.codexExecutable
      ? { codexExecutable: options.codexExecutable }
      : {}),
  });
  if (record.panelVerdict === undefined) {
    process.stdout.write(
      `${JSON.stringify({ headSha: record.headSha, prepass: record.prepass, record: resolve(repo, '.krn', 'runs', 'review', record.headSha, 'record.json') })}\n`,
    );
    return 'PREPASS_BLOCKING';
  }
  process.stdout.write(
    `${JSON.stringify({ headSha: record.headSha, panelVerdict: record.panelVerdict, record: resolve(repo, '.krn', 'runs', 'review', record.headSha, 'record.json'), judges: record.judges })}\n`,
  );
  return record.panelVerdict;
}
