import { rmSync } from 'node:fs';
import { driveSession } from '../../../evals/replay/session.ts';
import type { SessionResult } from '../../../evals/replay/session-result.ts';
import { headlessArgs, laneBinary } from '../../harness/claude.ts';
import { contractLaneBudget } from '../../repo/contract.ts';
import { mainCheckoutPlaceholders } from '../../state/sandbox-placeholders.ts';
import {
  fallbackModel,
  laneAdvisorModel,
  laneSandboxSettings,
  sessionTimeoutMs,
} from './environment.ts';
import type { PreparedLane } from './prepare.ts';

/** What the session stage produced: the result, and why it did not start when the worktree or settings refused it. */
export interface SessionOutcome {
  result: SessionResult;
  refusal: { detail: string; exitCode: number } | undefined;
  notStarted: boolean;
  /** Baseline test files that failed, then passed on a rerun. */
  flaky: string[];
}

/** Stage three: run the headless session in the lane worktree through the replay session driver. */
export async function runSession(lane: PreparedLane): Promise<SessionOutcome> {
  const { worktree, model, environment, main, brief, origin, effort } = lane;
  const claude = laneBinary();
  const timeoutMs = sessionTimeoutMs(process.env);
  const session = await driveSession({
    command: claude,
    argv: headlessArgs({
      brief,
      settings: laneSandboxSettings(worktree),
      model,
      effort,
      fallbackModel: fallbackModel(model),
      budgetUsd: contractLaneBudget(origin),
      ...(environment.KRN_LANE_ADVISOR === laneAdvisorModel
        ? { advisor: laneAdvisorModel }
        : {}),
    }),
    cwd: worktree,
    env: environment,
    timeoutMs,
    claude,
  });
  // The session's sandbox can leave empty placeholders in the main checkout and its git dir.
  for (const path of mainCheckoutPlaceholders(main)) rmSync(path);
  return {
    result: session.result,
    refusal: undefined,
    notStarted: session.notStarted,
    flaky: [],
  };
}

/** Stage three as the caller sees it: a delivered commit or a refused worktree skips the spawn. */
export async function sessionStage(
  lane: PreparedLane,
): Promise<SessionOutcome> {
  const { delivered } = lane;
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
  return { ...(await runSession(lane)), flaky: [] };
}
