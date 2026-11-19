// The exit codes of a lane run; the session result itself is read by evals/replay/session-result.ts.

export const exitCredentialUnavailable = 69;
/** The contract install failed in the lane worktree; no session started and the claim is released. */
export const exitInstallFailed = 71;
/** The receiver cannot take a delivery (no required Check on the base, a red base, or GitHub unreachable); no session started. */
export const exitReceiverNotReady = 72;

/** The base suite is red in the untouched lane worktree; no session started. Shares 72 with the receiver: both mean the base cannot take a delivery. */
export const exitBaseRed = 72;
/** The base suite failed with timeouts only: host load; no session started. */
export const exitBaseHostLoad = 78;

export const exitNoDelivery = 74;
/** The session ended with a `BLOCKER:` line; the verdict prints it instead of the tree state. */
export const exitSessionBlocked = 73;
/** The session stopped at its spend cap (`--max-budget-usd`); the commit, if any, is not shipped. */
export const exitBudgetCapped = 75;

/** The session made no progress: three identical Stop refusals with no edit between them. */
export const exitNoProgress = 79;

/** The final check failed with timeouts only, on a different file set each run: host load, not a defect; the worktree is kept for `krn lane finish`. */
export { exitHostLoadFlake } from '../../ci/test-failures.ts';
