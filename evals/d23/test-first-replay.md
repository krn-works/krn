# Test-first replay on the held-back outside rows

Recorded before any run.

Population: the three rows in `scripts/outside-hidden/tasks.json` (php igorw/get-in, npm parse-link-header, py unzip-http), public-source copies only (`/mnt/storage/tmp/krn-outside-public`). Nothing else is run; no row is dropped after seeing a result.

Arms: K (default lane brief, packet of conventions) and K+test-first (`KRN_TEST_FIRST=1`: the brief carries the test-first rule and the Stop hook refuses an end unless a changed test fails at the base and passes on the commit).

Selection: one run per row per arm, K first then K+test-first, row order php, npm, py (n=3 per arm). A second repetition of both arms runs only when the first-pass spend leaves room under the $2 cap. A run whose harness fails before the worker starts (clone or adopt error) is rerun once and both attempts are recorded.

Command: `node scripts/outside-acceptance.ts --task-file scripts/outside-hidden/tasks.json --scratch /mnt/storage/tmp/krn-outside-public --summary <arm summary>` with `KRN_TEST_FIRST=1` for the test-first arm only.

Metrics per arm: hidden pass count (upstream test restored over the merged tree), drain exit, cost in dollars from the drain output. Total spend cap $2.

Decision rule: test-first becomes the default only when its hidden pass count exceeds K's by at least one row with no more drain failures and no more than 1.5 times K's cost; with n=3 per arm any other outcome is not a clear signal and the rule stays opt-in.
