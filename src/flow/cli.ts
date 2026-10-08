// Parse the explicit local review command and print its exact SHA-bound result.
import { resolve } from 'node:path';
import { runReview } from './index.ts';
import { appendOverride } from './record.ts';
import { panelRoles } from './types.ts';

function value(args: readonly string[], flag: string): string {
  const index = args.indexOf(flag);
  const result = index < 0 ? undefined : args[index + 1];
  if (!result || result.startsWith('--')) throw new Error(`missing ${flag}`);
  return result;
}

export async function reviewCommand(
  args: readonly string[],
  options: { readonly codexExecutable?: string } = {},
): Promise<void> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  process.on('SIGINT', abort);
  process.on('SIGTERM', abort);
  process.on('SIGHUP', abort);
  try {
    await runReviewCommand(args, controller, options);
  } catch (error) {
    if (!controller.signal.aborted) throw error;
    process.exitCode = 130;
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
): Promise<void> {
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
    return;
  }
  const host = args.includes('--host') ? value(args, '--host') : 'codex';
  if (host !== 'codex') throw new Error('--host currently supports codex only');
  const panel = args.includes('--panel')
    ? value(args, '--panel')
        .split(',')
        .map((role) => role.trim())
    : [...panelRoles];
  const record = await runReview({
    repo,
    base: value(args, '--base'),
    head,
    lens: value(args, '--lens'),
    panel: panel as (typeof panelRoles)[number][],
    signal: controller.signal,
    ...(options.codexExecutable
      ? { codexExecutable: options.codexExecutable }
      : {}),
  });
  process.stdout.write(
    `${JSON.stringify({ headSha: record.headSha, record: resolve(repo, '.krn', 'runs', 'review', record.headSha, 'record.json'), judges: record.judges.map(({ role, verdict }) => ({ role, verdict })) })}\n`,
  );
}
