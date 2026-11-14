# MVP-1M.1 — Canonical/Dedup Refinement Design

**Date:** 2026-05-18
**Baseline:** a54152925fb1b7c3a62323e5ddd1caf4f2df1ad0
**Scope:** Design only. No runtime implementation.

## 1. Current Architecture Findings

### 1.1 `normalize_url` (url_policy.py:138)
- Lowercases scheme and hostname
- Removes default ports (80/http, 443/https)
- Normalizes empty path to `/`
- Strips trailing slash (except root `/`)
- Preserves query string verbatim (no filtering, no sorting)
- Drops fragment
- Does NOT collapse duplicate slashes
- Does NOT remove tracking query params
- Does NOT handle percent-encoding normalization

### 1.2 Candidate dedup locations
Two dedup stages exist today:

**(a) `parse_llms_txt()` — discovery_llms.py:146-235**
`seen_normalized: dict[str, int]` tracks normalized URLs per `_ParsedEntry`. First occurrence wins. This prevents duplicate entries from a single llms.txt file. Does not track candidates from other providers.

**(b) `build_discovery_result()` — discovery.py:128-174**
`seen_normalized: dict[str, int]` tracks normalized URLs across all `RawDiscoveryCandidate` inputs. First occurrence wins. Marks duplicates with `duplicate_of: str | None`. The `duplicate_of` field stores the normalized URL of the kept candidate.

### 1.3 Fragment handling
`normalize_url` drops fragments. But the raw `RawDiscoveryCandidate.url` field preserves the original URL including fragment. Dedup key is normalized (no fragment), so `https://example.com/page#section` and `https://example.com/page` dedup correctly.

### 1.4 Query param handling
Fully preserved. No filtering of tracking params (utm_*, fbclid, gclid, etc.). No sorting. `https://example.com/page?utm_source=foo` and `https://example.com/page?utm_source=bar` are treated as different URLs.

### 1.5 Redirect/final_url
`FetchResult.redirects` stores redirect hops. `final_url` is only available in:
- Evidence pack frontmatter/body (via `final_url_override` when `--follow-redirects` is used)
- Search manifest (from `EvidenceWriteResult`)
- NOT available at discovery time
- NOT available on `DiscoveryCandidate`

### 1.6 Canonical HTML tags
Not extracted. `extract.py` parses `<title>` but not `<link rel="canonical">`. No HTML canonical metadata is available.

### 1.7 Evidence pack keying
`_url_to_filename()` uses SHA-256 of normalized URL + hostname prefix. Two URLs that normalize differently (e.g., different query params) produce different evidence files. No content-hash-based dedup.

### 1.8 Dedup insertion points without breaking contracts
- **Discovery layer** (before `build_discovery_result`): Safest. Dedup `RawDiscoveryCandidate` by a stricter canonical key. Existing `duplicate_of` field already exists.
- **search.py layer** (before fetch loop): Can dedup `urls_for_fetch()` results by canonical key. No contract change.
- **Evidence layer**: Risky. Would require renaming/deleting evidence files.
- **Compact/manifest**: Can report duplicate counts from existing `duplicate_of` field.

## 2. Problem Statement

As candidate volumes grow (more llms.txt URLs, SearXNG results, static candidates), quality depends on canonicalization and dedup:

- Duplicate candidates inflate fetch count and evidence directory
- Tracking params create apparent duplicates from the same resource
- Fragment variants create apparent duplicates
- Redirect-equivalent URLs produce duplicates after fetch when redirects are followed
- llms.txt files often list the same URL under multiple sections or as both relative and absolute
- No post-fetch dedup means the same content can appear as multiple evidence packs

Current dedup exists but uses `normalize_url` which is too permissive (preserves query params including tracking params).

## 3. Duplicate Classes

### A. String-equivalent duplicates
- Scheme/host casing: `HTTPS://Example.COM/...` vs `https://example.com/...` — already handled by `normalize_url`
- Default ports: `https://example.com:443/` vs `https://example.com/` — already handled
- Trailing slash: `/docs/` vs `/docs` — already handled
- Duplicate slashes: `https://example.com//path` — NOT handled
- Percent encoding: `https://example.com/path%20with%20spaces` — NOT handled (stdlib `urlparse` does not normalize)
- Fragments: `#section` variants — already handled by `normalize_url` dropping them

