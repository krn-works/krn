Verbatim gh output for test/outcome/first-push-green.test.ts (captured 2026-11-16, gh 2.101.0, the operator's gh login, read access).

- pr-list.json: `gh pr list --repo krn-works/krn --state merged --limit 8 --json number`
- pr-<number>-commits.json: `gh pr view <number> --repo krn-works/krn --json commits --jq '[.commits[].oid]'` (the jq drops commit author accounts, which a capture never carries)
- check-runs-<sha>.json: `gh api "repos/krn-works/krn/commits/<sha>/check-runs?filter=all&per_page=100" --jq '<CHECK_RUN_FILTER in src/outcome/first-push-green.ts>'`, one per commit oid in the pr-*-commits.json files

The compact JSON files are listed in `.ignore` so Biome leaves them as captured.

Force-pushed heads (captured 2026-11-16, same gh and login; PR 1156's first head c8cec81 failed and was force-pushed over, the merged head is b97fb4f):

- pr-list-force-pushed.json: `gh pr list --repo krn-works/krn --state merged --limit 50 --json number --jq '[.[] | select(.number == 1156)]'` (the jq keeps one PR of the real list)
- pr-<number>-branch.json: `gh pr view <number> --repo krn-works/krn --json headRefName,createdAt`
- runs-pr-<number>.json: `gh run list --repo krn-works/krn --branch <headRefName> --json headSha,conclusion,event,status,startedAt,createdAt --limit 100`
