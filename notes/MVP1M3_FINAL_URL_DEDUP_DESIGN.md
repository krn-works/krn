# MVP-1M.3 — Fetch-aware final_url dedup design

**Date:** 2026-05-18
**Baseline:** d72fb155292fddf80474b5b511748246da8a2aca
**Scope:** Design only. No runtime implementation.

## 1. Architecture Findings

### 1.1 Fetch pipeline

Single-URL pipeline lives in `search_tool/run.py::fetch_url_to_evidence()`:
1. URL policy check → blocked early
2. Cache get (keyed on `normalize_url(url)`, optionally redirect-aware)
3. If cache hit: build FetchResult from cached metadata, extract, build/write evidence
4. If cache miss: `fetch_url(url, follow_redirects=follow_redirects)` → cache put → extract → build/write evidence
5. Returns `EvidenceWriteResult`

### 1.2 `FetchResult` has no `final_url` field

`FetchResult` (fetch.py:41) has:
- `redirects: list[dict]` — each dict has `status`, `location`, optionally `from_url`, `resolved_url`, `blocked_reason`
- No `final_url` field

### 1.3 `final_url` is computed in `run.py`, not stored on `FetchResult`

In `run.py` (lines 123-127):
```python
final_url_override = None
if follow_redirects and fetch_result.status == "success" and fetch_result.redirects:
    final_hop = fetch_result.redirects[-1]
    final_url_override = final_hop.get("resolved_url") or normalize_url(url)
```

This `final_url_override` is only used inside `build_evidence_pack()` to set `final_url` in the evidence pack Markdown. It is NOT returned on `EvidenceWriteResult`.

### 1.4 `EvidenceWriteResult` has no `final_url` field

`EvidenceWriteResult` (search.py:16) has:
- `original_url: str`
- `normalized_url: str`
- `evidence_path: Path`
- `fetch_status: str`
- `http_status: int | None`
- `cache_status: str`
- `extraction_status: str`
- `text_chars: int`
- `truncated: bool`
- `errors: tuple[str, ...]`
- `limitations: tuple[str, ...]`

### 1.5 `search_query()` accumulates evidence results sequentially

`search_query()` (search.py:307-310):
```python
evidence_results: list[EvidenceWriteResult] = []
for url in fetch_urls:
    result = fetcher(url, refresh, follow_redirects)
    evidence_results.append(result)
```

The loop is simple and sequential. This is where a dedup registry could be applied.

### 1.6 `search_query()` limitations come only from discovery

`search_query()` returns `limitations=discovery.limitations` (search.py:339). No fetch-level limitations are added to `SearchRunResult.limitations`.

### 1.7 `canonicalize_url_for_dedup()` exists and works on any URL string

`search_tool/canonical.py` provides `canonicalize_url_for_dedup(url) -> str` that normalizes URLs for dedup comparison. It is already imported and used in `build_discovery_result()`.

### 1.8 Cache keying uses `normalize_url`, not canonical key

Cache lookups in `cache.py` use `normalize_url(url)` as key. This is separate from canonical dedup and does not interfere.

## 2. Problem Statement

MVP-1M.2 candidate-level canonical dedup catches pre-fetch duplicates (tracking params, fragments, slash variants). But it cannot catch redirect-equivalent duplicates where two distinct candidate URLs fetch to the same final URL:

- `/latest/` → `/` (path redirect)
- `/docs/foo` → `/docs/foo/` (trailing slash redirect)
- `http://docs.example.com` → `https://docs.example.com` (scheme redirect)
- `https://docs.example.com/old-path` → `https://docs.example.com/new-path` (path redirect)
- Versioned docs redirects (`/v1/`, `/v2/`, `/latest/` all → same)

These produce separate evidence packs with identical or near-identical content.

## 3. Duplicate Classes

### A. Redirect-equivalent duplicates (primary target)
- Two distinct candidates with different URLs
- Both fetch successfully
- After following redirects, both reach the same `final_url`
- `final_url` canonical keys match
- Example: `https://fastapi.tiangolo.com/` → `https://fastapi.tiangolo.com` (trailing slash redirect)

