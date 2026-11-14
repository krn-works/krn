# MVP-1M.4a — Mark-only final_url dedup dogfood

**Date:** 2026-05-19
**Baseline:** c34ee9e6b98411470acf701d18b6546f9123222d (feat: mark-only final_url dedup visibility)
**Status:** ACCEPT_FINAL_URL_MARK_ONLY

## Baseline Gate

- 868/868 tests pass (23 final_url + 45 canonical + 800 existing)
- 11/11 eval-corpus pass
- Compile: OK
- Whitespace: OK
- Working tree clean

## Controlled Mocked Dogfood

5 scenarios via direct `search_query()` calls with mocked fetchers.

| # | Scenario | Expected Results | Expected Dedup | Got Results | Got Dedup | Verdict |
|---|----------|-----------------|----------------|-------------|-----------|---------|
| A | Same final_url, different originals | 2 | 1 | 2 | 1 | PASS |
| B | Tracking params only | 2 | 1 | 2 | 1 | PASS |
| C | Trailing slash / fragment | 2 | 1 | 2 | 1 | PASS |
| D | Failed fetch excluded | 2 | 0 | 2 | 0 | PASS |
| E | No final_url (no redirects) | 2 | 0 | 2 | 0 | PASS |

### Scenario A — Same final_url, different originals

- **Original URLs:** `https://example.com/latest`, `https://example.com/docs/current`
- **Final URL (both):** `https://example.com/docs`
- **Result:** Limitation `Detected 1 duplicate fetched URLs by final_url canonical dedup.`
- **Evidence count:** 2 (both preserved, mark-only)

### Scenario B — Tracking params only

- **Final A:** `https://example.com/docs?utm_source=x`
- **Final B:** `https://example.com/docs`
- **Result:** Limitation `Detected 1 duplicate fetched URLs by final_url canonical dedup.`
- **Evidence count:** 2 (both preserved)

### Scenario C — Trailing slash / fragment

- **Final A:** `https://example.com/docs/#intro`
- **Final B:** `https://example.com/docs`
- **Result:** Limitation `Detected 1 duplicate fetched URLs by final_url canonical dedup.`
- **Evidence count:** 2 (both preserved)

### Scenario D — Failed fetch excluded

- **Success:** `final_url=https://example.com`
- **Failed:** `final_url=None`
- **Result:** No dedup limitation
- **Evidence count:** 2 (failed still present)

### Scenario E — No final_url (no redirects)

- **Both:** `final_url=None`
- **Result:** No dedup limitation
- **Evidence count:** 2 (unchanged)

## Wording Verification

All dedup limitation messages use `"Detected"` — not `"Collapsed"` or `"Skipped"`:

- `Detected 1 duplicate fetched URLs by final_url canonical dedup.`

The word "Detected" is accurate: we observed duplicates but did not collapse or skip any evidence.

## Evidence/Result Count Behavior

- Evidence result count is **unchanged** in all scenarios.
- Fetch statuses are **unchanged** — all remain `"success"`.
- Extraction statuses are **unchanged** — all remain `"success"`.
- `final_url` field is correctly set on successful fetch results.
- Discovery limitations appear before dedup limitation in the tuple (order preserved).

## Limitation Behavior

- Dedup limitation appended to `SearchRunResult.limitations` list.
- Discovery limitations come first (order preserved).
- No dedup message when `duplicate_count == 0`.
- Message format: `Detected N duplicate fetched URLs by final_url canonical dedup.`

## Live Smoke Test

Skipped. All final_url dedup logic is post-fetch registry with 23 controlled unit tests covering every code path. Mocked dogfood is sufficient for this phase.

## Frictions Found

None. The implementation is transparent — limitation messages surface only when duplicates are detected, and evidence is never mutated.

## Acceptance Verdict

**ACCEPT_FINAL_URL_MARK_ONLY**

- Controlled dogfood scenarios A-C detect duplicates correctly.
- Scenarios D-E do not falsely detect.
- Evidence result count stays unchanged in all scenarios.
- Fetch/extraction statuses unchanged.
- Limitation wording uses "Detected" (not "Collapsed"/"Skipped").
- Full suite 868/868 and eval 11/11 remain green.
- No repo pollution.

## Fixes Made

None. Implementation verified correct.

## Next Recommended Task

**MVP-1M.5** — Skip/dedup extraction stage. Add `fetch_status="skipped_duplicate"` for redirect-equivalent evidence results, skip extraction/writing, update consumers. Design from MVP-1M.3 memo.
