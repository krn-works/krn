import { bodyProblems } from '../src/ci/pr-body-rule.ts';

export { bodyProblems };

if (import.meta.main) {
  const problems = bodyProblems(process.env.PR_BODY ?? '');
  if (problems.length > 0) {
    console.error(`pr-body: FAIL ${problems.join('; ')}`);
    process.exit(65);
  }
  console.log('pr-body: PASS');
}
