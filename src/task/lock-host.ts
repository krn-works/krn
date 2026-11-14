/** Claim locks are abstract unix sockets, which only Linux has. */
export const lockPlatform = 'linux';

/** The refusal naming why claim locking cannot run on `platform`, or null when it can. */
export function lockHostRefusal(platform: string): string | null {
  return platform === lockPlatform
    ? null
    : `claim locking requires Linux (this host is ${platform})`;
}
