// One timeout ceiling for every node --test run (npm test, CI shards, npm run fast),
// so a test that never settles fails by name instead of hanging its job.
export const testTimeoutMs = 60_000;

/**
 * node --test flags for the ceiling. --test-force-exit ends a file once its tests
 * finish, so a timed-out test's live handle cannot keep the file running.
 * KRN_TEST_TIMEOUT_MS lowers the ceiling for the runners' own tests.
 */
export function testCeilingArguments(
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const override = Number(env.KRN_TEST_TIMEOUT_MS);
  const ms =
    Number.isInteger(override) && override > 0 ? override : testTimeoutMs;
  return [`--test-timeout=${ms}`, '--test-force-exit'];
}
