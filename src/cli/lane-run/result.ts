// The exit codes of a lane run; the session result itself is read by evals/replay/session-result.ts.

export const exitCredentialUnavailable = 69;
/** The receiver cannot take a delivery (no required Check on the base, a red base, or GitHub unreachable); no session started. */
export const exitReceiverNotReady = 72;

export const exitNoDelivery = 74;
/** The session ended with a `BLOCKER:` line; the verdict prints it instead of the tree state. */
export const exitSessionBlocked = 73;
/** The session stopped at its spend cap (`--max-budget-usd`); the commit, if any, is not shipped. */
export const exitBudgetCapped = 75;

/** The session made no progress: three identical Stop refusals with no edit between them. */
export const exitNoProgress = 79;
