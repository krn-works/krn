import { spawnSync } from 'node:child_process';
import {
  lstatSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isTestFile } from '../../brain/acceptance-clauses.ts';
import {
  appendExposure,
  exposureOf,
  readExposures,
} from '../../brain/exposures.ts';
import { proofLine, proofOf } from '../../brain/proof-line.ts';
import { releaseClaim } from '../../task/claims.ts';
import { getTask } from '../../task/store.ts';
import { renderPrBody } from '../pr-body.ts';
import {
  contractVerification,
  followLockfile,
  goalPrBody,
  parkCommit,
  parkedFile,
  sandboxPlaceholders,
  sessionVerification,
  ticketCommitTitle,
} from './delivery.ts';
import { git } from './git.ts';
import type { PreparedLane } from './prepare.ts';
import { redCheckOf } from './red-check.ts';
import {
  exitBudgetCapped,
  exitCredentialUnavailable,
  exitNoDelivery,
  exitNoProgress,
  exitSessionBlocked,
  noProgressAttempts,
} from './result.ts';
import type { SessionOutcome } from './session.ts';
import type { LaneRunSteps, LaneVerdict } from './steps.ts';
import { commitsSinceRed } from './worktree.ts';

const stopHook = fileURLToPath(new URL('../../hook/stop.ts', import.meta.url));

/** The lane's changed test files that fail against the base source, from the Stop hook's `--red` mode run in its worktree. */
function redTestsOf(worktree: string): string[] {
  const run = spawnSync(process.execPath, [stopHook, '--red'], {
    cwd: worktree,
    env: { ...process.env, CLAUDE_PROJECT_DIR: worktree },
    encoding: 'utf8',
  });
  return run.status === 0
    ? run.stdout.split('\n').filter((file) => file !== '')
    : [];
}