### B. Query-param duplicates
- `utm_source`, `utm_medium`, `utm_campaign`, `utm_term`, `utm_content`, `utm_id` — NOT handled
- `fbclid`, `gclid`, `msclkid` — NOT handled
- `mc_cid`, `mc_eid`, `igshid` — NOT handled
- `ref`, `source`, `via` — meaningful in some contexts, NOT handled (deferring)

### C. Redirect-equivalent duplicates
- `/latest/` -> `/` path redirects — NOT handled at discovery time
- HTTP -> HTTPS — NOT handled (different scheme = different normalized URL)
- Final URL duplicate after fetch — NOT handled

### D. Canonical HTML duplicates
- `<link rel="canonical" href="...">` — NOT extracted
- OpenGraph canonical-ish — NOT extracted

### E. Content duplicates
- Same title + same body SHA-256 from different URLs — NOT detected
- Same compact summary — NOT detected

### F. llms-specific duplicates
- Same URL under multiple sections in llms.txt — deduped within `parse_llms_txt()` by normalized URL
- `*` vs `-` bullet variants of same link — both parse to same entry, deduped
- Relative vs absolute same URL — deduped by normalized URL
- llms section index and target docs duplicated — NOT handled across sections

## 4. Non-Goals

- No web-scale crawling
- No fuzzy semantic dedup (no embedding, no similarity)
- No LLM-based dedup
- No database/vector index
- No breaking evidence pack format in MVP
- No hidden network calls beyond existing fetch
- No trust bypass based on canonical tags
- No deletion of existing evidence artifacts
- No `--no-canonical-dedup` opt-out in MVP (recommend always-on)

## 5. Options Comparison

### Option A — Normalize early only
Improve `normalize_url` and candidate dedup before `build_discovery_result`. Strip tracking params, fragments, normalize path. Dedup `RawDiscoveryCandidate` by stricter canonical key. No HTML parsing.

| Criterion | Score | Rationale |
|-----------|-------|-----------|
| Correctness | High | Pure string manipulation, deterministic |
| Risk | Low | No fetch changes, no contract changes |
| Size | Small | One new module (~200 lines) |
| Testability | High | Fully unit-testable, no network |
| llms usefulness | High | Solves relative/absolute, tracking params |
| SearXNG usefulness | Medium | SearXNG URLs often have tracking params |
| JSON compatibility | High | Fewer candidates, `duplicate_of` already exposed |

### Option B — Fetch-aware canonicalization
Keep early normalization but also dedup after fetch using `final_url` and canonical metadata. Requires extracting `<link rel="canonical">` from HTML and storing `final_url` on `DiscoveryCandidate` or `EvidenceWriteResult`.

| Criterion | Score | Rationale |
|-----------|-------|-----------|
| Correctness | Medium | Canonical tag is a hint, not guarantee |
| Risk | Medium | Requires HTML parsing changes, contract changes |
| Size | Medium | HTML parsing, new fields, dedup logic |
| Testability | Medium | Requires HTML fixtures, network or mock |
| llms usefulness | Medium | llms candidates already deduped at parse time |
| SearXNG usefulness | High | SearXNG often returns redirect-equivalent URLs |
| JSON compatibility | Medium | New fields needed for final_url, canonical_url |

### Option C — Evidence-level dedup
Fetch everything, then dedup evidence outputs by content hash (body SHA-256) + title match. Collapse duplicate evidence packs.

| Criterion | Score | Rationale |
|-----------|-------|-----------|
| Correctness | Medium | Same content != same source (mirror sites) |
| Risk | High | Would require evidence file deletion/renaming |
| Size | Large | Content hashing, evidence management |
| Testability | Low | Requires real content or large fixtures |
| llms usefulness | Low | Overkill for MVP |
| SearXNG usefulness | Medium | Some value for mirror sites |
| JSON compatibility | Low | Would change evidence count, require schema change |

### Option D — Hybrid staged canonical graph
Small `CanonicalKey` object used in discovery and search. Avoids full graph database. Combines A + B incrementally.

