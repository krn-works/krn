# MVP-1M.8 — Final dedup hygiene cleanup

**Status:** Complete
**Date:** 2026-05-19
**Baseline:** 3dc9c7592d7d33aa647f66c4ea2325aa7bbcf480

## Baseline

- 890/890 tests pass
- 11/11 eval-corpus pass
- Compile OK, whitespace OK
- Working tree clean

## Cleanup performed

### 1. Removed unused parameters from `_maybe_skip_duplicate()` (search_tool/run.py)

**Before:** `_maybe_skip_duplicate(url, normalized, cache_result, fetch_result, final_url_override, follow_redirects, policy, refresh, evidence_dir, dedup_registry)`

**After:** `_maybe_skip_duplicate(url, normalized, cache_result, fetch_result, final_url_override, follow_redirects, dedup_registry)`

Removed `policy`, `refresh`, `evidence_dir` from signature and both call sites (lines 108-118 and lines 194-204). These parameters were never read in the function body.

### 2. Fixed unused unpacked variable `kept_idx` (search_tool/search.py)

**Before:** `kept_idx, kept = seen_final_urls[key]`
**After:** `_, kept = seen_final_urls[key]`

The index was unpacked but never used in the block.

## Explicit statement

**No behavior changes.** These are purely cosmetic hygiene fixes — removing unused function parameters and an unused local variable. Dedup semantics, JSON schema, evidence format, limitation wording, manifest behavior, and skipped_duplicate behavior are all unchanged.

## Verification results

| Gate | Result |
|------|--------|
| dedup tests | 45/45 |
| full suite | 890/890 |
| compile | OK |
| whitespace | OK |
| eval-corpus | 11/11 |

## Out-of-scope items left alone

- **Duplicate `_run_fetch_list` in cli.py** (lines 276-397): Pre-existing dead code from May 2026. Two definitions of the same function; first one has an orphaned docstring block after `return 0`. Not introduced by M-line dedup work. Left alone per task instructions.

## Files changed

| File | Change |
|------|--------|
| `search_tool/run.py` | Removed 3 unused params from `_maybe_skip_duplicate` signature and 2 call sites (-8 lines, +2) |
| `search_tool/search.py` | Replaced `kept_idx` with `_` in dedup loop (-2, +2) |

## Final status

M-line dedup is complete and hygiene-clean. Ready for release notes/docs.
