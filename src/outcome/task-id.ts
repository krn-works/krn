/** The task id a PR title ends with, as `type(scope): outcome (t-xxxxxxx)`. */
export function titleTaskId(title: string): string | undefined {
  return /\((t-[0-9a-z]{7})\)\s*$/.exec(title)?.[1];
}
