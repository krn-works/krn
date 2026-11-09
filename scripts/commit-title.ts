import { titleProblem } from '../src/ci/commit-title.ts';

export { titleProblem };

if (import.meta.main) {
  const title = process.env.PR_TITLE ?? process.argv[2] ?? '';
  const problem = titleProblem(title);
  if (problem) {
    console.error(`commit-title: FAIL ${problem}`);
    process.exit(1);
  }
  console.log('commit-title: PASS');
}
