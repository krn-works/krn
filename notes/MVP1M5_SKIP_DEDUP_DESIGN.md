# MVP-1M.5 — Skip/extract dedup design

**Date:** 2026-05-19
**Baseline:** a3468542d5b6350851464103986fb1902c1f3ca0
**Status:** Design complete. Recommendation: MVP-1M.6 mark+reference first, MVP-1M.7 skip extraction.

## 1. Current State

MVP-1M.4 mark-only final_url dedup is live:

- `EvidenceWriteResult` has `final_url: str | None = None`.
- `search_query()` builds a `seen_final_urls` registry after the fetch loop.
- Duplicates are counted and reported via `limitations`.
- All evidence packs are created (no skipping).
- No new `fetch_status` values.
- No evidence file mutation.

**Tests:** 868/868. **Eval:** 11/11. **Dogfood:** ACCEPT_FINAL_URL_MARK_ONLY.

## 2. Problem Statement

Mark-only dedup provides visibility but no storage/performance benefit. When two discovery candidates fetch to the same final_url (e.g., `https://example.com/old` → 301 → `https://example.com/docs` and `https://example.com/latest` → 301 → `https://example.com/docs`), we write two identical evidence packs and expend network + extraction work for the duplicate.

The goal is to **skip extraction and evidence writing** when a fetched URL's final_url is already known to have successful evidence.

## 3. Architecture Analysis

### 3.1 Current pipeline

```
search_query()
  ├─ provider.discover() → candidates
  ├─ urls_for_fetch() → fetch_urls
  ├─ for url in fetch_urls:
  │   └─ fetcher(url, refresh, follow_redirects)
  │       └─ fetch_url_to_evidence()
  │           ├─ policy check
  │           ├─ cache_get / fetch_url
  │           ├─ extract(body, content_type)
  │           ├─ build_evidence_pack()
  │           └─ write_evidence_pack() → EvidenceWriteResult
  ├─ manifest_writer(evidence_results)
  ├─ dedup registry (mark-only)
  └─ SearchRunResult
```

`fetch_url_to_evidence()` is a single function that does fetch → extract → write atomically. It is the `fetcher` callable passed to `search_query()`.

### 3.2 Where final_url is known

In `run.py::fetch_url_to_evidence()`, `final_url_override` is computed from:
- Cache hit metadata: `fetch_result.redirects[-1]["resolved_url"]`
- Network miss: `fetch_result.redirects[-1]["resolved_url"]`

This is known **after** the fetch (or cache hit) completes, **before** extraction starts.

### 3.3 Where dedup registry lives

Currently in `search_query()`, **after** the fetch loop. This means all evidence is already written before dedup is evaluated.

## 4. Options

### Option A — Keep M.4 mark-only forever

**Risk:** Lowest. No code changes to pipeline.

**Cost:** No storage or performance benefit. Wasted fetch + extraction work on duplicates.

**Verdict:** Acceptable for a disposable spike, but the dedup signal is wasted if we never act on it.

### Option B — Split fetch and extract/write; dedup between phases

**Approach:**
1. `search_query()` builds dedup registry *before* fetch loop.
2. Fetcher function takes a pre-built registry and checks it after learning final_url.
3. If final_url duplicate of a previously succeeded result → return synthetic EvidenceWriteResult:
   - `fetch_status = "skipped_duplicate"`
   - `extraction_status = "skipped"`
   - `evidence_path` = path of the kept evidence pack
   - `final_url` = the canonical final_url
4. Only unique results proceed to extraction and evidence writing.

**Refactor required:**
- `fetch_url_to_evidence()` gains optional `seen_final_urls: dict[str, int]` parameter.
- After fetch (before extract), check registry. If duplicate, return early with synthetic result.
- `search_query()` builds registry and passes it to fetcher (or the fetcher builds its own).

**Pros:** Cleanest approach. Cuts extraction and evidence writing for duplicates. No unnecessary I/O.

**Cons:** Requires refactoring `fetch_url_to_evidence()`. Changes the fetcher contract.

### Option C — Write evidence, then delete duplicates

**Approach:** Same as M.4, but after dedup detection, delete duplicate evidence packs.

**Pros:** Minimal pipeline change.

**Cons:** Wastes network + extraction work. Deletes evidence that was just created. No extraction skip benefit. Evidence pack count in manifests doesn't match fetch count.

**Verdict:** Worse than B. Not recommended.

