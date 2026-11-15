// Watchdog for an unattended lead that stopped on an API error or exhausted quota.
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
} from 'node:fs';
import { join } from 'node:path';

// StopFailure payload (Claude Code hooks reference): hook_event_name, session_id, cwd, `error` naming the
// failure class (rate_limit, server_error, billing_error, authentication_failed, invalid_request,
// max_output_tokens, unknown). Only transient classes relaunch: a rejected request or credential repeats.
const relaunchOn = new Set([
  'rate_limit',
  'server_error',
  'billing_error',
  'unknown',
]);
/** The plan window above which the successor starts on the next account. */
export const SWITCH_ABOVE_PERCENT = 85;
/** Relaunches allowed per hour: a successor that dies at once must not loop. */
export const RELAUNCH_LIMIT = 3;

export interface WatchdogDeps {
  /** Runs a command; returns its exit status. */
  run: (command: string, args: string[]) => number | null;
  now: () => number;
}

export type WatchdogOutcome =
  | { action: 'ignored'; reason: string }
  | { action: 'refused'; reason: string }
  | { action: 'relaunched'; handoff: string; switched: boolean };

function newestHandoff(root: string): string | undefined {
  let newest: { path: string; mtime: number } | undefined;
  const visit = (directory: string) => {
    if (!existsSync(directory)) return;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile() && entry.name === 'handoff.md') {
        const mtime = statSync(path).mtimeMs;
        if (!newest || mtime > newest.mtime) newest = { path, mtime };
      }
    }
  };
  visit(join(root, '.krn/runs'));
  return newest?.path;
}

function fiveHour(root: string): number | undefined {
  try {
    const last = readFileSync(join(root, '.krn/plan/samples.jsonl'), 'utf8')
      .trimEnd()
      .split('\n')
      .pop();
    const value = (JSON.parse(last ?? '') as { five_hour?: unknown }).five_hour;
    return typeof value === 'number' ? value : undefined;
  } catch {
    return undefined;
  }
}

function recentRelaunches(file: string, now: number): number[] {
  try {
    return readFileSync(file, 'utf8')
      .split('\n')
      .filter((line) => line !== '')
      .map(Number)
      .filter((time) => Number.isFinite(time) && time > now - 3600_000);
  } catch {
    return [];
  }
}

/**
 * Relaunches a successor from the newest handoff when an unattended lead (KRN_UNATTENDED=1) stops on a
 * transient API or quota error; switches the Claude account first when the 5h window is above the limit.
 * The launch itself refuses when `krn doctor --unattended` fails.
 */
export function handleStopFailure(
  payload: unknown,
  root: string,
  env: NodeJS.ProcessEnv,
  deps: WatchdogDeps,
): WatchdogOutcome {
  const input = (payload ?? {}) as {
    hook_event_name?: unknown;
    error?: unknown;
  };
  if (input.hook_event_name !== 'StopFailure')
    return { action: 'ignored', reason: 'not a StopFailure payload' };
  if (env.KRN_UNATTENDED !== '1')
    return { action: 'ignored', reason: 'session is attended' };
  const error = typeof input.error === 'string' ? input.error : 'unknown';
  if (!relaunchOn.has(error))
    return { action: 'ignored', reason: `${error} does not relaunch` };
  const handoff = newestHandoff(root);
  if (!handoff)
    return { action: 'refused', reason: 'no handoff.md under .krn/runs' };
  const ledger = join(root, '.krn/runs/watchdog/relaunches.log');
  const now = deps.now();
  if (recentRelaunches(ledger, now).length >= RELAUNCH_LIMIT)
    return {
      action: 'refused',
      reason: `${RELAUNCH_LIMIT} relaunches within an hour`,
    };
  const used = fiveHour(root);
  const switched = used !== undefined && used > SWITCH_ABOVE_PERCENT;
  if (switched && deps.run('cswap', ['switch']) !== 0)
    return { action: 'refused', reason: 'cswap switch failed' };
  const status = deps.run('node', [
    join(root, 'scripts/claude/successor-launch.ts'),
    '--unattended',
    '--name',
    'watchdog successor',
    '--prompt',
    `Use the delivery-lead skill. The previous lead stopped on ${error}; run the handoff Verify and continue.`,
    '--cwd',
    root,
  ]);
  if (status !== 0)
    return { action: 'refused', reason: `successor launch exited ${status}` };
  mkdirSync(join(root, '.krn/runs/watchdog'), { recursive: true });
  appendFileSync(ledger, `${now}\n`);
  return { action: 'relaunched', handoff, switched };
}
