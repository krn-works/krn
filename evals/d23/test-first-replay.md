# Test-first replay on the held-back outside rows

Recorded before any run.

Population: the three rows in `scripts/outside-hidden/tasks.json` (php igorw/get-in, npm parse-link-header, py unzip-http), public-source copies only (`/mnt/storage/tmp/krn-outside-public`). Nothing else is run; no row is dropped after seeing a result.

Arms: K (default lane brief, packet of conventions) and K+test-first (`KRN_TEST_FIRST=1`: the brief carries the test-first rule and the Stop hook refuses an end unless a changed test fails at the base and passes on the commit).

Selection: one run per row per arm, K first then K+test-first, row order php, npm, py (n=3 per arm). A second repetition of both arms runs only when the first-pass spend leaves room under the $2 cap. A run whose harness fails before the worker starts (clone or adopt error) is rerun once and both attempts are recorded.

Command: `node scripts/outside-acceptance.ts --task-file scripts/outside-hidden/tasks.json --scratch /mnt/storage/tmp/krn-outside-public --summary <arm summary>` with `KRN_TEST_FIRST=1` for the test-first arm only.

Metrics per arm: hidden pass count (upstream test restored over the merged tree), drain exit, cost in dollars from the drain output. Total spend cap $2.

Decision rule: test-first becomes the default only when its hidden pass count exceeds K's by at least one row with no more drain failures and no more than 1.5 times K's cost; with n=3 per arm any other outcome is not a clear signal and the rule stays opt-in.

## Result

Arm table: this file. Raw rows and drain logs: `.krn/runs/test-first-arm/` (ignored). Counting: first row for K; for K+test-first the first attempt per row that ran on a hook free of the two defects below.

| Arm | php get-in | npm parse-link-header | py unzip-http | hidden pass | drain exit 0 | cost |
|---|---|---|---|---|---|---|
| K | pass $0.13 | pass $0.12 | pass $0.13 | 3/3 | 3/3 | $0.38 |
| K+test-first (final hook) | pass $0.13 | pass $0.12 | pass $0.13 | 3/3 | 3/3 | $0.38 |

Attempts that exposed defects (all counted in spend, $1.81 in total of the $2 cap):
1. Release hook, test-first on: php fail (drain 73), npm fail (73), py pass. The Stop check did not treat `tests/GetInTest.php` or `test/parse-link-header.js` as test files ("no test file changed"). Fixed in `src/hook/stop.ts`.
2. Same hook still on PATH (the installed `krn` runs the hook, not the checkout): identical result. Later attempts put a `krn` shim for the checkout first on PATH for this experiment only.
3. Fixed test-file check: php fail (73), npm pass, py pass. The php contract declared its own test command but inherited the detected `vendor/bin/phpunit {files}` related command, which is not installed. Fixed in `src/repo/contract.ts`.
4. php rerun only: pass.

Verdict: no clear signal. Both arms pass 3/3 hidden rows at about $0.13 per row, so test-first costs nothing measurable and gains nothing measurable at n=3 on rows K already solves; the rule stays opt-in (`KRN_TEST_FIRST=1`). The replay's worth was the two defects it found in the test-first check on non-JS and plain-directory repositories. The installed `krn` needs a reinstall before the fix reaches lanes in other repositories (install and seal need a separate grant).
