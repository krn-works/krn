import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { briefClauses } from '../../brain/proof-line.ts';
import { run } from '../../ci/command.ts';
import { conflictedPaths } from '../../ci/conflict-check.ts';
import { CliUsageError } from '../../cli-kit/usage-error.ts';
import { laneAdvisor } from '../../outcome/lane-advisor.ts';
import { effortHistory, laneEffort } from '../../outcome/lane-effort.ts';
import { contractBase } from '../../repo/contract.ts';
import {
  claimTask,
  inspectClaim,
  mainCheckoutRoot,
  releaseClaim,
} from '../../task/claims.ts';
import { taskFile } from '../../task/paths.ts';
import { mergeTaskRecords } from '../../task/record-merge.ts';
import { getTask } from '../../task/store.ts';
import { git } from '../git-with.ts';
import { originRepository } from '../outside-git.ts';
import type { LaneRequest } from './args.ts';

import { baseSuiteFailure } from './base-run.ts';
import { isBootstrapTask, isGreenBaseTask } from './bootstrap.ts';
import { goalLaneBrief, taskLaneBrief } from './brief.ts';
import { parkedAt, parkedFile } from './delivery.ts';
import { laneDependencies, sessionEnvironment } from './environment.ts';
import {
  type RedCheck,
  redCheckBrief,
  redCheckFile,
  redCheckSchema,
} from './red-check.ts';
import {
  exitCredentialUnavailable,
  exitInstallFailed,
  exitReceiverNotReady,
} from './result.ts';
import { defaultSteps, type LaneRunSteps, type LaneVerdict } from './steps.ts';

/** Everything the session and verdict stages need: the request plus the prepared lane. */
export interface PreparedLane extends LaneRequest {
  main: string;
  base: string;
  brief: string;
  packet: string | null;
  /** Tokens of the packet the session served. */
  servedTokens: number;
  /** Ids of the records the packet served and of those it could have served but did not. */
  servedIds: string[];
  withheldIds: string[];
  /** The verdict suffix naming the packet the session served. */
  served: string;
  environment: NodeJS.ProcessEnv;
  red: RedCheck | undefined;
  /** The effort this turn runs at: low, or high after a red Check. */
  effort: string;
  redFile: string;
  worktree: string;
  /** An earlier run already delivered the commit: it ships without a session. */
  delivered: boolean;
}