### Option D — Post-write synthetic result (skip after write)

**Approach:** After M.4's mark-only loop, for each duplicate, mutate the corresponding EvidenceWriteResult:
- `fetch_status = "skipped_duplicate"`
- `extraction_status = "skipped"`
- `evidence_path` = kept evidence path
- Delete the duplicate evidence file

**Pros:** Small diff on top of M.4. No pipeline refactor.

**Cons:** Evidence is already written and read (wasted work). Mutates a frozen dataclass (would need to unfreeze or use post-processing). Evidence file deleted after write (worse than B). Consumers get inconsistent evidence_pack_count vs fetch_count.

**Verdict:** Worse than B. Not recommended.

### Option E — Two-phase pipeline

**Approach:**
- Phase 1: Fetch headers/body for all candidates.
- Phase 2: Build dedup registry. Extract/write only unique final_urls.

**Pros:** Clean separation. No wasted extraction work.

**Cons:** Large refactor. Requires storing fetch bodies temporarily. Changes the entire fetch loop structure.

**Verdict:** Too big for MVP. B is sufficient.

### Option F — Mark+reference (intermediate step before skip)

**Approach:** Same as M.4 mark-only, but add explicit metadata fields to EvidenceWriteResult for duplicate results:
- `dedup_status: str = "unique"`
- `duplicate_of_url: str | None = None`
- `duplicate_of_evidence_path: Path | None = None`

For duplicates:
- `dedup_status = "duplicate_final_url"`
- `duplicate_of_url = kept final_url`
- `duplicate_of_evidence_path = kept evidence path`

Evidence is still written (no skip). But consumers now have explicit dedup metadata on each result.

**Pros:** No pipeline refactor. Additive fields only. Consumers can optionally act on dedup metadata. Dogfood-able. Establishes the data model for skip.

**Cons:** No storage/performance benefit yet. Same as M.4 plus metadata.

**Verdict:** Recommended as MVP-1M.6. Bridges M.4 mark-only to M.7 skip.

## 5. Recommendation

**MVP-1M.5 design recommends MVP-1M.6 (mark+reference) first, then MVP-1M.7 (skip extraction).**

Do not implement skip directly. The current pipeline (`fetch_url_to_evidence()` as a single atomic function) does not support clean pre-extraction skipping without a refactor that would be hard to dogfood incrementally.

**MVP-1M.6: Mark+reference** — Add explicit dedup metadata fields to EvidenceWriteResult while keeping mark-only behavior (no skip, no file deletion). This:
- Establishes the data model for skip.
- Is additive (backward compatible).
- Lets consumers start using dedup metadata.
- Is testable and dogfoodable without pipeline refactor.

**MVP-1M.7: Skip extraction** — Pass dedup registry into `fetch_url_to_evidence()`. After fetch, before extract, check registry. If duplicate, return synthetic EvidenceWriteResult with `fetch_status="skipped_duplicate"`, `evidence_path` = kept path. Only unique results extract and write.

## 6. Proposed Data Model (MVP-1M.6)

### EvidenceWriteResult additions

```python
@dataclass(frozen=True)
class EvidenceWriteResult:
    ...
    final_url: str | None = None
    dedup_status: str = "unique"          # "unique" | "duplicate_final_url"
    duplicate_of_url: str | None = None   # canonicalized final_url of kept result
    duplicate_of_evidence_path: Path | None = None  # kept evidence path
```

**Defaults:** `dedup_status="unique"`, `duplicate_of_url=None`, `duplicate_of_evidence_path=None`.

**For duplicates:**
- `dedup_status = "duplicate_final_url"`
- `duplicate_of_url = kept final_url (string)`
- `duplicate_of_evidence_path = kept evidence path`

These fields are additive — no existing consumer code touches them. They are read only in the M.6 dedup logic.

### Limitations message

M.4: `Detected N duplicate fetched URLs by final_url canonical dedup.`
M.6 (same, since no skip): `Detected N duplicate fetched URLs by final_url canonical dedup.`

No change needed — no skip yet.

## 7. JSON / Backward Compatibility

### CLI JSON output (`_print_search_result_json`)

Current logic:
```python
succeeded = sum(1 for r in result.evidence_results if r.fetch_status == "success")
total = len(result.evidence_results)
status = "ok" if succeeded == total else "partial_success"
```

With M.6 (mark-only, no skip): **No change.** All `fetch_status` values remain `"success"`. `dedup_status` is not included in JSON output.

