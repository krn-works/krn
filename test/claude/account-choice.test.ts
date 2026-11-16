import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  chooseAccount,
  formatChoice,
  parseAccounts,
} from '../../src/successor/account-choice.ts';

// Captured `cswap list` output (emails and organization names replaced) with two organizations.
const captured = readFileSync(
  new URL('fixtures/cswap-list-two-orgs.txt', import.meta.url),
  'utf8',
);

test('parses every account with its organization and windows', () => {
  const accounts = parseAccounts(captured);
  assert.deepEqual(
    accounts.map((a) => [a.slot, a.org, a.active, a.fiveHour, a.sevenDay]),
    [
      [1, 'Team Org', false, 90, 30],
      [2, 'Team Org', false, 0, 48],
      [3, 'Team Org', true, 8, 16],
      [4, 'Personal Org', false, 0, 38],
      [5, 'Team Org', false, 0, 99],
    ],
  );
});

test('stays on the active account under the limit', () => {
  assert.equal(
    formatChoice(chooseAccount(parseAccounts(captured))),
    'verdict: stay 3',
  );
});

test('switches only within the session organization', () => {
  const accounts = parseAccounts(captured).map((a) =>
    a.slot === 3 ? { ...a, fiveHour: 90 } : a,
  );
  const choice = chooseAccount(accounts);
  assert.deepEqual(choice, { verdict: 'switch', slot: 2 });
  const candidates = accounts
    .filter((a) => a.org !== 'Team Org')
    .map((a) => a.slot);
  assert.ok(!candidates.includes((choice as { slot: number }).slot));
});

test('hands off instead of crossing organizations when none is left', () => {
  // Only the other organization's account has quota: the chooser never picks it.
  const accounts = parseAccounts(captured).map((a) =>
    a.org === 'Team Org' ? { ...a, fiveHour: 95 } : a,
  );
  const choice = chooseAccount(accounts);
  assert.equal(choice.verdict, 'handoff');
  assert.match(formatChoice(choice), /^verdict: handoff \(.*fresh successor/);
});
