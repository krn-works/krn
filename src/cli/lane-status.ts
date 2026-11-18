import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { liveShipPid } from '../ci/ship-live.ts';
import { flagValue } from '../cli-kit/flag-value.ts';
import { CliUsageError } from '../cli-kit/usage-error.ts';
import { contractBase } from '../repo/contract.ts';
import { rootGhEnv } from '../repo/gh.ts';
import { mainCheckoutRoot } from '../task/claims.ts';
import { gitRun, isMergedOn, laneMergeVerdict, shipRecord } from './lane.ts';

export type LaneState =
  | 'live'
  | 'merged'
  | 'orphaned'
  | 'pr-open'
  | 'closed'
  | 'empty'
  | 'unknown';

/** The state of the newest pull request of a branch, or undefined when there is none; throws when gh cannot say. */
export type PrLookup = (
  main: string,
  branch: string,
) => { number: number; state: string } | undefined;

export const ghPrLookup: PrLookup = (main, branch) => {
  const out = spawnSync(
    'gh',
    [
      'pr',
      'list',
      '--head',
      branch,
      '--state',
      'all',
      '--json',
      'number,state',
      '--limit',
      '1',
    ],
    { cwd: main, encoding: 'utf8', env: rootGhEnv(main), timeout: 30_000 },
  );
  if (out.status !== 0) throw new Error(out.stderr);
  const [first] = JSON.parse(out.stdout) as { number: number; state: string }[];
  return first;
};

/** Whether the ship of one lane worktree is live, merged or orphaned. */
export function laneState(
  main: string,
  base: string,
  name: string,
  prOf: PrLookup = ghPrLookup,
): { state: LaneState; detail: string } {
  const tree = join(main, '.krn', 'worktrees', name);
  const pid = liveShipPid(tree);
  if (pid !== undefined) return { state: 'live', detail: `pid ${pid}` };
  const record = shipRecord(main, name);
  const headOf = gitRun(tree, ['rev-parse', 'HEAD']);
  const verdict = (pr?: { state: string }) =>
    laneMergeVerdict({
      record,
      head: headOf.status === 0 ? headOf.stdout.trim() : undefined,
      merged: (sha) => isMergedOn(main, base, sha),
      pr,
    });
  if (record && verdict() === 'merged')
    return { state: 'merged', detail: record.sha.slice(0, 12) };
  const ahead = gitRun(tree, ['rev-list', '--count', `origin/${base}..HEAD`]);
  if (ahead.status !== 0) return { state: 'unknown', detail: 'git failed' };
  if (Number(ahead.stdout.trim()) === 0)
    return { state: 'empty', detail: 'no commit past the base' };
  try {
    const pr = prOf(main, name);
    const decided = verdict(pr);
    if (decided === 'unshipped')
      return {
        state: 'orphaned',
        detail: `${ahead.stdout.trim()} commit(s), no pull request, no live ship`,
      };
    const label = pr ? `#${pr.number}` : '';
    return decided === 'merged'
      ? { state: 'merged', detail: label }
      : { state: decided, detail: `${label} ${pr?.state.toLowerCase()}` };
  } catch {
    return { state: 'unknown', detail: 'gh could not list pull requests' };
  }
}

export function laneStatusCommand(
  args: string[],
  prOf: PrLookup = ghPrLookup,
): string {
  let root: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] !== '--root')
      throw new CliUsageError('krn lane status [--root DIR]');
    root = flagValue(
      args,
      index++,
      () => new CliUsageError('--root requires a value'),
    );
  }
  const main = mainCheckoutRoot(root ?? process.cwd());
  const base = contractBase(main);
  const dir = join(main, '.krn', 'worktrees');
  const names = existsSync(dir)
    ? readdirSync(dir, { withFileTypes: true })
        .filter((e) => e.isDirectory() && existsSync(join(dir, e.name, '.git')))
        .map((e) => e.name)
        .sort()
    : [];
  return names
    .map((name) => {
      const { state, detail } = laneState(main, base, name, prOf);
      return `${name} ${state} ${detail}\n`;
    })
    .join('');
}