/** Stage four: judge the session's tree and ship it, or stop with the reason and free the claim. */
export async function laneVerdict(
  lane: PreparedLane,
  outcome: SessionOutcome,
  steps: LaneRunSteps,
): Promise<LaneVerdict> {
  const { task, goal, label, model, main, base, served, red, redFile } = lane;
  const { result, refusal, notStarted } = outcome;
  const path = lane.worktree;
  const slug = lane.lane;
  const spent =
    (result.cost === undefined ? '' : ` cost $${result.cost.toFixed(2)}`) +
    (result.turns === undefined ? '' : ` turns ${result.turns}`);
  // Every ending logs which standards the run was served and how it ended (the effect report reads it).
  // The proof line counts what the lane really holds: its brief, its commits and tests, its Stop refusals.
  const proofOfLane = (): string => {
    try {
      const range = `origin/${lane.base}..HEAD`;
      const changed = git(path, ['diff', '--name-only', range])
        .split('\n')
        .filter((file) => file !== '');
      const tests = new Map<string, string>();
      for (const file of changed.filter(isTestFile))
        try {
          tests.set(file, readFileSync(join(path, file), 'utf8'));
        } catch {
          /* A deleted file holds no test. */
        }
      const first = git(path, ['rev-list', '--reverse', range]).split('\n')[0];
      return proofLine(
        proofOf({
          brief: lane.brief,
          tests,
          messages: git(path, ['log', '--format=%B', range]),
          firstCommitFiles:
            first === undefined || first === ''
              ? []
              : git(path, ['show', '--name-only', '--format=', first])
                  .split('\n')
                  .filter((file) => file !== ''),
          redAtBase: redTestsOf(path),
          stopRefusals: result.stopRefusals ?? 0,
        }),
      );
    } catch {
      return proofLine(
        proofOf({
          brief: lane.brief,
          tests: new Map(),
          messages: '',
          firstCommitFiles: [],
          redAtBase: [],
          stopRefusals: result.stopRefusals ?? 0,
        }),
      );
    }
  };
  const expose = (laneOk: boolean, proved: string): void => {
    try {
      appendExposure(
        main,
        exposureOf({
          run: slug,
          task,
          channel: 'lane',
          served: lane.servedIds,
          withheld: lane.withheldIds,
          laneOk,
          tokens: lane.servedTokens,
          attempt:
            readExposures(main).filter(
              (row) => row.task === task && row.channel === 'lane',
            ).length + 1,
          proof: proved,
        }),
      );
    } catch {
      /* The log is evidence, never a reason to lose a delivery. */
    }
  };
  const kept = `worktree ${path}, rerun reuses it`;
  // A failed run keeps its worktree as evidence and frees the task for a retry.
  const stop = async (
    reason: string,
    exitCode = exitNoDelivery,
  ): Promise<LaneVerdict> => {
    const proved = proofOfLane();
    expose(false, proved);
    if (task !== undefined)
      try {
        await releaseClaim(main, task);
      } catch {
        /* No claim left to release. */
      }
    return {
      line: `lane ${label}: ${reason} (${kept}${task === undefined ? '' : ', claim released'}) model ${model}${spent}${served}`,
      exitCode,
      packet: lane.packet,
      proof: proved,
    };
  };

  try {
    if (!result.ok && result.noProgress !== undefined)
      return await stop(
        `no progress: ${noProgressAttempts} identical Stop refusals with no edit between them (${result.noProgress}); ${result.detail}`,
        exitNoProgress,
      );
    if (!result.ok)
      return await stop(
        result.detail,
        refusal?.exitCode ??
          (notStarted
            ? exitCredentialUnavailable
            : result.capped
              ? exitBudgetCapped
              : exitNoDelivery),
      );
    if (result.blocker !== undefined)
      return await stop(result.blocker, exitSessionBlocked);
    // Taken before the placeholders go: the fast-pass key was written with them in the tree.
    const session = sessionVerification(path);
    const contractCheck =
      session === undefined
        ? contractVerification(
            path,
            join(main, '.krn', 'tmp', `lane-run-${slug}-check.log`),
            task,
            base,
          )
        : undefined;
    // Flaky: test files that failed, then passed on one rerun; named in the summary and the PR body.
    const flaky = [
      ...new Set([
        ...outcome.flaky,
        ...(contractCheck !== undefined && 'verified' in contractCheck
          ? contractCheck.flaky
          : []),
      ]),
    ];
    const flakyNote =
      flaky.length === 0
        ? ''
        : `flaky (failed, then passed on rerun): ${flaky.join(', ')}`;
    const proof =
      session ??
      (contractCheck !== undefined && 'verified' in contractCheck
        ? contractCheck.verified
        : undefined);
    const verifiedBase =
      proof === undefined || flakyNote === ''
        ? proof
        : `${proof}; ${flakyNote}`;
    for (const file of sandboxPlaceholders(
      git(path, ['status', '--porcelain', '-z', '--untracked-files=all']),
      (name) => lstatSync(join(path, name)),
    ))
      rmSync(join(path, file));
    if (git(path, ['status', '--porcelain']) !== '')
      return await stop('dirty tree');
    if (
      red !== undefined &&
      commitsSinceRed(path, red, task ?? slug).length === 0
    )
      return await stop(
        `no new commit since the red Check (run ${red.run} on ${red.sha.slice(0, 12)})`,
      );
    const range = `origin/${base}..HEAD`;
    const commits = git(path, ['log', '--format=%s', range])
      .split('\n')
      .filter((line) => line !== '');
    if (commits.length === 0) return await stop('no commit');
    // The sandbox cannot run npm against the registry: a manifest change leaves the lockfile stale, so the host follows it.
    const lockNote = followLockfile(path, range);
    const verified =
      verifiedBase === undefined || lockNote === undefined
        ? verifiedBase
        : `${verifiedBase}; ${lockNote}`;
    const commitLog =
      task === undefined
        ? ''
        : git(path, ['log', '--format=%s%x1f%b%x1e', range]);
    const ticketTitle =
      task === undefined ? undefined : ticketCommitTitle(commitLog, task);
    // A Refs-only commit is one step of a task that stays open: ship it with a --refs body.
    const refsTitle =
      task === undefined || ticketTitle !== undefined
        ? undefined
        : ticketCommitTitle(commitLog, task, 'Refs');
    const refsOnly = refsTitle !== undefined;
    const title =
      task === undefined
        ? commits[commits.length - 1]
        : (ticketTitle ?? refsTitle);
    if (title === undefined)
      return await stop(`no commit with a Ticket: ${task} trailer`);
    if (
      task !== undefined &&
      !refsOnly &&
      getTask(path, task).status !== 'closed'
    )
      return await stop('task not closed');
    if (verified === undefined)
      return await stop(
        contractCheck !== undefined && 'failure' in contractCheck
          ? contractCheck.failure
          : 'no passing check on the final tree',
      );

    const bodyDir = join(main, '.krn', 'tmp');
    mkdirSync(bodyDir, { recursive: true });
    const bodyFile = join(bodyDir, `lane-run-${slug}.md`);
    writeFileSync(
      bodyFile,
      task === undefined
        ? goalPrBody(goal ?? '', commits, verified)
        : renderPrBody({
            task: getTask(path, task),
            commits,
            verified,
            agent: `headless claude session ${result.detail}`,
            refs: refsOnly,
          }),
    );
    // The session may have outlived the token minted before it: mint again, and park the commit when that fails.
    const locked = await steps.mint(lane.environment);
    if (locked !== undefined) {
      parkCommit(parkedFile(main, slug), git(path, ['rev-parse', 'HEAD']));
      return await stop(
        `GitHub App credential unavailable after the work (${locked}); commit parked, unlock the vault and rerun to ship without the worker`,
        exitCredentialUnavailable,
      );
    }
    // Ship removes the worktree of a merged lane, so the proof is counted from the tree before it ships.
    const proved = proofOfLane();
    const shipped = await steps.ship([
      '--worktree',
      path,
      '--base',
      base,
      '--title',
      title,
      '--body-file',
      bodyFile,
    ]);
    // Ship ends a merge with cleanup lines after its verdict, so read the verdict line itself.
    const lines = shipped.trim().split('\n');
    const last =
      lines.findLast((line) => line.startsWith('verdict: ')) ??
      lines.pop() ??
      '';
    const merged = /^verdict: merged\b/u.test(last);
    if (merged) {
      rmSync(redFile, { force: true });
      rmSync(parkedFile(main, slug), { force: true });
    }
    expose(merged, proved);
    return {
      line: `lane ${label}: ${merged ? 'shipped' : 'not merged'} ${last} model ${model}${spent}${served}${flakyNote === '' ? '' : ` ${flakyNote}`}`,
      exitCode: merged ? 0 : exitNoDelivery,
      packet: lane.packet,
      proof: proved,
    };
  } catch (error) {
    // A throw after the claim (git, ship push, red Check, timeout) must not leave the claim live.
    const failed = redCheckOf((error as Error).message);
    if (failed !== undefined) {
      mkdirSync(dirname(redFile), { recursive: true });
      writeFileSync(redFile, `${JSON.stringify(failed)}\n`);
    }
    return await stop(`failed: ${(error as Error).message.split('\n')[0]}`);
  }
}
