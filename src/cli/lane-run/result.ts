// The exit codes of a lane run; the session result itself is read by evals/replay/session-result.ts.

export const exitCredentialUnavailable = 69;
/** The contract install command failed in the lane worktree; no session started. */
export const exitInstallFailed = 71;
/** The contract test command is red on the clean base worktree; no session started. */
export const exitRedBaseline = 72;

export const exitNoDelivery = 74;
/** The session ended with a `BLOCKER:` line; the verdict prints it instead of the tree state. */
export const exitSessionBlocked = 73;
/** The session stopped at its spend cap (`--max-budget-usd`); the commit, if any, is not shipped. */
export const exitBudgetCapped = 75;

/** The session made no progress: three identical Stop refusals with no edit between them. */
export const exitNoProgress = 79;