| Criterion | Score | Rationale |
|-----------|-------|-----------|
| Correctness | High | Same as A for MVP-1M.2, defers B |
| Risk | Low | Same as A |
| Size | Small | Same as A for first stage |
| Testability | High | Same as A |
| llms usefulness | High | Same as A |
| SearXNG usefulness | Medium | Same as A |
| JSON compatibility | High | Same as A |

### Option E — Reporting only
Report duplicates via `duplicate_of` and limitations but do not collapse candidates. No dedup, just visibility.

| Criterion | Score | Rationale |
|-----------|-------|-----------|
| Correctness | High | No changes to data flow |
| Risk | Very Low | Read-only reporting |
| Size | Tiny | Add counters, update limitations |
| Testability | High | Trivial |
| llms usefulness | Low | Users see duplicates but still fetch them all |
| SearXNG usefulness | Low | Same |
| JSON compatibility | High | No change |

### Recommendation: Option A (Normalize early only) as MVP-1M.2

Option A delivers the highest quality improvement with the lowest risk. It solves classes A (most), B, and F duplicates that are the most common and easiest to fix. Option D is the implementation vehicle — staged, incremental, with B and C as future stages.

Option E is a valid fallback if risk is deemed too high, but Option A has essentially zero risk (no fetch changes, no contract changes) and delivers meaningful quality improvement.

## 6. Recommended Staged Plan

### MVP-1M.2 — Candidate-level canonical dedup (this design)

**New file:** `search_tool/canonical.py`

**Function:** `canonicalize_url_for_dedup(url: str) -> CanonicalKey`

Returns a `CanonicalKey` dataclass with:
```python
@dataclass(frozen=True)
class CanonicalKey:
    url: str                    # original URL
    canonical_key: str          # normalized string for dedup comparison
    canonical_url: str          # the canonical form of the URL
    reason_codes: tuple[str, ...]  # what was stripped/changed
```

**Canonical rules for MVP-1M.2:**
1. Only http/https — reject or pass through others unchanged
2. Lowercase scheme and host
3. Remove default ports (80/http, 443/https)
4. Normalize path:
   - Empty path -> `/`
   - Preserve case in path
   - Collapse duplicate slashes (`//` -> `/`) — stdlib safe
   - Strip trailing slash except root `/`
5. Strip fragments always (not sent over HTTP)
6. Query params:
   - Remove known tracking params:
     `utm_source`, `utm_medium`, `utm_campaign`, `utm_term`, `utm_content`,
     `utm_id`, `utm_cid`, `fbclid`, `gclid`, `msclkid`, `mc_cid`, `mc_eid`, `igshid`
   - DO NOT remove `ref`, `source`, `via` (meaningful in docs contexts)
   - Sort retained query params by key (deterministic)
   - Preserve repeated param names (sort within same name)
7. IDNA/punycode: defer (stdlib `urlparse` handles some)
8. Percent encoding: defer (minimal change)
9. Userinfo: already blocked by url_policy

**Integration point:** Before `build_discovery_result()`, in `LlmsTxtProvider.discover()` and `StaticDiscoveryProvider.discover()`. Dedup `RawDiscoveryCandidate` list by `canonical_key` (first occurrence wins). Preserve original URL, title, snippet from first occurrence.

**Limitations update:** When duplicates are collapsed, add to `limitations`:
`"N candidate(s) collapsed as canonical duplicates of earlier candidates."`

**No contract changes:** `duplicate_of` field already exists on `DiscoveryCandidate`. The `duplicate_count` is already tracked in search manifest. No new JSON fields needed.

### MVP-1M.3 — Fetch-aware redirect/final_url dedup

After `search_query()` fetches evidence, check if `EvidenceWriteResult.final_url` canonical key matches an earlier evidence result. If so, mark as duplicate.

- Add `final_url` to `EvidenceWriteResult`
- Dedup evidence results by `canonical_key(final_url)`
- Report collapsed count in limitations
- No evidence file deletion; mark duplicate evidence with `duplicate_of_final_url`

### MVP-1M.4 — HTML canonical tag extraction

Add `<link rel="canonical">` extraction to `extract.py`. Store on `ExtractionResult`. Use as additional signal (not authoritative) in MVP-1M.3 dedup.

- New field on `ExtractionResult`: `canonical_url: str | None`
- Do NOT trust canonical tags for URL rewriting (security: untrusted source)
- Use only as dedup hint alongside `final_url`