With M.7 (skip): New `fetch_status="skipped_duplicate"` would be included in JSON. The `succeeded == total` check would change: skipped results would not count as succeeded. This is semantically correct — the URL was not successfully fetched (it was skipped).

Consumers would see:
- The URL in `evidence_results` with `status: "skipped_duplicate"`.
- `evidence_path` pointing to the kept evidence.
- `succeeded` count reduced by skip count.

### Compact summary (`write_compact_summary`)

Current logic:
```python
if r.fetch_status == "success":
    snippet = _extract_evidence_text(r.evidence_path)
```

With M.6: **No change.** All `fetch_status` values remain `"success"`.

With M.7: Skipped results would have `fetch_status="skipped_duplicate"` and would NOT produce snippets. This is correct — no extraction was performed. The evidence_path would still point to the kept pack, but we wouldn't read it for skipped entries.

### Eval-corpus (`eval_corpus.py`)

Current checks:
```python
actual_succeeded = sum(1 for r in result.evidence_results if r.fetch_status == "success" and ...)
```

With M.6: **No change.**

With M.7: Eval scenarios would need `expect.fetch.skipped_duplicates` counts. Test expectations would need updating for scenarios with redirect pairs.

### Fetch list manifest (`write_fetch_list_manifest`)

Current logic counts by `fetch_status`. Skipped results would appear as `"skipped_duplicate"` status. The manifest would need a `skipped` counter. This is a small additive change.

### Search run manifest (`write_search_run_manifest`)

Current fetch summary: `requested_urls`, `evidence_packs`, `succeeded`, `blocked`, `failed`.

With M.7: A new `skipped_duplicates` count would be additive. No breaking changes.

## 8. Evidence Path Semantics for Skipped Results

**M.7 decision:** `evidence_path` points to the **kept** evidence pack (the first result with that final_url).

**Why:**
- Writing a stub evidence file would be wasteful and confusing.
- `None` would require changing the type from `Path` to `Path | None` — breaking.
- Pointing to the kept pack lets consumers find the actual evidence without ambiguity.

**Consumer behavior:** A consumer seeing `fetch_status="skipped_duplicate"` with `evidence_path` should read the kept evidence, not the (non-existent) duplicate.

## 9. Limitations Behavior

When skip is implemented (M.7):
- Limitations still emitted: `"Skipped N duplicate fetched URLs by final_url canonical dedup."`
- Message word changes from "Detected" to "Skipped" to accurately reflect action taken.
- Both `dedup_status` and `duplicate_of_*` fields populated on each duplicate result.

## 10. Compact Pipeline Design (M.7)

```
search_query()
  ├─ provider.discover() → candidates
  ├─ urls_for_fetch() → fetch_urls
  ├─ Build dedup registry: seen_final_urls = {}
  ├─ For url in fetch_urls:
  │   └─ result = fetcher(url, refresh, follow_redirects, seen_final_urls)
  │       └─ fetch_url_to_evidence(..., seen_final_urls)
  │           ├─ policy check
  │           ├─ cache_get / fetch_url
  │           ├─ Compute final_url_override
  │           ├─ CHECK DEDUP REGISTRY:
  │           │   key = canonicalize_url_for_dedup(final_url)
  │           │   if key in seen_final_urls:
  │           │       # Duplicate! Return synthetic result.
  │           │       # evidence_path = kept result's evidence_path
  │           │       # fetch_status = "skipped_duplicate"
  │           │       # dedup_status = "duplicate_final_url"
  │           │       # duplicate_of_url = final_url
  │           │       return synthetic result
  │           │   else:
  │           │       seen_final_urls[key] = result  (store by index)
  │           ├─ extract(body, content_type)
  │           ├─ build_evidence_pack()
  │           └─ write_evidence_pack()
  ├─ manifest_writer(evidence_results)
  ├─ Count skipped for limitations
  └─ SearchRunResult
```

Key design: The dedup registry is shared across all fetch calls. Each `fetch_url_to_evidence()` call checks and updates the registry. First occurrence wins (same as M.4).

## 11. Test Plan

### M.6 tests (mark+reference, no skip)

