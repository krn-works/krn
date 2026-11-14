# MVP-1M.4 — Mark-only final_url dedup visibility

**Date:** 2026-05-18
**Baseline:** 478f5c0777fff796075de95f1af5b7b823c7675b
**Scope:** Implement mark-only final_url dedup visibility layer.

## 1. Implementation Summary

Added `final_url: str | None = None` to `EvidenceWriteResult` and a dedup registry in `search_query()` that counts redirect-equivalent duplicates after all fetches complete. Results are marked via `limitations` — no extraction skipping, no evidence file mutation.

## 2. File Changes

### `search_tool/search.py`
- Added `final_url: str | None = None` to `EvidenceWriteResult` dataclass.
- Added `from search_tool.canonical import canonicalize_url_for_dedup` import.
- In `search_query()`: after the fetch loop, built `seen_final_urls` registry that canonicalizes `final_url` and counts duplicates. Appends `"Detected N duplicate fetched URLs by final_url canonical dedup."` to limitations.

### `search_tool/run.py`
- Both `fetch_url_to_evidence()` return paths (cache-hit and network-miss) now pass `final_url=final_url_override` to `EvidenceWriteResult`.
- Blocked path still returns `final_url=None` (no redirect info).

### `tests/test_final_url_dedup.py` (new)
- 23 tests covering: field existence, defaults, registry logic, edge cases.

## 3. final_url Field Behavior

| Scenario | final_url value |
|----------|----------------|
| `follow_redirects=True`, redirects exist, fetch succeeded | `redirects[-1]["resolved_url"]` |
| `follow_redirects=True`, no redirects (direct 200) | `None` |
| `follow_redirects=False` | `None` |
| Fetch failed | `None` |
| Fetch blocked | `None` |
| Cache hit (redirects stored in metadata) | `redirects[-1]["resolved_url"]` |

## 4. Mark-only Behavior

- All evidence packs are still created (no skipping).
- Duplicate count reported in `SearchRunResult.limitations`.
- No change to `EvidenceWriteResult` count or status values.
- No evidence file deletion or mutation.
- No new `fetch_status` values.

Limitation message format: `Detected N duplicate fetched URLs by final_url canonical dedup.`

## 5. JSON / Backward Compatibility

- `final_url` is an additive optional field on `EvidenceWriteResult`.
- The `_print_search_result_json` function builds dicts manually — it does not auto-serialize dataclass fields. So `final_url` does not appear in JSON output by default (consumers can add it if needed).
- No breaking changes to existing JSON schema.
- Limitations message follows the established additive pattern from MVP-1M.2.

## 6. Security / Redirect Policy

- Only successful fetch results contribute to dedup registry.
- Failed and blocked fetches are excluded.
- `final_url` is derived from policy-checked redirect hops (per-hop `check_url()` in `_fetch_with_redirects()`).
- No hidden redirect following.
- `follow_redirects=False` produces `final_url=None` → no dedup.

## 7. Tests Added

23 new tests in `tests/test_final_url_dedup.py`:

| Test | What |
|------|------|
| `test_final_url_field_exists` | Field is settable |
| `test_final_url_defaults_to_none` | Default is None |
| `test_final_url_can_be_none_explicit` | Explicit None accepted |
| `test_evidence_write_result_is_frozen` | Dataclass frozen |
| `test_two_results_same_final_url_collapsed` | duplicate_count=1 |
| `test_no_redirect_no_dedup` | final_url=None → no dedup |
| `test_different_final_urls_no_dedup` | Different URLs → no dedup |
| `test_tracking_param_final_url_collapsed` | UTM params canonicalized |
| `test_trailing_slash_final_url_collapsed` | Trailing slash canonicalized |
| `test_failed_fetch_not_collapsed` | Failed excluded |
| `test_blocked_fetch_not_collapsed` | Blocked excluded |
| `test_multiple_duplicates` | Three results → duplicate_count=2 |
| `test_limitation_message_present` | Exact message format |
| `test_limitation_message_absent` | No message when none |
| `test_final_url_field_set_on_success` | Value set on success |
| `test_final_url_none_when_no_redirects` | None when no redirects |
| `test_mark_only_no_result_count_change` | All results present |
| `test_discovery_limitations_preserved_order` | Discovery limitations first |
| `test_trailing_slash_collapsed` | canonicalize_url_for_dedup |
| `test_fragment_stripped` | canonicalize_url_for_dedup |
| `test_utm_params_removed` | canonicalize_url_for_dedup |
| `test_query_params_sorted` | canonicalize_url_for_dedup |
| `test_host_lowercased` | canonicalize_url_for_dedup |

## 8. Known Limitations

- MVP-1M.4 does NOT skip duplicate extraction (that's MVP-1M.5).
- `final_url` is not included in JSON output by default (manual dict construction in `_print_search_result_json`).
- Dedup only works when `follow_redirects=True` and redirects actually occurred.
- No HTML `<link rel="canonical">` extraction.
- No content-hash dedup.

## 9. Next Steps

- **MVP-1M.4a**: Dogfood validation — test with real redirect pairs.
- **MVP-1M.5**: Skip duplicate extraction — add `fetch_status="skipped_duplicate"`, skip extraction/writing, update consumers.

## 10. Verification

- **Tests:** 868/868 (845 baseline + 23 new)
- **Eval-corpus:** 11/11
- **Compile:** OK
- **Whitespace:** OK
- **Baseline:** 478f5c0777fff796075de95f1af5b7b823c7675b
