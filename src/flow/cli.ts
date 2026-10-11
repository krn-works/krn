// Parse the explicit local review command and print its exact SHA-bound result.
import { resolve } from 'node:path';
import { runReview } from './index.ts';
import { appendOverride } from './record.ts';
import { panelRoles, roleSchema } from './types.ts';

export type ReviewCommandOutcome = 'PASS' | 'FAIL' | 'INCOMPLETE' | 'OVERRIDE';

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
  const repo = value(args, '--repo');
  const head = value(args, '--head');
  if (args.includes('--override')) {
    const record = appendOverride(repo, head, {
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
  const base = value(args, '--base');
  const lens = value(args, '--lens');
  if (!/^[a-f0-9]{40,64}$/iu.test(head))
    throw new ReviewUsageError('--head must be a full commit SHA');
  const panel = args.includes('--panel') ? panelValue(args) : [...panelRoles];
  const record = await runReview({
    repo,
    base,
    head,
    lens,
    panel,
    signal: controller.signal,
    ...(options.codexExecutable
      ? { codexExecutable: options.codexExecutable }
      : {}),
  });
  process.stdout.write(
    `${JSON.stringify({ headSha: record.headSha, panelVerdict: record.panelVerdict, record: resolve(repo, '.krn', 'runs', 'review', record.headSha, 'record.json'), judges: record.judges })}\n`,
  );
  return record.panelVerdict;
}
