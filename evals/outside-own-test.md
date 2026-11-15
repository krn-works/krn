# Outside rows: the worker's own test, red on base and green on merge

Population: the ten public-source row PRs merged on krn-works/krn (php, npm, py, php-red), selected before any run from `.krn/runs/overnight/status.md`; PRs 868-878 (operator code) are excluded. Each PR is one commit on its row base, so the merged state is the PR head tree (the squash commits are not fetchable, the branches are deleted).

Method: `scripts/outside-testgrade.ts` fetches `refs/pull/N/head` into a throwaway clone, takes the test files the PR added, runs them on the merged tree (after the row's install step), then checks out the base with only those test files overlaid and runs the same command. Red is a non-zero exit. A test-only row adds coverage for behavior that already exists, so it is green on both sides by construction; only a fix row can be red on base.

| PR | merged | kind | test files | base exit | merged exit | grade |
| --- | --- | --- | --- | --- | --- | --- |
| #883 | 52c9dd5 | test-only | tests/run.php | 0 | 0 | green-on-both |
| #884 | 53e0c32 | test-only | tests/test_cache.py | 0 | 0 | green-on-both |
| #888 | c6f42f7 | test-only | test/scan.test.mjs | 0 | 0 | green-on-both |
| #897 | 0493887 | test-only | test/parse-link-header.js | 0 | 0 | green-on-both |
| #898 | a5ce4c6 | test-only | tests/test_unzip_http.py | 0 | 0 | green-on-both |
| #901 | ba25a45 | test-only | tests/smoke.php | 0 | 0 | green-on-both |
| #930 | bbcfbfc | fix | tests/AssocInScalarTest.php | 1 | 0 | red-then-green |
| #907 | 4dccca0 | fix | tests/GetInTest.php | 1 | 0 | red-then-green |
| #906 | ebefbc2 | fix | test/parse-link-header.js | 1 | 0 | red-then-green |
| #908 | b16c462 | fix | tests/test_import.py | 1 | 0 | red-then-green |

Rows: 10. Red on base: 4/10. Green on merge: 10/10. Red on base then green on merge: 4/10.

Reading: all 10 worker tests are green on the merged tree. All 4 fix rows (#906, #907, #908, #930) have a worker test that fails on the base and passes on the merge, so test-first held there. The 6 test-only rows cannot show red-on-base and carry no signal for it.

Reproduce: `node --experimental-strip-types scripts/outside-testgrade.ts --out <file> 883:52c9dd5 884:53e0c32 888:c6f42f7 897:0493887 898:a5ce4c6 901:ba25a45 930:bbcfbfc 907:4dccca0 906:ebefbc2 908:b16c462`.
