import { spawnSync } from 'node:child_process';
import { flagValue } from '../../src/cli-kit/flag-value.ts';
import {
  chooseAccount,
  FIVE_HOUR_LIMIT,
  formatChoice,
  parseAccounts,
} from '../../src/successor/account-choice.ts';

// Usage: node scripts/claude/account-choice.ts [--limit PCT]
// Reads `cswap list` and prints `verdict: stay N | switch N | handoff (...)`: a switch never leaves
// the active account's organization; a cross-organization move is a handoff to a fresh session.
const i = process.argv.indexOf('--limit');
const limit =
  i > 0
    ? Number(
        flagValue(process.argv, i, () => new Error('--limit needs a percent')),
      )
    : FIVE_HOUR_LIMIT;
const run = spawnSync('cswap', ['list'], { encoding: 'utf8' });
if (run.status !== 0) {
  process.stderr.write(`account-choice: cswap list exited ${run.status}\n`);
  process.exit(1);
}
const accounts = parseAccounts(run.stdout);
if (accounts.length === 0) {
  process.stderr.write('account-choice: no accounts parsed from cswap list\n');
  process.exit(1);
}
console.log(formatChoice(chooseAccount(accounts, limit)));
