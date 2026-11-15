# Outside rows where the worker can fail: candidates, selection rule and result

## Selection rule (recorded before any run)

A row is a public fixed-issue commit that satisfies all of:

1. the upstream fix changes at least two source files, or one source file plus a mirrored copy of the same defect (not docs-only, not version bumps);
2. the fix commit adds or changes tests that fail on its parent and pass on the fix, so the held-back cases can be named and counted;
3. the repository has an existing suite that runs on the host with pytest in under a minute and is green on the parent;
4. the open licence is recorded in the row (`BSD-3-Clause` for both upstreams);
5. the task body states symptoms only: no file name, no function to change, no fix.

Hidden-case fraction is passed over total of the cases named with `-k` in each row's `hiddenVerify`, run on the merged tree after the held-back test files are restored from the fix. Existing-suite regressions are the failures of the row's full suite on the worker's merged tree before the hidden files return. Stop refusals are the distinct records the Stop gate refused in the row checkout. Turns and cost are summed over the drain's lane sessions. K runs once per row.

## Candidates

Scanned: the last 150 commits matching "fix" in mahmoud/boltons, tartley/colorama and sindresorhus/camelcase-keys (blobless clones under `/mnt/storage/tmp/krn-outside-public/scan`, never the other scratch root); the scan of six more repositories did not finish and is not part of the population.

| row | upstream | fix | hidden cases on base | verdict |
| --- | --- | --- | --- | --- |
| py-omd-compare | boltons | c463d16 | 2 (dictutils, urlutils mirror) | selected |
| py-omd-addlist | boltons | a1ea103 | 1 (dictutils, urlutils mirror) | selected |
| py-dict-updates | boltons | bbadc7a | 8 | selected |
| py-gc-types | boltons | f898d8f | 4 | selected |
| py-barrel-list | boltons | e00c10a | 3 | selected (the commit's bulk-removal speedup has no failing case and is not in the body) |
| py-sweep | boltons | 1216b46 | 11 | selected |
| py-osc-hang | colorama | bfa8c22 | 1 | selected |
| boltons | 6c7fa3e, 895f7c4, 67e4ba4, 4722701 | typos, build matrix, warnings, doctests | none | rejected: no failing case |
| camelcase-keys | dab3a85 | stopPaths with arrays | 1 ava test | rejected: one JS source file, ava counts a test, not a case |
| colorama | db00553 | Windows console | needs win32 | rejected: not runnable on the host |

Command: `node --experimental-strip-types scripts/outside-acceptance.ts --task-file scripts/outside-hidden/discriminating-tasks.json --stack <row>`, scratch `/mnt/storage/tmp/krn-outside-public`.

Added after the first batch of seven ran, each before its own run, by the same rule: py-fs-sweep (boltons 922e7b2, 7 hidden cases on base), py-mistune-render (lepture/mistune 614b019, 4), py-mistune-toc (4a38298, 3), py-mistune-image-depth (cca5ee6, 3), py-mistune-url-escape (f423704, 3). Candidates mistune 534127f (timing assertion, flaky), 245c006 and 278640e (one case each) were rejected.

## Result (K once per row)

| row | hidden cases | hidden | existing-suite regressions | Stop refusals | turns | USD |
| --- | --- | --- | --- | --- | --- | --- |
| py-omd-compare | 2/2 | pass | 0 | 0 | 6 | $0.13 |
| py-omd-addlist | 1/1 | pass | 0 | 0 | 7 | $0.13 |
| py-dict-updates | 8/8 | pass | 0 | 0 | 7 | $0.19 |
| py-gc-types | 4/4 | pass | 0 | 0 | 5 | $0.15 |
| py-barrel-list | 3/3 | pass | 0 | 0 | 8 | $0.18 |
| py-sweep | 9/11 | fail | 0 | 0 | 10 | $0.22 |
| py-osc-hang | 1/1 | pass | 0 | 0 | 6 | $0.14 |
| py-fs-sweep | 5/7 | fail | 0 | 0 | 9 | $0.21 |
| py-mistune-render | 4/4 | pass | 0 | 0 | 9 | $0.24 |
| py-mistune-toc | 4/4 | pass | 0 | 0 | 7 | $0.17 |
| py-mistune-image-depth | 2/3 | fail | 0 | 0 | 9 | $0.18 |
| py-mistune-url-escape | 3/3 | pass | 0 | 0 | 6 | $0.15 |

Total $2.09 over 12 graded rows (one earlier attempt of py-osc-hang cost $0.00). Rows below 100%: 3 of 12 (py-sweep, py-fs-sweep, py-mistune-image-depth), all multi-symptom bodies or a hidden setting name. Single-symptom rows all pass in 5 to 9 turns with no Stop refusals.

Harness defects found and fixed: the colorama base was red on the host (no `mock` package, two pytest-incompatible tests), which the green-base gate refused; the row now ships a mock shim and deselects those two tests, with a regression test that the shim serves the mock API. Every row's hook cell reads `skew`: the host entry is the pinned release checkout, not the lane worktree HEAD; this is the guard working, not a worker miss.
