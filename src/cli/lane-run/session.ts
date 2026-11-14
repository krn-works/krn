import { spawnSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { contractLaneBudget } from '../../repo/contract.ts';
import { mainCheckoutPlaceholders } from '../../state/sandbox-placeholders.ts';
import {
  fallbackModel,
  laneSandboxSettings,
  sessionTimeoutMs,
} from './environment.ts';
import { prepareWorktree, settingsFailure } from './preflight.ts';
import type { PreparedLane } from './prepare.ts';
import {
  exitCredentialUnavailable,
  parseSessionResult,
  type SessionResult,
} from './result.ts';

/** Kill every process the session left in its own process group (a Bash child can outlive claude). */
export function killGroup(pid: number | undefined): void {
  if (pid === undefined || pid <= 0) return;
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    /* The group is already gone. */
  }
}

/** What the session stage produced: the result, and why it did not start when the worktree or settings refused it. */
export interface SessionOutcome {
  result: SessionResult;
  refusal: { detail: string; exitCode: number } | undefined;
  notStarted: boolean;
  /** Baseline test files that failed, then passed on a rerun. */
  flaky: string[];
}

/** Stage three: spawn the headless session in the lane worktree and read its result. */
export function runSession(lane: PreparedLane): SessionOutcome {
  const { worktree, model, environment, main, brief, origin } = lane;
  const claude = process.env.KRN_LANE_CLAUDE ?? 'claude';
  // Node's spawnSync honours `detached` (a new session and process group) though its types omit it.
  const sessionOptions = {
    cwd: worktree,
    encoding: 'utf8' as const,
    maxBuffer: 64 * 1024 * 1024,
    env: environment,
    timeout: sessionTimeoutMs(process.env),
    killSignal: 'SIGKILL' as const,
    // Its own process group, so the timeout kills the session's children with it.
    detached: true,
  };
  const session = spawnSync(
    claude,
    [
      '-p',
      brief,
      '--output-format',
      'json',
      '--settings',
      laneSandboxSettings(worktree),
      '--permission-mode',
      'acceptEdits',
      '--model',
      model,
      '--fallback-model',
      fallbackModel(model),
      '--max-budget-usd',
      String(contractLaneBudget(origin)),
      '--setting-sources',
      'project',
    ],
    sessionOptions,
  );
  killGroup(session.pid);
  const timedOut =
    (session.error as NodeJS.ErrnoException | undefined)?.code === 'ETIMEDOUT';
  const result = timedOut
    ? {
        ok: false,
        detail: `session timeout after ${Math.round(sessionTimeoutMs(process.env) / 1000)}s (capped below the App token lifetime)`,
        cost: undefined,
      }
    : session.error !== undefined
      ? {
          ok: false,
          detail:
            (session.error as NodeJS.ErrnoException).code === 'ENOENT'
              ? `session did not run: ${claude} not found (put claude on PATH or set KRN_LANE_CLAUDE)`
              : `session did not run: ${session.error.message}`,
          cost: undefined,
        }
      : parseSessionResult(session.stdout ?? '', session.stderr ?? '');
  // The session's sandbox can leave empty placeholders in the main checkout and its git dir.
  for (const path of mainCheckoutPlaceholders(main)) rmSync(path);
  return {
    result,
    refusal: undefined,
    notStarted: session.error !== undefined && !timedOut,
    flaky: [],
  };
}

/** Stage three as the caller sees it: a delivered commit or a refused worktree skips the spawn. */
export function sessionStage(lane: PreparedLane): SessionOutcome {
  const { worktree, base, main, delivered } = lane;
  if (delivered)
    return {
      result: {
        ok: true,
        detail: 'resumed: an earlier run delivered the commit',
        cost: undefined,
      },
      refusal: undefined,
      notStarted: false,
      flaky: [],
    };
  const flaky: string[] = [];
  const unusable = settingsFailure(laneSandboxSettings(worktree));
  const refusal =
    unusable !== undefined
      ? {
          detail: `preflight: ${unusable}; no session started`,
          exitCode: exitCredentialUnavailable,
        }
      : prepareWorktree(worktree, base, main, flaky);
  if (refusal !== undefined)
    return {
      result: { ok: false, detail: refusal.detail, cost: undefined },
      refusal,
      notStarted: false,
      flaky,
    };
  return { ...runSession(lane), flaky };
}
