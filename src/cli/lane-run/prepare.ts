import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { contractBase } from '../../repo/contract.ts';
import { mainCheckoutRoot } from '../../task/claims.ts';
import { getTask } from '../../task/store.ts';
import { originRepository } from '../outside-git.ts';
import type { LaneRequest } from './args.ts';
import { goalLaneBrief, taskLaneBrief } from './brief.ts';
import { sessionEnvironment } from './environment.ts';
import { remoteFailure } from './preflight.ts';
import { type RedCheck, redCheckBrief, redCheckFile } from './red-check.ts';
import { exitCredentialUnavailable } from './result.ts';
import { defaultSteps, type LaneRunSteps, type LaneVerdict } from './steps.ts';
import { reclaimLane, reusableLane } from './worktree.ts';

/** Everything the session and verdict stages need: the request plus the prepared lane. */
export interface PreparedLane extends LaneRequest {
  main: string;
  base: string;
  brief: string;
  packet: string | null;
  /** The verdict suffix naming the packet the session served. */
  served: string;
  environment: NodeJS.ProcessEnv;
  red: RedCheck | undefined;
  redFile: string;
  worktree: string;
  /** An earlier run already delivered the commit: it ships without a session. */
  delivered: boolean;
}

/** Stage two: brief the session, check the credential and remote, and reuse or start the worktree. A verdict means no session starts. */
export async function prepareLane(
  request: LaneRequest,
  steps: LaneRunSteps,
): Promise<PreparedLane | LaneVerdict> {
  const { task, goal, actor, origin, lane, label } = request;
  const main = mainCheckoutRoot(origin);
  const base = contractBase(origin);
  const prompt =
    task === undefined
      ? goalLaneBrief(origin, goal ?? '')
      : taskLaneBrief(origin, task, undefined, [
          join(main, '.krn', 'worktrees', lane),
        ]);
  // A rerun after a red Check reuses the worktree that holds the failed commit: brief the failure first.
  const redFile = redCheckFile(main, lane);
  let red: RedCheck | undefined;
  if (existsSync(redFile)) {
    if (existsSync(join(main, '.krn', 'worktrees', lane)))
      red = JSON.parse(readFileSync(redFile, 'utf8')) as RedCheck;
    else rmSync(redFile);
  }
  const brief =
    red === undefined
      ? prompt.text
      : `${redCheckBrief(
          origin,
          red,
          await (steps.ciLogs ?? defaultSteps.ciLogs)(red.run, origin).catch(
            (error: unknown) =>
              error instanceof Error ? error : new Error(String(error)),
          ),
        )}${prompt.text}`;
  // The verdict records which packet the session served, so a run is traceable to its conventions.
  const served =
    prompt.packet === null ? '' : ` packet ${prompt.packet.slice(0, 12)}`;

  const repository = originRepository(origin);
  const environment = sessionEnvironment(
    process.env,
    join(main, '.krn', 'tmp', 'app-cache'),
    {
      lane,
      ...(task === undefined ? {} : { task }),
      ...(repository === undefined ? {} : { repository }),
    },
  );
  const unavailable = await steps.mint(environment);
  if (unavailable !== undefined)
    return {
      line: `lane ${label}: GitHub App credential unavailable (${unavailable})`,
      exitCode: exitCredentialUnavailable,
    };

  const unreachable = remoteFailure(origin, base, environment);
  if (unreachable !== undefined)
    return {
      line: `lane ${label}: preflight: ${unreachable}; no session started`,
      exitCode: exitCredentialUnavailable,
    };

  const existing = join(main, '.krn', 'worktrees', lane);
  const holder = actor ?? `lane-${lane}`;
  // A rerun after a failed run reuses its worktree and branch; the failed run released the claim.
  const started = existsSync(existing)
    ? task === undefined
      ? reusableLane(existing, lane)
      : await reclaimLane(main, existing, lane, task, holder, origin, base)
    : await steps.start([
        lane,
        ...(task === undefined ? [] : ['--task', task]),
        '--actor',
        holder,
        '--root',
        origin,
      ]);
  // A rerun after a failed ship finds the task closed in its worktree: the commit is delivered, so it ships without a session.
  // After a red Check the closed task is the failed delivery, so the rerun needs a session.
  const delivered =
    task !== undefined &&
    red === undefined &&
    getTask(started.path, task).status === 'closed';
  return {
    ...request,
    main,
    base,
    brief,
    packet: prompt.packet,
    served,
    environment,
    red,
    redFile,
    worktree: started.path,
    delivered,
  };
}
