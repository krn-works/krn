/**
 * The contract test narrowed to `files`: the paths go after the last command, behind `--` when an
 * npm-style runner forwards them to its script (`npm --prefix packages/x test -- a.test.ts`).
 */
export function rerunCommand(test: string, files: readonly string[]): string {
  const quoted = files.map((file) => `'${file.replaceAll("'", "'\\''")}'`);
  const last = test.split(/&&|\|\||;/u).pop() ?? test;
  const forward =
    /\b(?:npm|pnpm|yarn|bun)\b/u.test(last) && !/\s--(?:\s|$)/u.test(last);
  return `${test}${forward ? ' --' : ''} ${quoted.join(' ')}`;
}
