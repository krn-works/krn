// `krn review`: opt-in parallel judge panel over base..head, no records or budgets.
import { readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { git } from './git.ts';
import { judgeRole } from './panel.ts';
import {
  type JudgeResult,
  type ReviewReasoningEffort,
  type ReviewRole,
  reasoningEffortSchema,
  roleSchema,
} from './types.ts';

export type ReviewCommandOutcome = 'PASS' | 'FAIL' | 'INCOMPLETE';

export class ReviewUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReviewUsageError';
  }
}

const usage = [
  'Usage: krn review --repo <path> --base <ref> --head <ref> --lens <path>',
  '  [--panel standards,spec,adversarial] [--reasoning-effort low|medium|high|xhigh|max]',
  'Runs read-only judges in parallel and prints one JSON result.',
  'Exit: 0 PASS, 1 FAIL, 2 INCOMPLETE, 64 usage, 70 error.',
  '',
].join('\n');

function value(args: readonly string[], flag: string): string {
  const index = args.indexOf(flag);
  const result = index < 0 ? undefined : args[index + 1];
  if (!result || result.startsWith('--'))
    throw new ReviewUsageError(`missing ${flag}`);
  return result;
}

function roles(args: readonly string[]): ReviewRole[] {
  if (!args.includes('--panel')) return roleSchema.options.slice();
  const names = value(args, '--panel')
    .split(',')
    .map((role) => role.trim());
  const parsed = roleSchema.array().min(1).safeParse(names);
  if (!parsed.success || new Set(names).size !== names.length)
    throw new ReviewUsageError('--panel must contain unique judge roles');
  return parsed.data;
}

function effort(args: readonly string[]): ReviewReasoningEffort {
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

function lens(input: string): string {
  const path = resolve(input);
  let contents: string;
  try {
    if (!statSync(path).isFile())
      throw new ReviewUsageError('--lens must name a regular file');
    contents = readFileSync(path, 'utf8');
  } catch (error) {
    if (error instanceof ReviewUsageError) throw error;
    throw new ReviewUsageError(
      `--lens cannot be read: ${error instanceof Error ? error.message : error}`,
    );
  }
  if (!contents.trim()) throw new ReviewUsageError('--lens file is empty');
  return contents;
}

function commit(root: string, ref: string, flag: string): string {
  try {
    return git(root, ['rev-parse', '--verify', `${ref}^{commit}`]);
  } catch (error) {
    throw new ReviewUsageError(
      `${flag} is not a commit: ${error instanceof Error ? error.message : error}`,
    );
  }
}

export async function reviewCommand(
  args: readonly string[],
  options: { readonly codexExecutable?: string } = {},
): Promise<ReviewCommandOutcome | undefined> {
  if (args.includes('--help')) {
    process.stdout.write(usage);
    return undefined;
  }
  const root = (() => {
    try {
      return git(resolve(value(args, '--repo')), [
        'rev-parse',
        '--show-toplevel',
      ]);
    } catch (error) {
      if (error instanceof ReviewUsageError) throw error;
      throw new ReviewUsageError('--repo must be a git repository');
    }
  })();
  const base = commit(root, value(args, '--base'), '--base');
  const head = commit(root, value(args, '--head'), '--head');
  const text = lens(value(args, '--lens'));
  const panel = roles(args);
  const reasoningEffort = effort(args);
  const results: JudgeResult[] = await Promise.all(
    panel.map((role) =>
      judgeRole({
        root,
        base,
        head,
        role,
        lens: text,
        timeoutMs: 15 * 60 * 1000,
        reasoningEffort,
        ...(options.codexExecutable
          ? { executable: options.codexExecutable }
          : {}),
      }).catch(
        (error: unknown): JudgeResult => ({
          state: 'incomplete',
          role,
          reason: error instanceof Error ? error.message : String(error),
        }),
      ),
    ),
  );
  const outcome: ReviewCommandOutcome = results.some(
    (r) => r.state === 'complete' && r.verdict === 'FAIL',
  )
    ? 'FAIL'
    : results.some((r) => r.state === 'incomplete')
      ? 'INCOMPLETE'
      : 'PASS';
  process.stdout.write(
    `${JSON.stringify({ outcome, base, head, judges: results }, null, 2)}\n`,
  );
  return outcome;
}