/** Where a lane run records the effort of every turn so the rerun after a red Check appends to it. */
export function effortFile(main: string, lane: string): string {
  return join(main, '.krn', 'tmp', `lane-run-${lane}-effort.json`);
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
      red = redCheckSchema.parse(JSON.parse(readFileSync(redFile, 'utf8')));
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

  const effortPath = effortFile(main, lane);
  const previous = existsSync(effortPath)
    ? (JSON.parse(readFileSync(effortPath, 'utf8')) as string[])
    : [];
  const efforts = effortHistory(previous, red !== undefined);
  mkdirSync(dirname(effortPath), { recursive: true });
  writeFileSync(effortPath, JSON.stringify(efforts));
  const effort = laneEffort(red !== undefined);
  const clauses = briefClauses(brief);
  const repository = originRepository(origin);
  const environment = sessionEnvironment(
    process.env,
    join(main, '.krn', 'tmp', 'app-cache'),
    {
      lane,
      receiver: origin,
      advisor: laneAdvisor(prompt.text) !== undefined,
      effort: efforts.join(','),
      // Stop reads the clauses the brief states, the same list the proof line counts.
      ...(clauses.length === 0
        ? {}
        : { body: clauses.map((text, i) => `${i + 1}. ${text}`).join('\n') }),
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
  // A GitHub receiver that cannot merge a delivery fails every session: probe it before one starts.
  // The bootstrap task installs the gate and the green-base task fixes a red base, so they skip the probe.
  const exempt =
    task !== undefined &&
    (isBootstrapTask(main, task) || isGreenBaseTask(main, task));
  if (repository !== undefined && !exempt) {
    const gaps = await (steps.receiver ?? defaultSteps.receiver)(origin, base, {
      env: environment,
      editsWorkflows:
        task !== undefined &&
        getTask(main, task).body.join('\n').includes('.github/workflows'),
    });
    if (gaps.length > 0)
      return {
        line: `lane ${label}: receiver not ready, no session started: ${gaps.join('; ')}`,
        exitCode: exitReceiverNotReady,
      };
  }

  const existing = join(main, '.krn', 'worktrees', lane);
  const reused = existsSync(existing);
  const holder = actor ?? `lane-${lane}`;
  // Only a commit the runner itself handed to ship (after a session passed its gates) resumes without a session:
  // a task closed by a killed or BLOCKER-ended session is unchecked work (t-zbbqmhr).
  const parked =
    reused &&
    red === undefined &&
    parkedAt(parkedFile(main, lane), git(existing, ['rev-parse', 'HEAD']));
  // A resumed delivery that no longer merges onto the moved base needs a session to rebase it; shipping it again only repeats the conflict.
  const conflicts = reused ? baseConflicts(existing, base) : [];
  const resumed = parked && conflicts.length === 0;
  // A rerun after a failed run reuses its worktree and branch; the failed run released the claim.
  const started = reused
    ? task === undefined
      ? reusableLane(existing, lane)
      : await reclaimLane(
          main,
          existing,
          lane,
          task,
          holder,
          origin,
          base,
          resumed,
        )
    : await steps.start([
        lane,
        ...(task === undefined ? [] : ['--task', task]),
        '--actor',
        holder,
        '--root',
        origin,
      ]);
  // The session and the final check need the contract dependencies in the worktree, a resumed delivery too;
  // a failed install starts no session and frees the task.
  const missing = laneDependencies(main, started.path, environment);
  if (missing !== undefined) {
    if (task !== undefined)
      await releaseClaim(main, task).catch(() => undefined);
    return {
      line: `lane ${label}: preflight install failed, no session started: ${missing.replace(/\s+/gu, ' ')} (worktree ${started.path}, rerun reuses it${task === undefined ? '' : ', claim released'})`,
      exitCode: exitInstallFailed,
    };
  }
  // The untouched base runs its suite once before a paid session: a red or unrunnable base fails the lane here.
  if (!resumed && red === undefined && !exempt) {
    const failed = baseSuiteFailure(main, started.path, base);
    if (failed !== undefined) {
      if (task !== undefined)
        await releaseClaim(main, task).catch(() => undefined);
      return {
        line: `lane ${label}: ${failed.detail.replace(/\s+/gu, ' ')}, no session started (worktree ${started.path}, rerun reuses it${task === undefined ? '' : ', claim released'})`,
        exitCode: failed.exitCode,
      };
    }
  }
  return {
    ...request,
    main,
    base,
    brief:
      conflicts.length > 0
        ? `${conflictNote(base, conflicts)}${brief}`
        : reused && red === undefined && !resumed
          ? `${reusedLaneNote(started.path, base)}${brief}`
          : brief,
    packet: prompt.packet,
    servedTokens: prompt.tokens,
    servedIds: prompt.served,
    withheldIds: prompt.withheld,
    served,
    environment,
    red,
    effort,
    redFile,
    worktree: started.path,
    delivered: resumed,
  };
}

/**
 * The prompt note for a rerun that reuses a worktree from a failed attempt: it names the commits already on the lane
 * branch, so a Stop refusal that concerns them is read as such and not as the new session's own work. Empty when the branch holds none.
 */
export function reusedLaneNote(path: string, base: string): string {
  const commits = (range: string) => {
    try {
      return git(path, ['log', '--format=%h %s', range])
        .split('\n')
        .filter((line) => line !== '');
    } catch {
      return undefined;
    }
  };
  const ahead =
    commits(`origin/${base}..HEAD`) ?? commits(`${base}..HEAD`) ?? [];
  if (ahead.length === 0) return '';
  return `Reused worktree: this lane branch already holds ${ahead.length} commit(s) from a failed attempt (${ahead.slice(0, 5).join('; ')}). A Stop refusal about a test or file in them concerns that earlier work: read .krn/runs/stop-check/last-refusal.txt, then fix or replace those commits, or end with a line \`BLOCKER: <what stops you>\`.\n\n`;
}

/**
 * The paths where the lane branch conflicts with the freshly fetched `origin/<base>`; empty when it merges cleanly
 * or when the trial cannot run (an unreachable remote is not a conflict, ship's own check still guards the push).
 */
export function baseConflicts(path: string, base: string): string[] {
  try {
    git(path, ['fetch', '-q', 'origin', base]);
    return conflictedPaths(path, base, run);
  } catch {
    return [];
  }
}

/** The prompt note for a rerun whose lane branch conflicts with the moved base: rebase, resolve, rerun everything. */
export function conflictNote(base: string, paths: readonly string[]): string {
  return `Base moved: this lane branch conflicts with origin/${base} in ${paths.join(', ')}. First run \`git fetch origin ${base} && git rebase origin/${base}\`, resolve each conflict keeping the intent of both sides, then rerun the full test suite (a test that lists or counts files can fail after a clean merge) and fix what fails before you finish.\n\n`;
}

/** The worktree a failed run left behind, when it is the lane's own; anything else is a usage error. */
export function reusableLane(
  path: string,
  slug: string,
): { path: string; slug: string } {
  let branch: string | undefined;
  try {
    branch = git(path, ['rev-parse', '--abbrev-ref', 'HEAD']);
  } catch {
    branch = undefined;
  }
  if (branch !== slug)
    throw new CliUsageError(
      `${path} exists but is not lane ${slug}'s worktree`,
    );
  return { path, slug };
}

/** A record the lead edited in the invoking checkout after the first run moves into the reused worktree; a worktree record the worker changed too is a divergence and refuses. */
export function carryEditedRecord(
  origin: string,
  path: string,
  task: string,
  base: string,
): void {
  const rel = taskFile(task);
  const source = join(origin, rel);
  const target = join(path, rel);
  if (!existsSync(source) || !existsSync(target)) return;
  const edited = readFileSync(source, 'utf8');
  const current = readFileSync(target, 'utf8');
  if (edited === current) return;
  const shown = (ref: string) => {
    // git trims stdout; a task record ends in one newline.
    try {
      return `${git(path, ['show', `${ref}:${rel}`])}\n`;
    } catch {
      return undefined;
    }
  };
  const original = shown(`origin/${base}`) ?? shown('HEAD');
  // The invoking checkout never moved from the base record: the worktree's own changes stand.
  if (edited === original) return;
  if (original === undefined || current === original) {
    writeFileSync(target, edited);
    return;
  }
  // Both changed (the lane closed the task, the lead appended a rework note): merge disjoint edits.
  const merge = mergeTaskRecords({
    base: original,
    lane: current,
    main: edited,
  });
  if (!('merged' in merge))
    throw new CliUsageError(
      'conflict' in merge
        ? `${rel} differs between ${origin} and the lane worktree ${path}: both changed ${merge.conflict}; reconcile them before rerunning`
        : `${rel} cannot be merged between ${origin} and the lane worktree ${path}: ${merge.invalid}`,
    );
  writeFileSync(source, merge.merged);
  if (merge.merged === current) return;
  writeFileSync(target, merge.merged);
  // Committed, so the lane's clean-tree check passes and the shipped commit carries the note.
  git(path, ['add', '--', rel]);
  git(path, ['commit', '-q', '-m', carrySubject(task), '-m', `Refs: ${task}`]);
}

/** The subject of the commit a rerun makes to carry the invoking checkout's record edits into the lane. */
export function carrySubject(task: string): string {
  return `chore(tasks): carry the lead's record edits into the lane (${task})`;
}

/** Commits after the red Check's head other than a record carry; a rewritten history counts as new work. */
export function commitsSinceRed(
  path: string,
  red: RedCheck,
  task: string,
): string[] {
  let log: string;
  try {
    log = git(path, ['log', '--format=%s', `${red.sha}..HEAD`]);
  } catch {
    return ['history rewritten since the red Check'];
  }
  return log
    .split('\n')
    .filter((line) => line !== '' && line !== carrySubject(task));
}

/** Reuse the worktree a failed run left and take its claim again. */
export async function reclaimLane(
  main: string,
  path: string,
  slug: string,
  task: string,
  actor: string,
  origin: string,
  base: string,
  resumed = false,
): Promise<{ path: string; slug: string }> {
  const lane = reusableLane(path, slug);
  carryEditedRecord(origin, path, task, base);
  // A resumed delivery ships the runner's own checked commit without a session; a task closed in the worktree
  // cannot be claimed again, and its rerun session works under the lane identity alone (as after a red Check).
  if (resumed || getTask(path, task).status === 'closed') return lane;
  // A run that died before it released its own claim leaves it live: the same actor and worktree resume it.
  const held = inspectClaim(main, task);
  if (
    held.state === 'live' &&
    held.claim?.actor === actor &&
    held.claim.worktree === realpathSync(path)
  )
    return lane;
  await claimTask(main, task, {
    actor,
    worktree: path,
    reason: `lane ${slug}`,
  });
  return lane;
}
