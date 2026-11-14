import { lstatSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { releaseClaim } from '../../task/claims.ts';
import { getTask } from '../../task/store.ts';
import { renderPrBody } from '../pr-body.ts';
import {
  contractVerification,
  goalPrBody,
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
  exitSessionBlocked,
} from './result.ts';
import type { SessionOutcome } from './session.ts';
import type { LaneRunSteps, LaneVerdict } from './steps.ts';
import { commitsSinceRed } from './worktree.ts';

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
  const kept = `worktree ${path}, rerun reuses it`;
  // A failed run keeps its worktree as evidence and frees the task for a retry.
  const stop = async (
    reason: string,
    exitCode = exitNoDelivery,
  ): Promise<LaneVerdict> => {
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
    };
  };

  try {
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
          )
        : undefined;
    const verified =
      session ??
      (contractCheck !== undefined && 'verified' in contractCheck
        ? contractCheck.verified
        : undefined);
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
    if (merged) rmSync(redFile, { force: true });
    return {
      line: `lane ${label}: ${merged ? 'shipped' : 'not merged'} ${last} model ${model}${spent}${served}`,
      exitCode: merged ? 0 : exitNoDelivery,
      packet: lane.packet,
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
