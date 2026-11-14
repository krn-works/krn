# MVP-1M.7b — final dedup regression dogfood

**Date:** 2026-05-19
**Baseline:** 83da4170fe747c0c4ec9584aae147fc6a55723d0
**Status:** One tiny fix applied. 890/890 tests pass. Eval 11/11.

## 1. Summary

Final regression dogfood for the complete MVP-1M dedup line (canonical candidate dedup → final_url mark-only → dedup metadata → skipped_duplicate extraction skip → non-redirect fallback fix). One bug found: compact writer duplicated limitations by concatenating `result.limitations` with `result.discovery.limitations` (both already contained discovery limitations).

## 2. Baseline gate

- Tests: 890/890
- Eval-corpus: 11/11
- Compile: OK
- Whitespace: OK
- Working tree: clean (before fix)

## 3. Regression matrix

| Scenario | Expected | Actual | Result |
|---|---|---|---|
| **A. Candidate canonical dedup** | 3 URLs with utm/fragment/trailing slash → 1 candidate, 0 fetched (404 on example.com) | 1 candidate, 0 fetched, limitation says "Collapsed 2" | PASS |
| **B. Redirect → direct** | redirect success, direct skipped_duplicate, 1 evidence pack | 2 fetched, ['success', 'skipped_duplicate'], 1 success | PASS |
| **C. Direct → redirect** | direct success, redirect skipped_duplicate, 1 evidence pack | 2 fetched, ['success', 'skipped_duplicate'], 1 success | PASS |
| **D. Trailing slash (/docs/ vs /docs)** | candidate dedup collapses → 1 candidate, 1 fetched | 1 candidate, 1 success, limitation says "Collapsed 1" | PASS (candidate dedup handled it) |
| **E. follow_redirects=False** | no final_url skip, both succeed | 2 fetched, ['success', 'success'], no Skipped limitation | PASS |
| **F. JSON vs manifest limitations** | JSON + manifest YAML + manifest text all include "Skipped N" | JSON has Skipped, YAML has Skipped, text has Skipped (1 per section) | PASS |
| **G. Compact output** | 1 snippet (not 2), no duplicate evidence refs | 1 snippet section, valid compact format | PASS (after fix) |
| **H. Evidence pack count** | skipped_duplicate does not write duplicate evidence pack | Only kept result has evidence pack | PASS |
| **I. Eval-corpus** | 11/11 | 11/11 | PASS |

## 4. Fix applied

### search_tool/compact.py (line 262)

**Bug:** `all_limitations = list(result.limitations) + list(result.discovery.limitations)` — concatenated both lists, but `result.limitations` already contains discovery limitations (passed through from `search_query()`). This caused duplicate limitation entries in the compact output (e.g., "Query redaction is best-effort..." appeared twice).

**Fix:** Use `list(result.limitations)` only — same pattern as the manifest fix in MVP-1M.7a.

```python
# Before:
all_limitations = list(result.limitations) + list(result.discovery.limitations)

# After:
all_limitations = list(result.limitations)
```

### tests/test_compact_summary.py (test_contains_limitations)

**Fix:** Updated test to pass discovery limitations through `result.limitations` (matching real `search_query()` behavior where result.limitations already includes discovery limitations).

## 5. Verification

- Tests: 890/890
- Eval-corpus: 11/11
- Compile: OK
- Whitespace: OK
- Diff: 2 files, 2 insertions, 2 deletions

## 6. Acceptance verdict

**ACCEPT_DEDUP_LINE.** All regression scenarios pass. One tiny fix applied (compact limitation dedup). No evidence pack count issues, no JSON/manifest mismatch, no follow_redirects=False secret dedup, no compact snippet duplication.

## 7. Known limitations (unchanged)

- Registry scoped per `search_query()` call. No cross-query dedup.
- Cache hits still fetch body from cache before dedup check.
- `follow_redirects=False` means no dedup.

## 8. Files changed

- `search_tool/compact.py` — 1 line: dedup limitations (remove concatenation)
- `tests/test_compact_summary.py` — 1 line: update test to match real behavior
