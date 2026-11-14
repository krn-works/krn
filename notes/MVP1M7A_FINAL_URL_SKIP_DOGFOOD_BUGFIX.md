# MVP-1M.7a — final_url skip dogfood bugfix

**Date:** 2026-05-19
**Baseline:** 650442c784213cc731737cae95e4d2fe659bed25
**Status:** Bugfix complete. 890/890 tests pass. Eval 11/11.

## 1. Summary

During MVP-1M.7a dogfood evaluation with real redirect pairs, a runtime bug was found: the final_url dedup skip did not fire for non-redirected URLs. The fix ensures `final_url_override` is set to the normalized URL when `follow_redirects=True` and no redirects occurred. A secondary fix ensures the "Skipped N" limitation appears in both JSON output and the search manifest.

## 2. Bug found

Test: redirect URL + direct canonical URL with `follow_redirects=True`.
Expected: redirect → success, direct → `skipped_duplicate`.
Actual: both → `success`.

The dedup check returned early because `final_url_override` was `None` for the direct URL (no redirects).

## 3. Root cause

In `fetch_url_to_evidence()`, `final_url_override` was only set when `fetch_result.redirects` was non-empty:

```python
if follow_redirects and fetch_result.status == "success" and fetch_result.redirects:
    final_url_override = ...
```

When a URL has no redirects, `final_url_override` stayed `None`. The dedup check `_maybe_skip_duplicate()` requires `final_url_override is not None` (line 264: `if final_url_override is None: return None`).

This meant:
- `httpbin.org/redirect-to?url=.../get` (redirects) → final_url set → registered in dedup registry
- `httpbin.org/get` (no redirects) → final_url=None → dedup check skipped → extracted

## 4. Fix implemented

### search_tool/run.py

**Cache-hit path** (line ~99-105):
```python
final_url_override = None
if follow_redirects and fetch_result.redirects:
    final_hop = fetch_result.redirects[-1]
    final_url_override = final_hop.get("resolved_url") or normalize_url(url)
elif follow_redirects and not fetch_result.redirects:
    # No redirects — the final URL is the fetched URL itself.
    final_url_override = normalized
```

**Network-miss path** (line ~170-176):
```python
final_url_override = None
if follow_redirects and fetch_result.status == "success" and fetch_result.redirects:
    final_hop = fetch_result.redirects[-1]
    final_url_override = final_hop.get("resolved_url") or normalize_url(url)
elif follow_redirects and fetch_result.status == "success" and not fetch_result.redirects:
    # No redirects — the final URL is the fetched URL itself.
    final_url_override = normalized
```

`follow_redirects=False` still leaves `final_url_override=None` (no dedup).

### search_tool/search.py

**Post-processing ordering**: Moved the M.6/M.7 post-processing loop (dedup metadata population, limitation computation) **before** manifest writes. Previously, the limitation was computed after `write_search_run_manifest()` was called, so the manifest didn't include the dedup limitation.

**write_search_run_manifest() signature**: Added `limitations: tuple[str, ...] | None = None` parameter. The function now uses passed limitations (which include both discovery and computed limitations) instead of only `discovery.limitations`.

**YAML frontmatter**: `all_limitations = list(limitations) if limitations else list(discovery.limitations)`

**Text body**: Same logic for the "## Limitations" section.

## 5. Verification

### 5.1 Redirect + direct canonical pair
```
redirect-to?url=/get → success (first occurrence)
/get → skipped_duplicate (same canonical final_url)
evidence=1 (one pack written)
skipped_duplicates=1 in manifest
```

### 5.2 Trailing slash pair (no redirects)
```
https://pydantic.dev/ → success
https://pydantic.dev → skipped_duplicate (canonical normalize merges trailing slash)
```

### 5.3 JSON output
```json
"limitations": [
  "Query redaction is best-effort and not a security boundary.",
  "Skipped 1 duplicate fetched URLs by final_url canonical dedup."
]
"status": "ok"
```

### 5.4 Manifest output
```
## Limitations
- Query redaction is best-effort and not a security boundary.
- Skipped 1 duplicate fetched URLs by final_url canonical dedup.
```

### 5.5 No duplicate evidence pack
Skipped result's `evidence_path` points to the kept pack. No duplicate file written.

## 6. Tests

No new tests added — existing 14 M.7 tests cover the skip behavior with fake fetchers. The fix changes real fetcher behavior (non-redirected URL path) which was validated by dogfood.

- test_final_url_dedup.py: 45/45
- Full suite: 890/890
- Eval-corpus: 11/11
- Compile: OK
- Whitespace: OK

## 7. Evidence pack final_url behavior change

With this fix, `source.final_url` in evidence packs is now set for **all** successful fetches when `follow_redirects=True`, not just redirected URLs. Previously it was `None` for non-redirected URLs. This is correct — the final URL is the URL that was served, which equals the request URL when there are no redirects. The `build_evidence_pack()` function already handled this case (line 86-87), so the observable output is unchanged.

## 8. Known limitations

- Registry is scoped per `search_query()` call. No cross-query dedup.
- Cache hits still fetch the body (from cache) before dedup check.
- `follow_redirects=False` means no dedup.