### B. Redirect-to-existing-candidate
- Candidate A fetches and reaches `final_url_A`
- Candidate B redirects to `final_url_A`
- `canonicalize_url_for_dedup(final_url_A)` matches for both
- Candidate B is the duplicate

### C. Redirect chain equivalence
- A → B → C (3 hops)
- C is the final URL
- Dedup compares `canonicalize_url_for_dedup(C)` for all candidates

### D. Partial failure
- Candidate A fetches successfully (final_url known)
- Candidate B (which redirects to same final_url as A) fails to fetch
- Should NOT collapse B based on A's final_url (failure may be transient)
- Should NOT hide the error

### E. No-redirect equivalence
- Two candidates that never redirect (no 3xx response)
- Even if they'd resolve to the same URL, we can't know without following redirects
- No dedup in this case

### F. `follow_redirects=false`
- When user disables redirect following, `FetchResult.redirects` is populated but not followed
- `final_url_override` is None
- No final_url dedup possible (we don't know where redirects lead)

## 4. Hard Non-goals

- No HTML `<link rel="canonical">` tag extraction. (MVP-1M.4)
- No content-hash dedup (body SHA-256 comparison).
- No semantic/fuzzy dedup.
- No LLM-based dedup.
- No evidence pack file deletion or mutation.
- No change to evidence pack Markdown format.
- No change to cache keying logic.
- No crawling or additional network calls.
- No `--no-final-url-dedup` opt-out flag.

## 5. Options Comparison

### Option A — Skip duplicate evidence after fetch (staged skip)

Fetch candidate. If `final_url` canonical key already seen and fetch succeeded, skip extraction and evidence writing. Produce a skipped `EvidenceWriteResult` without an evidence path.

| Criterion | Score | Rationale |
|-----------|-------|-----------|
| Correctness | High | Only skips when we're sure (successful fetch + same final_url) |
| Risk | Medium | Requires new status on `EvidenceWriteResult` ("skipped_duplicate") |
| Size | Medium | Registry in `search_query()` or `run.py`, new field |
| Testability | High | Fully unit-testable, no network needed (mock FetchResult) |
| Performance | High | Saves extraction + evidence write work |
| JSON compatibility | Medium | New `fetch_status` value breaks consumers expecting only "success"/"failed"/"blocked" |
| User clarity | Medium | Skipped results in output need clear representation |

### Option B — Extract then dedup (post-hoc collapse)

Fetch/extract/write all evidence packs. Then collapse results by `final_url` canonical key. Remove duplicate evidence files. Report in limitations.

| Criterion | Score | Rationale |
|-----------|-------|-----------|
| Correctness | High | All work done, then collapse |
| Risk | High | Deleting evidence files is destructive |
| Size | Medium | Collapse logic + file deletion |
| Testability | Low | Requires filesystem fixtures, harder to test |
| Performance | Low | Wastes fetch + extract work for duplicates |
| JSON compatibility | High | Fewer results in output, same schema |
| User clarity | Low | Files mysteriously deleted |

### Option C — Mark duplicates only (visibility only)

Fetch/extract all evidence packs as-is. After the fetch loop, check `final_url` canonical keys. Mark duplicate evidence results in `limitations` and via a new optional field. No skipping, no deletion.

| Criterion | Score | Rationale |
|-----------|-------|-----------|
| Correctness | High | No behavioral change, pure reporting |
| Risk | Very Low | No file operations, no schema-breaking changes |
| Size | Small | Registry + limitations message |
| Testability | High | Pure logic, no I/O needed |
| Performance | Low | All work still done |
| JSON compatibility | High | Additive only, no breaking changes |
| User clarity | High | Users see all results with clear duplicate annotations |

### Option D — Staged: mark-only in M.4, add skip in M.5

M.4: Option C (mark-only limitations). M.5: Option A (skip duplicate extraction).

| Criterion | Score | Rationale |
|-----------|-------|-----------|
| Correctness | High | Incremental rollout |
| Risk | Very Low | M.4 has zero risk |
| Size | Small | M.4 is minimal |
| Testability | High | Each stage independently testable |
| Performance | Medium | M.4 same as B, M.5 same as A |
| JSON compatibility | High | M.4 additive, M.5 needs new status |
| User clarity | High | Clear progression |

### Option E — Defer runtime, design only

No implementation. Document the design and dogfood plan for future implementation.

| Criterion | Score | Rationale |
|-----------|-------|-----------|
| Correctness | N/A | No runtime changes |
| Risk | None | No code changes |
| Size | Zero | Design memo only |
| Testability | N/A | No code to test |
| Performance | N/A | No runtime changes |
| JSON compatibility | N/A | No changes |
| User clarity | N/A | No changes |

## 6. Recommendation: Option D (Staged) for MVP-1M.4

**MVP-1M.4: Mark-only final_url dedup (Option C as first stage).**

Why mark-only first:
- Zero risk to existing behavior. All evidence packs still created.
- No `EvidenceWriteResult` schema change needed.
- No `fetch_status` values to add or test for breaking.
- Limitations message is additive and follows the established pattern from MVP-1M.2.
- Dogfood can validate the dedup logic produces correct results.
- If issues emerge, revert is a one-line revert of the limitations addition.
- MVP-1M.5 can then add the skip behavior with a new `fetch_status` value.

**How it works in MVP-1M.4:**

1. After `search_query()` fetch loop, collect all successful `EvidenceWriteResult` entries.
2. For each, compute `final_url` from the evidence pack frontmatter or from the fetch result's redirect chain.
3. Canonicalize `final_url` with `canonicalize_url_for_dedup()`.
4. First occurrence wins. Subsequent duplicates marked.
5. Report collapsed count in `SearchRunResult.limitations`:
   `"Skipped N duplicate fetched URLs by final_url canonical dedup."`
   (Note: "Skipped" here means "identified as duplicate", not "excluded from output". MVP-1M.4 does not skip.)
6. No change to `EvidenceWriteResult` fields.
7. No evidence file deletion.

**Limitation:** MVP-1M.4 does NOT have access to `final_url` on `EvidenceWriteResult`. The final_url is only available inside the evidence pack Markdown. Two approaches to get it:
- Parse frontmatter from written evidence pack (expensive, fragile)
- Add `final_url` to `EvidenceWriteResult` (cleaner, small schema addition)

**Decision: Add `final_url: str | None` to `EvidenceWriteResult`.**
This is the smallest practical change. It does not break existing consumers because:
- It's an optional field (defaults to `None`)
- It's additive, never changes existing field semantics
- Existing JSON consumers see a new optional field and ignore it

## 7. MVP-1M.4 Implementation Plan

### 7.1 File changes

**Modified: `search_tool/search.py`**
- Add `final_url: str | None = None` to `EvidenceWriteResult` dataclass.

**Modified: `search_tool/run.py`**
- `fetch_url_to_evidence()`: Set `final_url_override` value on returned `EvidenceWriteResult`.
- The `final_url_override` is already computed in lines 123-127 and 86-89. Just pass it through.

**Modified: `search_tool/search.py`**
- In `search_query()`: After fetch loop, build `seen_final_urls` registry.
- For each `evidence_results[i]`, if `final_url` is set, compute `canonicalize_url_for_dedup(final_url)`.
- Track first occurrence index. Mark duplicates.
- If duplicates found, append to `SearchRunResult.limitations`.

**New test file or tests in existing test modules.**

### 7.2 Data model

```python
@dataclass(frozen=True)
class EvidenceWriteResult:
    original_url: str
    normalized_url: str
    evidence_path: Path
    fetch_status: str
    http_status: int | None
    cache_status: str
    extraction_status: str
    text_chars: int
    truncated: bool
    errors: tuple[str, ...]
    limitations: tuple[str, ...]
    final_url: str | None = None  # NEW: final URL after redirect following
```

### 7.3 Registry pattern

```python
# In search_query(), after fetch loop:
seen_final_urls: dict[str, int] = {}
duplicate_count = 0

for i, er in enumerate(evidence_results):
    if er.fetch_status != "success":
        continue
    if er.final_url is None:
        continue
    key = canonicalize_url_for_dedup(er.final_url)
    if key not in seen_final_urls:
        seen_final_urls[key] = i
    else:
        duplicate_count += 1

limitations = list(result.discovery.limitations)
if duplicate_count > 0:
    limitations.append(
        f"Collapsed {duplicate_count} duplicate fetched URLs by final_url canonical dedup."
    )
limitations.extend(result.limitations)
```

### 7.4 M.4 behavior

- All evidence packs still written (no skipping).
- Duplicate count reported in limitations.
- `EvidenceWriteResult.final_url` exposed for consumers who want to use it.
- No change to JSON schema (additive optional field).

## 8. MVP-1M.5 (Future) — Skip duplicate extraction

When MVP-1M.4 is validated via dogfood, MVP-1M.5 adds the skip behavior:

- Add `fetch_status = "skipped_duplicate"` to `EvidenceWriteResult`.
- Skip extraction and evidence writing for duplicates.
- Add test for `fetch_status` acceptance across compact/manifest/JSON.
- This is where performance gain materializes.

## 9. JSON / Backward Compatibility

### `EvidenceWriteResult.final_url` addition

- **New optional field** on `EvidenceWriteResult` dataclass.
- Defaults to `None` (no redirect following, no redirects, failed fetches).
- Set only when `follow_redirects=True` and `fetch_result.redirects` is non-empty.
- JSON serialization: new field appears as `"final_url": "https://..."` or `"final_url": null`.
- Existing consumers ignore optional fields. No breaking change.

### Limitations message

- Follows the same pattern as MVP-1M.2: additive string in `limitations` tuple.
- Only appears when `duplicate_count > 0`.
- Deduped/capped: one message per `search_query()` call.

### `SearchRunResult` schema

- `limitatons` tuple gains optional string.
- `evidence_results` tuple unchanged (no skipping in M.4).
- No change to `discovery` field.

### Manifest

- `fetch_requested` count unchanged in M.4 (all fetched).
- M.5 (skip): `fetch_requested` would equal number of fetches, `fetch_evidence_packs` would be fewer.

## 10. Security Model

### 10.1 final_url is untrusted metadata

The `final_url` comes from HTTP redirect `Location` headers, resolved via `urljoin()`, and stored in `fetch_result.redirects[-1]["resolved_url"]`. This is the same data already written to evidence pack frontmatter.

### 10.2 Per-hop policy check already protects redirect following

`_fetch_with_redirects()` (fetch.py:147) does per-hop `check_url(current_url)` before each fetch hop. A redirect to a blocked URL (private IP, file://, etc.) is caught and returns `status="blocked"`.

### 10.3 Dedup never trusts blocked final_url

```python
# In registry:
if er.fetch_status != "success":  # blocks: failed, blocked, skipped
    continue
```

Only successful fetches contribute their `final_url` to the dedup registry. Blocked or failed fetches are excluded.

### 10.4 Dedup cannot make blocked URLs acceptable

A candidate that was blocked by URL policy at discovery time never reaches the fetch stage. Its URL never appears in `evidence_results`. The dedup registry only sees successful fetch results. No interaction with blocked candidates.

### 10.5 `follow_redirects` gate

`final_url` is only set when `follow_redirects=True`. If disabled:
- `fetch_url_to_evidence()` does not follow redirects
- `final_url_override` stays `None`
- `EvidenceWriteResult.final_url` is `None`
- Dedup registry sees no `final_url` entries
- No final_url dedup occurs

### 10.6 No SSRF bypass via redirect final_url

The `check_url()` per-hop gate in `_fetch_with_redirects()` runs BEFORE each fetch hop. The redirect target URL must pass policy before being fetched. The dedup uses the same `final_url` that was already policy-checked during fetch.

## 11. Test Plan

### Unit tests (canonical.py reuse)

| # | Test | What |
|---|------|------|
| 1 | `test_final_url_dedup_redirect_to_same_url` | Two candidates redirect to same final_url → duplicate_count=1 |
| 2 | `test_final_url_no_redirect_no_dedup` | Two candidates with no redirects → no dedup |
| 3 | `test_final_url_different_urls_no_dedup` | Two candidates with different final_urls → no dedup |
| 4 | `test_final_url_tracking_param_collapsed` | Final URLs differ only by tracking params → deduped |
| 5 | `test_final_url_trailing_slash_collapsed` | Final URLs differ by trailing slash → deduped |
| 6 | `test_final_url_failed_fetch_not_collapsed` | One succeeds, one fails → no dedup based on failed |
| 7 | `test_final_url_blocked_not_collapsed` | One succeeds, one blocked → no dedup |
| 8 | `test_follow_redirects_false_no_dedup` | `follow_redirects=False` → `final_url=None` → no dedup |
| 9 | `test_limitation_message_present` | Duplicates found → limitations contains final_url dedup message |
| 10 | `test_limitation_message_absent` | No duplicates → no final_url dedup message |
| 11 | `test_final_url_field_set_on_success` | `EvidenceWriteResult.final_url` is set when redirects followed |
| 12 | `test_final_url_field_none_when_no_redirects` | `final_url=None` when no redirects on successful fetch |
| 13 | `test_final_url_field_none_when_follow_redirects_false` | `final_url=None` when `follow_redirects=False` |

### Integration tests (search_query level)

| # | Test | What |
|---|------|------|
| 1 | `test_search_query_final_url_dedup_static` | Static provider with mocked redirect responses → dedup works |
| 2 | `test_search_json_valid_with_final_url_field` | JSON output valid with new `final_url` field |
| 3 | `test_manifest_unchanged_by_final_url_dedup` | Manifest counts unchanged in M.4 (all fetched) |
| 4 | `test_compact_unaffected_by_final_url_dedup` | Compact summary correct (all evidence still present in M.4) |

### Eval-corpus

- Update scenarios that involve redirects (if any).
- If no existing redirect scenarios, add one with static mocked redirect.
- Check: no regressions in existing 11 scenarios.

## 12. Dogfood Plan

### Mocked redirect cases (no network)
- Create static provider with candidate pairs that would redirect to the same URL:
  - `https://example.com/latest/` → `https://example.com/` (trailing slash redirect)
  - `https://example.com/docs/foo` → `https://example.com/docs/foo/` (trailing slash redirect)
  - `https://EXAMPLE.COM/path` → `https://example.com/path` (case redirect, already deduped by canonical)
- Run eval with static provider mocking redirect responses
- Verify: duplicate_count reported in limitations

### Real-world URLs (safe, no WebSearch needed)
- Known redirect pairs from user-supplied URLs:
  - `http://` → `https://` for a known docs site
  - Trailing slash redirect for a known docs site
- Test via static provider with canned redirect responses from test fixtures
- Or test via live fetch if a safe redirect pair is known

### No requirements
- No SearXNG dependency
- No WebSearch
- No SearXNG
- No external network calls beyond controlled test URLs

## 13. Proposed MVP-1M.5 Scope (Future)

After MVP-1M.4 is dogfood-validated:

- Add `fetch_status = "skipped_duplicate"` to `EvidenceWriteResult`.
- In `search_query()`: after dedup detection, for duplicate results:
  - Call a `skip_evidence()` function (or no-op fetch)
  - Return `EvidenceWriteResult` with `fetch_status="skipped_duplicate"`
  - Set `evidence_path=None`
  - Set `final_url` to the canonical final_url
- Update `_quality_score()` to handle `"skipped_duplicate"` → score 0.
- Update compact/manifest to handle skipped status.
- Update JSON output for skipped status.

This is where the actual performance gain materializes (no extraction, no evidence write for duplicates).

## 14. Summary

| Item | Detail |
|------|--------|
| MVP-1M.4 scope | Add `final_url` to `EvidenceWriteResult`, dedup in `search_query()`, mark via limitations |
| MVP-1M.5 scope | Skip duplicate extraction/evidence writing, new `fetch_status` value |
| New fields | `EvidenceWriteResult.final_url: str | None` |
| Schema changes | Additive only in M.4. M.5 needs new `fetch_status` value. |
| Risk | M.4: Very Low. M.5: Medium (new status value needs consumer updates). |
| Performance | M.4: None (all work done). M.5: Saves extraction + write for duplicates. |
| Security | final_url from policy-checked redirects only. Blocked/failed excluded. |
| Non-goals | No HTML canonical, no content-hash, no file deletion, no LLM dedup. |

## 15. Next Task

**MVP-1M.4** — Implement final_url dedup as designed above (mark-only stage).
