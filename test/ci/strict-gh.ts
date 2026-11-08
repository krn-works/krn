import assert from 'node:assert/strict';

export const pullArgs = (repo: string, pr: number) => [
  'api',
  `repos/${repo}/pulls/${pr}`,
];
export const checkRunArgs = (repo: string, head: string) => [
  'api',
  '--paginate',
  '--slurp',
  `repos/${repo}/commits/${head}/check-runs?filter=all&per_page=100`,
];

/**
 * A fake `gh` that answers only the exact requests it was given and fails the
 * test on any other call, so a changed endpoint or query cannot pass silently.
 */
export function strictGh(
  repo: string,
  pr: number,
  head: string,
  answers: { pull: () => string; checks: () => string },
) {
  const calls: string[][] = [];
  const gh = async (args: string[]) => {
    calls.push(args);
    if (JSON.stringify(args) === JSON.stringify(pullArgs(repo, pr)))
      return answers.pull();
    if (JSON.stringify(args) === JSON.stringify(checkRunArgs(repo, head)))
      return answers.checks();
    assert.fail(`unexpected gh request: ${JSON.stringify(args)}`);
  };
  return { gh, calls };
}

export const pull = (head: string, mergeableState = 'blocked') =>
  JSON.stringify({ head: { sha: head }, mergeable_state: mergeableState });
