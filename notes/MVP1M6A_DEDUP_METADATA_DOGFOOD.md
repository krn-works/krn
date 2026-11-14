# MVP-1M.6a — final_url duplicate metadata dogfood

**Date:** 2026-05-19
**Baseline:** 6324cf2f2feebf10f3df8d413df29b69182bb1b5
**Type:** Docs-only dogfood (no source changes)

## Baseline gate

| Check | Result |
|-------|--------|
| HEAD == origin/main | 6324cf2 (clean) |
| Working tree | Clean |
| Full test suite | 876/876 pass |
| eval-corpus | 11/11 pass |
| py_compile | OK |
| Whitespace | No errors |

## Controlled dogfood scenarios

### A. Two results, same final_url

**Setup:** Two candidates, both resolve to `https://example.com` (one via `?utm_source=foo` tracking param).

| Field | Result 0 (kept) | Result 1 (duplicate) |
|-------|-----------------|----------------------|
| dedup_status | `unique` | `duplicate_final_url` |
| duplicate_of_url | `None` | `https://example.com` |
| duplicate_of_evidence_path | `None` | `/evidence/https://example.com/.md` |
| fetch_status | `success` | `success` (unchanged) |
| result count | 2 | 2 (unchanged) |

**Verdict:** PASS — first wins, second marked, count unchanged, fetch_status preserved.

### B. Three results, same final_url

**Setup:** Three candidates all canonicalizing to `https://example.com`.

| Field | Result 0 | Result 1 | Result 2 |
|-------|----------|----------|----------|
| dedup_status | `unique` | `duplicate_final_url` | `duplicate_final_url` |
| duplicate_of_url | `None` | `https://example.com` | `https://example.com` |
| duplicate_of_evidence_path | `None` | first path | first path |
| limitation | — | — | `Detected 2 duplicate fetched URLs by final_url canonical dedup.` |

**Verdict:** PASS — both duplicates reference the first (kept) result.

### C. Tracking-param final_url

**Setup:** `https://example.com/docs` vs `https://example.com/docs?utm_source=x`.

| Field | Result 0 | Result 1 |
|-------|----------|----------|
| dedup_status | `unique` | `duplicate_final_url` |
| duplicate_of_url | `None` | `https://example.com/docs` |

**Verdict:** PASS — tracking param removal in canonicalization correctly identifies the duplicate.

### D. Failed/blocked excluded

**Setup:** Mix of success, failed, and blocked results with shared final_url.

| Scenario | dedup_status | duplicate_of_url |
|----------|-------------|-----------------|
| Failed fetch | `unique` | `None` |
| Blocked URL | `unique` | `None` |

**Verdict:** PASS — `fetch_status != "success"` guard excludes them from dedup entirely. No false collapses.

### E. No-final-url

**Setup:** Results with `final_url=None` (no redirect, blocked, or failed).

| Field | Value |
|-------|-------|
| All dedup_status | `unique` |
| All duplicate_of_url | `None` |

**Verdict:** PASS — `final_url is None` guard excludes them from dedup.

### F. JSON surface

**Check:** CLI JSON output is valid. New metadata fields are present on EvidenceWriteResult but not intentionally exposed in CLI JSON by default. Schema backward compatible (new fields have defaults).

**Verdict:** PASS — frozen dataclass with defaults, no positional arg breakage. Tuple serialization works.

## Metadata behavior summary

- **Mark-only:** Duplicates keep all original data (fetch_status, text_chars, evidence file). Only `dedup_status`, `duplicate_of_url`, `duplicate_of_evidence_path` change.
- **First wins:** `seen_final_urls[canonical_key] = i` stores index of first occurrence.
- **Canonical form:** `canonicalize_url_for_dedup()` — tracking param removal, trailing slash collapse, fragment strip, query sorting, host lowercasing.
- **Limitation message:** `Detected N duplicate fetched URLs by final_url canonical dedup.`
- **Exclusion:** `fetch_status != "success"` and `final_url is None` both short-circuit dedup.

## JSON/backward compatibility

- EvidenceWriteResult is a frozen dataclass with default values on all new fields.
- Positional argument construction still works (verified in `test_dedup_fields_backward_compat`).
- Tuple serialization (used by SearchRunResult) works without modification.
- No schema break in broader JSON output — fields are new, not renamed.

## Acceptance verdict

**ACCEPT_DEDUP_METADATA**

- Duplicates are marked correctly with `dedup_status="duplicate_final_url"`.
- First result remains `dedup_status="unique"`.
- `duplicate_of_url` and `duplicate_of_evidence_path` point to kept result.
- All result counts and statuses unchanged (mark-only).
- Limitations message uses "Detected" (not "Skipped").
- Failed/blocked/no-final-url results stay unique.
- JSON remains backward compatible.
- No repo pollution.

## Fixes made

None. No bugs found.

## Next recommended task

MVP-1M.7 — skip extraction design/implementation. When dedup detects a duplicate, skip the evidence extraction stage entirely (no text processing, no .md write for duplicates). Still produce minimal EvidenceWriteResult for consistency. This is the remaining half of the skip/extract dedup design from MVP-1M.5.
