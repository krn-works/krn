# Test-first arm on the discriminating outside rows

## Pre-registration (written and committed before any run)

Population: exactly the three rows of `scripts/outside-hidden/discriminating-tasks.json` where K scored below 100% hidden cases in `evals/outside-discriminating-rows.md`: py-sweep (9/11), py-fs-sweep (5/7), py-mistune-image-depth (2/3). No row is added or dropped after a result. Public-source copies only (`/mnt/storage/tmp/krn-outside-public`).

Arms: K (default brief) and K+test-first (`KRN_TEST_FIRST=1`: test-first rule in the brief, Stop hook refuses an end unless a changed test is red on the base and green on the commit). Two repetitions per row per arm: 12 runs, order K rep1, K+tf rep1, K rep2, K+tf rep2, rows in the order above. A run whose harness fails before the worker starts is rerun once; both attempts are recorded and counted in spend. Clones are deleted after each run. Spend cap $2; the run stops when it is reached and unrun cells are reported as missing.

Command per run: `node --experimental-strip-types scripts/outside-acceptance.ts --task-file scripts/outside-hidden/discriminating-tasks.json --stack <row> --scratch /mnt/storage/tmp/krn-outside-public --summary <arm/rep summary>`, with `KRN_TEST_FIRST=1` for the test-first arm only.

Metrics per row and arm: mean hidden-case fraction over the two reps; own-test red-on-base (the worker's added test fails on the row base and passes on the merge, `scripts/outside-testgrade.ts`), counted per run; existing-suite regressions; cost.

Decision rule:
- Adopt test-first as the default if K+tf's mean hidden cases exceed K's by at least one case on at least 2 of the 3 rows, no row has a lower K+tf mean than K, existing-suite regressions are not higher, and cost is at most 1.5 times K's.
- Close the arm (record closure, default stays off, no further replays) if K+tf is equal or worse than K on total mean hidden cases.
- Anything between (better on one row, or on two without meeting the margin) is no signal: the arm stays opt-in and the table is the evidence.
- Own-test red-on-base is reported as the mechanism check (K+tf should reach red-on-base more often than K); it does not decide by itself.

## Result

Raw summaries and logs: `.krn/runs/` is not used; the run files were kept under `/mnt/storage/tmp/tfv/` (ignored). Hidden-case fraction is passed over total; a dash is a cell not run.

| row | K rep 1 | K rep 2 | K+tf rep 1 | K+tf rep 2 |
| --- | --- | --- | --- | --- |
| py-sweep | 11/11 ($0.23) | 11/11 ($0.22) | 11/11 ($0.24) | 11/11 ($0.22) |
| py-fs-sweep | 5/7 ($0.19) | - | 0/7 ($0.22) | - |
| py-mistune-image-depth | 2/3 ($0.15) | 2/3 ($0.13) | 2/3 ($0.18) | - |

Existing-suite regressions 0 and Stop refusals 0 in all nine graded runs. Spend $1.78 for the nine graded runs plus one killed K rep 2 py-fs-sweep run (not graded, under $0.20), at the $2 cap: three cells (K rep 2 and K+tf rep 2 py-fs-sweep, K+tf rep 2 py-mistune-image-depth) were not run. Own-test red-on-base was not graded: the hook cell reads `skew` in every run (the host entry is the release checkout), so the Stop check was not the lane's own and a red-on-base grade would not measure the arm.

Defect found and fixed first: with `KRN_TEST_FIRST=1` in the environment, `krn adopt` ran its canary under the test-first Stop check, which refuses the clean tree, so every K+tf run failed at adopt ($0.00, first attempt of all three rows recorded). `adoptEnv` in `scripts/outside-acceptance.ts` now removes the arm from the adopt environment, with a test.

Rule applied: K+tf does not exceed K on any row, and py-fs-sweep is lower (0/7 against 5/7, the worker's change did not fix the symptom). The adoption condition fails ("no row has a lower K+tf mean") and the totals are equal-or-worse, so the arm is closed: the default stays off, `KRN_TEST_FIRST=1` remains an opt-in switch, and no further replay is planned on these rows. The missing cells cannot flip it: adoption needs a gain on two rows, and py-sweep is already at 11/11 for both arms.
