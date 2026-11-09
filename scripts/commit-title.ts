// A squash merge makes the pull request title the commit subject on main, so
// CI checks the title: `type(scope): outcome (t-id)`. #400 dropped the type
// with no check and every later commit lost it.
const types = [
  'feat',
  'fix',
  'docs',
  'refactor',
  'perf',
  'test',
  'build',
  'ci',
  'chore',
  'revert',
];

const pattern = new RegExp(
  `^(${types.join('|')})(\\([a-z0-9][a-z0-9-]*\\))?!?: \\S.*?( \\(t-[a-z0-9]{7}\\))?$`,
  'u',
);

export function titleProblem(title: string): string | undefined {
  if (pattern.test(title)) return undefined;
  return `"${title}" is not "type(scope): outcome (t-id)"; type is one of ${types.join(', ')}`;
}

if (import.meta.main) {
  const title = process.env.PR_TITLE ?? process.argv[2] ?? '';
  const problem = titleProblem(title);
  if (problem) {
    console.error(`commit-title: FAIL ${problem}`);
    process.exit(1);
  }
  console.log('commit-title: PASS');
}
