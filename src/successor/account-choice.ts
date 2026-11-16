/**
 * Chooses the quota account a running session may continue on, from the text of `cswap list`.
 * A session keeps its organization: preserved thinking written under one organization is
 * unreadable under another, so a cross-organization move happens only through a handoff to a
 * fresh successor session, never as a switch.
 */

export type Account = {
  slot: number;
  org: string;
  active: boolean;
  /** Percent of the 5-hour window used; 0 when cswap prints no reset. */
  fiveHour: number;
  /** Percent of the 7-day window used. */
  sevenDay: number;
};

export type AccountChoice =
  | { verdict: 'stay'; slot: number }
  | { verdict: 'switch'; slot: number }
  | { verdict: 'handoff'; reason: string };

/** Default switch-away point (goal.md step 5): above 85% of the 5-hour window. */
export const FIVE_HOUR_LIMIT = 85;

const HEADER = /^\s*(\d+):\s+\S+\s+\[(.+?)\](\s+\(active\))?/;
const WINDOW = /^\s*[├└]\s*(5h|7d):\s+(\d+)%/;

/** Parses the Accounts block of `cswap list`; the Running instances block is ignored. */
export function parseAccounts(text: string): Account[] {
  const accounts: Account[] = [];
  for (const line of text.split('\n')) {
    if (/^Running instances/.test(line)) break;
    const head = HEADER.exec(line);
    if (head) {
      accounts.push({
        slot: Number(head[1]),
        org: head[2] as string,
        active: Boolean(head[3]),
        fiveHour: 0,
        sevenDay: 0,
      });
      continue;
    }
    const window = WINDOW.exec(line);
    const current = accounts.at(-1);
    if (window && current) {
      if (window[1] === '5h') current.fiveHour = Number(window[2]);
      else current.sevenDay = Number(window[2]);
    }
  }
  return accounts;
}

/**
 * Stays on the active account under the limit; otherwise switches to the same-organization
 * account with the lowest 5-hour use and a 7-day window below 100%; with none, hands off.
 */
export function chooseAccount(
  accounts: Account[],
  limit = FIVE_HOUR_LIMIT,
): AccountChoice {
  const active = accounts.find((a) => a.active);
  if (!active)
    return { verdict: 'handoff', reason: 'no active account in cswap list' };
  if (active.fiveHour <= limit && active.sevenDay < 100)
    return { verdict: 'stay', slot: active.slot };
  const candidates = accounts
    .filter(
      (a) =>
        !a.active &&
        a.org === active.org &&
        a.fiveHour < limit &&
        a.sevenDay < 100,
    )
    .sort((a, b) => a.fiveHour - b.fiveHour || a.sevenDay - b.sevenDay);
  const best = candidates[0];
  if (best) return { verdict: 'switch', slot: best.slot };
  return {
    verdict: 'handoff',
    reason: `no account of organization ${active.org} has quota left; continue only in a fresh successor session`,
  };
}

export function formatChoice(choice: AccountChoice): string {
  if (choice.verdict === 'handoff')
    return `verdict: handoff (${choice.reason})`;
  return `verdict: ${choice.verdict} ${choice.slot}`;
}
