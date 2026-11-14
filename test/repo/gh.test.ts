import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { type CommandRun, gh, ghRepoView } from '../../src/repo/gh.ts';

const capture = (name: string) =>
  readFileSync(new URL(`../fixtures/${name}`, import.meta.url), 'utf8');

test('gh runs the gh binary with the given argv and returns the captured reply', async () => {
  const calls: [string, string[]][] = [];
  const run: CommandRun = async (cmd, args) => {
    calls.push([cmd, args]);
    return capture('outcome-ledger/pr-list.json');
  };
  const reply = await gh(run, ['pr', 'list', '--state', 'merged']);
  assert.equal(reply, capture('outcome-ledger/pr-list.json'));
  assert.deepEqual(calls, [['gh', ['pr', 'list', '--state', 'merged']]]);
});

test('ghRepoView asks gh for the repository name as JSON', async () => {
  const calls: [string, string[]][] = [];
  const run: CommandRun = async (cmd, args) => {
    calls.push([cmd, args]);
    return capture('gh/repo-krn-works-krn.stdout.json');
  };
  assert.equal(
    await ghRepoView(run),
    capture('gh/repo-krn-works-krn.stdout.json'),
  );
  assert.deepEqual(calls, [
    ['gh', ['repo', 'view', '--json', 'nameWithOwner']],
  ]);
});