### MVP-1M.5 — Dogfood

Test across llms + static + SearXNG (if available) + real docs. Verify:
- Fewer evidence packs for known-duplicate queries
- Correct first-candidate preservation
- Limitations messages accurate
- No regressions in eval-corpus

## 7. Proposed Data Model

### CanonicalKey
```python
@dataclass(frozen=True)
class CanonicalKey:
    url: str                    # original URL (never modified)
    canonical_key: str          # hashable dedup key (normalized URL string)
    canonical_url: str          # the canonical form (for display)
    reason_codes: tuple[str, ...]  # e.g., ("fragment_stripped", "tracking_param_removed", "port_normalized")
```

### DuplicateUrlRecord (for reporting)
```python
@dataclass(frozen=True)
class DuplicateUrlRecord:
    duplicate_url: str
    kept_url: str
    canonical_key: str
    stage: str  # "discovery" | "fetch" | "evidence"
    reason: str  # human-readable, e.g., "tracking param difference"
```

These are internal to `canonical.py` and `search.py`. Not exposed in JSON for MVP-1M.2. Reporting is via limitations count.

## 8. JSON / Backward Compatibility

### MVP-1M.2 changes to existing output
- **Fewer candidates:** Some `RawDiscoveryCandidate` entries are deduped before `build_discovery_result()`. The `candidates` tuple is shorter.
- **`duplicate_of` field:** Already exists on `DiscoveryCandidate`. No new fields.
- **`limitations` tuple:** May gain one additional string: `"N candidate(s) collapsed as canonical duplicates."`
- **`urls_for_fetch()`:** Returns fewer URLs (deduped at source).
- **Evidence packs:** Fewer files (one per unique canonical URL).
- **Search manifest:** `discovery_duplicates` count reflects new dedup.

### Backward compatibility
- Existing JSON consumers see fewer candidates but same schema — backward compatible.
- Candidate ordering preserved (first occurrence wins, stable sort).
- Evidence filenames unchanged (still hash-based on normalized URL).
- Cache keys unchanged (still `normalize_url`).
- No breaking changes to any existing field.

### Opt-out
Defer `--no-canonical-dedup` flag. If risk materializes, add later. Recommendation: always-on for safe canonical keys.

## 9. Test Plan (exact tests for MVP-1M.2)

### canonical.py unit tests (12+)

| # | Test | What |
|---|------|------|
| 1 | `test_lower_scheme_host` | `HTTPS://EXAMPLE.COM/a` -> canonical `https://example.com/a` |
| 2 | `test_default_port_removed` | `https://example.com:443/` -> canonical `https://example.com/` |
| 3 | `test_non_default_port_preserved` | `https://example.com:8443/` -> canonical `https://example.com:8443/` |
| 4 | `test_fragment_stripped` | `https://example.com/page#section` -> key drops fragment |
| 5 | `test_empty_path_normalized` | `https://example.com` -> canonical `https://example.com/` |
| 6 | `test_tracking_params_removed` | `?utm_source=foo&utm_campaign=bar` -> params removed |
| 7 | `test_retained_params_sorted` | `?z=1&a=2` -> canonical `?a=2&z=1` |
| 8 | `test_repeated_params_behavior` | `?a=1&a=2` -> preserved, sorted |
| 9 | `test_path_case_preserved` | `/Docs/Guide` -> canonical `/Docs/Guide` |
| 10 | `test_duplicate_slashes_collapsed` | `/a//b///c` -> canonical `/a/b/c` |
| 11 | `test_trailing_slash_stripped` | `/docs/` -> canonical `/docs` |
| 12 | `test_non_http_unchanged` | `file:///etc/passwd` -> passed through unchanged (policy blocks separately) |
| 13 | `test_reason_codes` | Non-trivial canonicalization includes reason codes |

### discovery dedup tests (10+)

