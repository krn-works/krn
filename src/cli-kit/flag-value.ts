/**
 * Reads the value that follows the flag at `index`. Only an absent argument is
 * missing: free-text values such as `--note "--force is gone"` may start with `--`.
 */
export function flagValue(
  args: readonly string[],
  index: number,
  missing: () => Error,
): string {
  const value = args[index + 1];
  if (value === undefined) throw missing();
  return value;
}
