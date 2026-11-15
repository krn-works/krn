/** Whether the message states a blocker on a line of its own: `BLOCKER: <reason>`, bold or plain. One reader for the Stop hook and the lane run. */
export function statesBlocker(message: unknown): boolean {
  return (
    typeof message === 'string' && /^\s*\**BLOCKER:\**\s*\S/mu.test(message)
  );
}
