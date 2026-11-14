# MVP-1M.2 — Candidate-level Canonical URL Dedup Implementation

**Date:** 2026-05-18
**Baseline:** 6d9385314d436c620e74714ec67b0f271b0721ee
**Status:** IMPLEMENTED — 845/845 tests pass, 11/11 eval pass

## Baseline

- 800/800 tests pass
- 11/11 eval-corpus pass
- `normalize_url` drops fragments, removes default ports, strips trailing slash, preserves query params including tracking params
- Two dedup stages exist: `parse_llms_txt()` (by normalized URL) and `build_discovery_result()` (by normalized URL)
- `duplicate_of` field exists on `DiscoveryCandidate`
- Evidence pack keying uses `normalize_url`

## Implementation Summary

### New file: `search_tool/canonical.py`

`canonicalize_url_for_dedup(url: str) -> str` — stricter URL normalization for dedup comparison.

### Modified: `search_tool/discovery.py`

`build_discovery_result()` now applies canonical dedup *before* existing normalized dedup. Collapsed candidates never reach the `DiscoveryCandidate` creation stage. Collapsed count reported in `limitations`.

### Modified: `tests/test_canonical.py` (new, 45 tests)

### Modified: `tests/test_discovery.py`

Updated duplicate tests to reflect canonical dedup behavior:
- Exact duplicates collapse to 1 candidate (not visible as `duplicate_of`)
- Collapsed count reported in `limitations`
- First candidate preserved (title, snippet from first occurrence)

### Modified: `tests/test_cli_smoke.py`

Updated `test_duplicate_url_selected_once` to expect collapsed behavior.

### Modified: `tests/fixtures/search_corpus/basic.json`

Updated `duplicate_results` and `mixed_candidates` scenarios to expect canonical dedup.

### Modified: `search_tool/eval_corpus.py`

Added `collapsed_duplicates_in_limitations` special check for eval scenarios.

## Canonical Rules Implemented

1. Lowercase scheme and host
2. Remove default ports (80/http, 443/https)
3. Empty path → `/`
4. Collapse duplicate slashes in path (`//` → `/`)
5. Strip trailing slash (except root `/`)
6. Strip fragment always
7. Remove tracking params:
   - Exact: `fbclid`, `gclid`, `msclkid`, `mc_cid`, `mc_eid`, `igshid`
   - Prefix: `utm_*`
8. Preserve meaningful params: `ref`, `source`, `via`
9. Sort retained query params deterministically
10. Preserve repeated params (sorted within key group)
11. Preserve path case
12. Non http/https: tracking param removal + sorting still apply

## Dedup Stage

**Location:** `build_discovery_result()` in `search_tool/discovery.py` (line ~130)

**Behavior:**
- Iterates all `RawDiscoveryCandidate` inputs
- Computes `canonicalize_url_for_dedup(url)` for each
- First occurrence wins; subsequent duplicates discarded
- `collapsed_count = len(raw_candidates) - len(deduped)`
- If `collapsed_count > 0`: adds `"Collapsed N duplicate candidate URLs by canonical dedup."` to `limitations`
- `max_candidates` applied after canonical dedup
- Existing normalized dedup becomes a fallback (only catches cases where canonical forms differ but normalized forms match — rare)

## duplicate_of Behavior

The existing `duplicate_of` field on `DiscoveryCandidate` is now a fallback for the *normalized* dedup stage. Canonical duplicates never reach `DiscoveryCandidate` creation — they're collapsed before. The `duplicate_of` field still points to the `normalized_url` of the kept candidate (unchanged).

For canonical dedup, the collapsed count is the authoritative indicator. The `duplicate_of` field is not set for canonical duplicates because they don't appear in the `DiscoveryCandidate` list.

## Limitations Behavior

- Format: `"Collapsed N duplicate candidate URLs by canonical dedup."`
- Only added when `N > 0`
- Appears before the standard redaction warning in the `limitations` tuple
- Deduped/capped: only one such message per `build_discovery_result` call
- No schema change — uses existing `limitations` tuple

## JSON / Backward Compatibility

- Fewer candidates in output (collapsed duplicates removed)
- `duplicate_of` field still exists (unchanged semantics for normalized duplicates)
- `limitations` tuple gains one optional string when duplicates are collapsed
- No new required JSON fields
- Candidate ordering preserved (first occurrence wins)
- Evidence filenames unchanged (still hash-based on normalized URL)
- Cache keys unchanged (still use `normalize_url`)

## Tests Added

**`tests/test_canonical.py`** — 45 tests covering:
- Scheme/host lowercasing
- Default port removal
- Non-default port preservation
- Empty path normalization
- Duplicate slash collapse
- Trailing slash stripping
- Fragment stripping
- Tracking param removal (all 8 names/patterns)
- Retained param preservation (`ref`, `source`, `via`)
- Query param sorting
- Repeated param preservation
- Path case preservation
- Non-HTTP passthrough
- Combined normalization

**Updated tests in `tests/test_discovery.py`** — 6 tests:
- `test_duplicate_collapse_in_limitations` (was `test_duplicate_remains_visible`)
- `test_duplicate_of_not_set_after_canonical_dedup` (was `test_duplicate_of_is_set`)
- `test_duplicate_candidates_collapsed_and_reported_in_limitations` (was `test_duplicate_candidates_remain_in_result`)
- `test_duplicate_collapsed_to_one` (was `test_duplicate_visible`)
- `test_first_candidate_selected` (was `test_duplicate_not_selected`)
- `test_duplicate_result_collapsed_by_canonical_dedup` (was `test_duplicate_result_visible_but_not_selected`)

**Updated tests in `tests/test_cli_smoke.py`** — 1 test:
- `test_duplicate_url_selected_once` — updated for canonical dedup

**Eval corpus updates:**
- `duplicate_results`: total=1, duplicates=0, collapsed in limitations
- `mixed_candidates`: total=2, duplicates=0, collapsed in limitations

## Final Counts

- Baseline: 800 tests, 11/11 eval
- After M.2: 845 tests (+45 canonical), 11/11 eval
- Compile: OK
- Whitespace: OK

## Known Limitations

1. **Tracking param list is conservative** — only the most common tracking params removed. Custom tracking params not covered.
2. **No percent-encoding normalization** — `%20` and ` ` treated as different.
3. **No IDNA/punycode normalization** — `xn--` forms treated as-is.
4. **No fetch-aware dedup** — final URL after redirect not considered.
5. **No HTML canonical tag extraction** — `<link rel="canonical">` not parsed.
6. **No content-hash dedup** — same content from different URLs not detected.
7. **No opt-out flag** — canonical dedup is always-on.

## Next Task

**MVP-1M.3** — Fetch-aware redirect/final_url dedup. After `search_query()` fetches evidence, check if `final_url` canonical key matches an earlier evidence result.
