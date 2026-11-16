Verbatim gh output for test/outcome/first-push-green.test.ts (captured 2026-11-16, gh 2.101.0, the operator's gh login, read access).

- pr-list.json: `gh pr list --repo krn-works/krn --state merged --limit 8 --json number`
- pr-<number>-commits.json: `gh pr view <number> --repo krn-works/krn --json commits --jq '[.commits[].oid]'` (the jq drops commit author accounts, which a capture never carries)
- check-runs-<sha>.json: `gh api "repos/krn-works/krn/commits/<sha>/check-runs?filter=all&per_page=100" --jq '<CHECK_RUN_FILTER in src/outcome/first-push-green.ts>'`, one per commit oid in the pr-*-commits.json files

The compact JSON files are listed in `.ignore` so Biome leaves them as captured.
