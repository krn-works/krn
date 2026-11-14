# MVP-1M.7 — Skip duplicate final_url extraction

**Date:** 2026-05-19
**Baseline:** f55cc3d61c8a453515a6278256ddd167490b8540
**Status:** Implementation complete. 890/890 tests pass. Eval 11/11.

## 1. Summary

Implemented the skip stage for final_url dedup. When a fetched URL's final_url is already known to have a successful evidence pack, extraction and evidence writing are skipped. The result is a synthetic `EvidenceWriteResult` with `fetch_status="skipped_duplicate"` pointing to the kept evidence pack.

## 2. Design

### 2.1 Shared dedup registry

`search_query()` builds a `dict[str, EvidenceWriteResult]` (canonical final_url → kept result) before the fetch loop. This registry is passed to each `fetch_url_to_evidence()` call via the `_final_url_dedup_registry` parameter.

### 2.2 Pre-extraction dedup check

In `fetch_url_to_evidence()`, after fetch (or cache hit) completes but before extraction:
1. Compute `final_url_override` from redirects (as before)
2. If `follow_redirects` is True and `final_url_override` is not None:
   - Canonical key = `canonicalize_url_for_dedup(final_url_override)`
   - If key exists in registry → return synthetic skipped result
   - Otherwise continue to extraction/write
3. After successful write, register key → result in registry

### 2.3 Synthetic skipped result

```
fetch_status = "skipped_duplicate"
extraction_status = "skipped"
evidence_path = kept.evidence_path
text_chars = 0
truncated = False
errors = ()
limitations = ()
dedup_status = "duplicate_final_url"
duplicate_of_url = kept.final_url
duplicate_of_evidence_path = kept.evidence_path
final_url = the duplicate's final_url
http_status = fetched duplicate's HTTP status
cache_status = cache result status
```

### 2.4 First occurrence wins

The first result with a given canonical final_url is kept. All subsequent results with the same canonical final_url are skipped.

## 3. Files changed

| File | Change |
|------|--------|
| `search_tool/run.py` | Added `_final_url_dedup_registry` param to `fetch_url_to_evidence()`. Added `_maybe_skip_duplicate()` and `_maybe_register_final_url()` helper functions. Added `skipped` counter to `write_fetch_list_manifest()`. |
| `search_tool/search.py` | Built dedup registry before fetch loop. Passed registry to fetcher. Added M.6 post-processing (for fake fetchers in tests). Changed limitation from "Detected" to "Skipped" (when actual skips). Added `fetch_skipped` and `fetch_evidence` counters to `write_search_run_manifest()`. |
| `search_tool/cli.py` | JSON status: `succeeded + skipped == total` → "ok". Included `skipped_duplicate` in evidence_results (not failures). |
| `search_tool/eval_corpus.py` | Added `actual_skipped` and `skipped_duplicates` eval check key. |
| `tests/test_final_url_dedup.py` | Added `TestMVP1M7SkipExtraction` class with 14 tests. |
| `tests/test_search.py` | Updated fake fetchers to accept `**kwargs`. Updated `evidence_packs` count expectation. |

## 4. skipped_duplicate semantics

| Field | Value |
|-------|-------|
| fetch_status | "skipped_duplicate" |
| extraction_status | "skipped" |
| evidence_path | Kept evidence path |
| text_chars | 0 |
| dedup_status | "duplicate_final_url" |
| duplicate_of_url | Kept final_url |
| duplicate_of_evidence_path | Kept evidence path |
| errors | () |

## 5. Evidence path semantics

`evidence_path` on skipped results points to the kept evidence pack. No duplicate evidence file is written. This is consistent with the M.6 data model.

## 6. Limitations message

- When actual skips occurred: `"Skipped N duplicate fetched URLs by final_url canonical dedup."`
- When mark-only (no skips, M.6 post-processing only): `"Detected N duplicate fetched URLs by final_url canonical dedup."`

## 7. JSON status behavior

- `succeeded + skipped == total` → `"ok"`
- `succeeded < total - skipped` → `"partial_success"`
- `total == 0` → `"error"`

Skipped_duplicate results are included in `evidence_results` (not `failures`) since they are intentional, not errors.

## 8. Compact summary behavior

Skipped results have `fetch_status="skipped_duplicate"`, which is not `"success"`. Therefore `_build_source_entries` doesn't extract snippets for them. The evidence_path displays as `-` in the source table. Quality score is 1 (extraction_status="skipped").

## 9. Manifest changes

### fetch-list manifest (write_fetch_list_manifest)
- Added `skipped` counter to YAML and text sections.

### search run manifest (write_search_run_manifest)
- Added `skipped_duplicates` counter to YAML.
- Added "Skipped duplicates" line to text body (only when > 0).
- `evidence_packs` now counts only `success + truncated` results (not "non-blocked").

## 10. Backward compatibility

- `fetch_url_to_evidence()` can be called without `_final_url_dedup_registry` (default None).
- Existing callers (fetch-url, fetch-list, eval-corpus) work unchanged.
- `search_query()` always passes the registry when using `fetch_url_to_evidence` as fetcher.
- M.6 post-processing preserves backward compatibility with fake fetchers in tests.

## 11. Tests added (14)

1. `test_skipped_fetch_status` — fetch_status="skipped_duplicate"
2. `test_skipped_extraction_status` — extraction_status="skipped"
3. `test_skipped_evidence_path_kept` — evidence_path points to kept pack
4. `test_skipped_text_chars_zero` — text_chars=0
5. `test_skipped_dedup_status` — dedup_status="duplicate_final_url"
6. `test_skipped_duplicate_of_evidence_path` — duplicate_of_evidence_path points to kept pack
7. `test_skipped_duplicate_of_url_matches_kept` — duplicate_of_url matches kept final_url
8. `test_skipped_no_evidence_file_written` — no duplicate evidence file
9. `test_first_occurrence_remains_success` — first occurrence is success/unique
10. `test_multiple_duplicates_skip_all` — multiple duplicates all skipped
11. `test_no_redirects_no_skip` — without follow_redirects, no dedup
12. `test_skipped_limitation_message` — skipped result has no limitation (limitation is at search_query level)
13. `test_backward_compat_no_registry` — works without registry parameter
14. `test_limitation_say_skipped_not_detected` — integration test, limitation says "Skipped"

## 12. Security

- Redirect policy still applies: blocked redirect targets fail (not skip).
- No new network surface.
- Registry scoped to single search_query() call.

## 13. Known limitations

- Registry is scoped per search_query() call. No cross-query dedup.
- Cache hits still fetch the body (from cache) before dedup check. This is acceptable — the cache hit already represents a completed fetch.
- `follow_redirects=False` means no dedup (final_url=None). This is correct — without redirect following, we can't know the final URL.
- `fetch-evidence` writes blocked/failure evidence packs as before. Only successful duplicates are skipped.

## 14. Next task

M.7a — Dogfood evaluation with real redirect pairs.

## 15. Verification

- Tests: 890/890 (876 existing + 14 new)
- Eval-corpus: 11/11
- Compile: OK
- Whitespace: OK
- Baseline SHA: f55cc3d61c8a453515a6278256ddd167490b8540