| # | Test | What |
|---|------|------|
| 1 | `test_static_duplicate_candidates_collapse` | Two identical normalized URLs -> 1 selected |
| 2 | `test_llms_relative_absolute_dedup` | Relative `/docs` and absolute `https://.../docs` dedup |
| 3 | `test_dedup_fragment` | URL with fragment dedups to base URL |
| 4 | `test_dedup_utm_param` | URL with utm params dedups to clean URL |
| 5 | `test_max_candidates_after_dedup` | 12 candidates, 2 duplicates -> max 10 after dedup (not 12 then 2 dup) |
| 6 | `test_first_candidate_preserved` | Title and snippet from first occurrence kept |
| 7 | `test_duplicates_in_limitations` | Limitations mentions collapsed count |
| 8 | `test_no_false_dedup_different_params` | `?a=1` and `?a=2` are NOT deduped (meaningful params) |
| 9 | `test_dedup_across_raw_stages` | llms parser dedup + pre-discovery dedup don't conflict |
| 10 | `test_source_quality_unaffected` | Classification still works on deduped candidates |

### search/evidence tests (5+)

| # | Test | What |
|---|------|------|
| 1 | `test_no_double_fetch_dedup` | Canonical duplicate candidates don't fetch twice |
| 2 | `test_search_json_valid_after_dedup` | JSON output valid with dedup |
| 3 | `test_eval_corpus_unchanged` | eval-corpus still 11/11 with dedup |
| 4 | `test_manifest_duplicate_count` | Search manifest reports correct duplicate count |
| 5 | `test_compact_summary_after_dedup` | Compact summary correct with fewer sources |

## 10. Risks

| Risk | Severity | Mitigation |
|------|----------|------------|
| Tracking param removal deletes meaningful params | Medium | Conservative list only; defer `ref`/`source`/`via`; thorough dogfood |
| Query param sorting changes cache behavior | Low | Cache keys use existing `normalize_url`, not canonical key |
| Fewer candidates than before surprises consumers | Low | Documented in limitations; schema unchanged |
| Dedup removes first-seen candidate that user wanted | Low | First-seen is deterministic (source order); acceptable for MVP |
| `normalize_url` and `canonicalize_url_for_dedup` diverge | Medium | Use `canonicalize_url_for_dedup` as the canonical key everywhere eventually; keep `normalize_url` for cache |
| Duplicate slashes normalization interacts badly with path | Low | `//` -> `/` collapse is stdlib-safe; test edge cases |

## 11. Implementation Notes for MVP-1M.2

### File changes
- **New:** `search_tool/canonical.py` — `CanonicalKey`, `canonicalize_url_for_dedup()`
- **Modified:** `search_tool/discovery_llms.py` — integrate canonical dedup in `discover()` before `build_discovery_result()`
- **Modified:** `search_tool/discovery.py` — integrate canonical dedup in `StaticDiscoveryProvider.discover()` (same pattern)
- **Modified:** `tests/test_canonical.py` — new test file (20+ tests)
- **Modified:** `tests/test_llms_provider.py` — add dedup integration tests
- **Modified:** `tests/test_search*.py` — add search/evidence dedup tests

### Integration pattern (discovery_llms.py)
```python
from search_tool.canonical import canonicalize_url_for_dedup

# In discover(), after _convert_entries_to_raw():
raw_candidates = _convert_entries_to_raw(entries, query)

# Canonical dedup before build_discovery_result
seen: dict[str, int] = {}
deduped: list[RawDiscoveryCandidate] = []
for rc in raw_candidates:
    key = canonicalize_url_for_dedup(rc.url).canonical_key
    if key not in seen:
        seen[key] = len(deduped)
        deduped.append(rc)
collapsed_count = len(raw_candidates) - len(deduped)

result = build_discovery_result(query, self.name, deduped, max_candidates=max_candidates)

if collapsed_count > 0:
    limit = f"{collapsed_count} candidate(s) collapsed as canonical duplicates."
    if limit not in result.limitations:
        result = dc_replace(result, limitations=result.limitations + (limit,))
```

### Why not merge with existing `normalize_url`?
`normalize_url` is used for cache keying. Changing it risks cache invalidation for everyone. `canonicalize_url_for_dedup` is a stricter function with a different purpose. They can diverge and be reconciled later.

### Why not dedup inside `parse_llms_txt`?
Already deduped there by normalized URL. The new dedup is a second pass AFTER parsing, covering ALL raw candidates from ALL providers. It catches cross-provider duplicates and tracking param duplicates that the parser-level dedup doesn't catch.

## 12. Next Task

**MVP-1M.2:** Implement candidate-level canonical dedup as designed above.