1. `test_dedup_status_field_exists` — field is settable with default "unique"
2. `test_dedup_status_defaults_unique` — default is "unique"
3. `test_duplicate_fields_set_on_dedup` — duplicate result has dedup_status="duplicate_final_url", duplicate_of_url, duplicate_of_evidence_path set
4. `test_duplicate_fields_none_on_unique` — unique result has None for duplicate fields
5. `test_duplicate_of_evidence_path_points_to_kept` — path matches the first result's evidence_path
6. `test_multiple_duplicates_all_marked` — three results, one kept + two duplicates, all marked
7. `test_dedup_metadata_not_in_mark_only_limitation` — limitation still says "Detected" not "Skipped"
8. `test_dedup_fields_backward_compat` — existing code doesn't break with new fields

### M.7 tests (skip extraction)

1. `test_skipped_fetch_status` — duplicate has fetch_status="skipped_duplicate"
2. `test_skipped_extraction_status` — duplicate has extraction_status="skipped"
3. `test_skipped_evidence_path_kept` — evidence_path points to kept pack
4. `test_skipped_no_evidence_file_written` — no duplicate evidence file on disk
5. `test_skipped_not_in_dedup_registry` — failed/skipped results don't block future matches
6. `test_skipped_count_in_limitations` — limitation says "Skipped N duplicate..."
7. `test_skipped_preserves_first_wins` — first occurrence's evidence is the kept one
8. `test_skipped_no_extraction_call` — extract() not called for skipped results
9. `test_skipped_json_output` — JSON includes skipped_duplicate status

## 12. Risks

| Risk | Mitigation |
|------|-----------|
| Frozen dataclass mutation | Use new fields with defaults — frozen is preserved. Synthetic results created in fetcher, not mutated. |
| Eval-corpus breakage | M.6 has no breakage. M.7 scenarios with redirects would need `expect.fetch.skipped_duplicates` expectations. |
| Compact summary breakage | M.6 no breakage. M.7 skipped results excluded from snippets — correct behavior. |
| JSON consumer confusion | New `fetch_status` values are additive. Consumers using `fetch_status == "success"` continue to work. |
| Evidence path ambiguity | `evidence_path` on skipped results points to kept pack. Well-defined in data model. |
| Race condition in registry | Single-threaded, sequential fetch. No concurrency. No race. |
| Cache hit dedup mismatch | Cache metadata includes redirects. `final_url_override` computed from cache metadata. Same canonicalization. No mismatch. |

## 13. Non-goals

- HTML `<link rel="canonical">` extraction (documented in M.4 non-goals).
- Content-hash dedup (different content at same URL would be deduped — acceptable for MVP).
- Configurable dedup strategy (first-wins is sufficient).
- Dedup across different queries (scoped to single `search_query()` call).
- Dedup for blocked/failed fetches (already excluded).
- Dedup when `follow_redirects=False` (already excluded — `final_url=None`).
- Changing the evidence pack schema.
- Changing the JSON schema for evidence_result entries (new fields only on dataclass, not in JSON by default).

## 14. Files That Would Change

### M.6 (mark+reference)
- `search_tool/search.py` — Add `dedup_status`, `duplicate_of_url`, `duplicate_of_evidence_path` to `EvidenceWriteResult`. Populate in dedup loop.
- `tests/test_final_url_dedup.py` — Add M.6 dedup metadata tests.

### M.7 (skip extraction)
- `search_tool/run.py` — Add `seen_final_urls` parameter to `fetch_url_to_evidence()`. Add pre-extraction dedup check. Return synthetic result on match.
- `search_tool/search.py` — Build and pass dedup registry to fetcher. Change limitation wording to "Skipped". Handle `skipped_duplicate` in manifest writers.
- `search_tool/compact.py` — Handle `skipped_duplicate` in status counting (optional — already excluded by `status == "success"` check).
- `search_tool/cli.py` — Handle `skipped_duplicate` in fetch-list manifest output.
- `tests/test_final_url_dedup.py` — Add M.7 skip tests.
- `tests/test_eval_corpus.py` — Update scenarios with redirect pairs.

## 15. Decision Summary

| Aspect | M.6 (mark+reference) | M.7 (skip extraction) |
|--------|---------------------|----------------------|
| Risk | Low (additive) | Medium (pipeline change) |
| Refactor | Minimal | Moderate |
| Storage benefit | None | Yes (no duplicate packs) |
| Performance benefit | None | Yes (no duplicate extraction) |
| Backward compat | Full | Mostly (new fetch_status) |
| Dogfood ready | Yes | Yes |
| Recommended sequence | First | After M.6 dogfood |
