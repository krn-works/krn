# MVP-1E.8 Search Run Manifest Design

## Baseline

`b7be6ec5c11f288a17c604ffdfa59f064049f501` — docs: evaluate search-query composition

## Purpose

Design the `search-run manifest` artifact that ties together query metadata, provider configuration, discovery summaries, and fetch results into a single, human-readable, and machine-parsable Markdown file.

## Current artifact model

Currently, `search-query` produces:
1.  **Individual evidence packs:** One per URL.
2.  **Fetch-list manifest:** A summary of all evidence packs produced in the run.

**Gap:** There is no single artifact that records *why* these fetches were performed (the query), *how* they were discovered (the provider and its config), or *what* was ignored (blocked or duplicate discovery candidates).

## Design problem

How to link the discovery phase (query -> candidates) with the fetch phase (selected URLs -> evidence) without bloating existing schemas or creating excessive files?

Constraints:
- **Privacy:** Must not leak secrets (API keys in provider URLs, tokens in queries).
- **Auditability:** Must record what was ignored and why.
- **Fail-honesty:** Must record errors in both discovery and fetch phases.
- **Simplicity:** Prefer Markdown with YAML frontmatter to match evidence/manifest conventions.

## Candidate artifact strategies

| Strategy | Description | Pros | Cons |
|---|---|---|---|
| **A. Current model only** | No search-run artifact. | Zero implementation cost. | Poor auditability; no query record. |
| **B. Save discovery JSON only** | Write discovery results to a JSON file. | Easy to parse; complete data. | Harder for humans to read; disconnected from fetch. |
| **C. Search-run manifest only** | Markdown file linking to fetch manifest. | Human-readable; ties phases together. | Redundant if discovery JSON is also needed. |
| **D. Manifest + Discovery JSON** | Both Markdown and JSON files. | Maximum completeness. | High artifact bloat (4+ files per search). |

## Recommended artifact strategy

**Strategy C: Search-run manifest only.**

One Markdown file (`evidence/search-*.md`) will serve as the "parent" artifact. It will link to the `fetch-list` manifest and include a summary of the discovery phase. This provides high value for `krn-ai-os` and human auditors while maintaining the project's "Markdown-first" aesthetic.

## Search-run manifest contract

### File naming and hashing

**Filename:** `evidence/search-YYYYMMDDTHHMMSSZ-<sha12>.md`

- **Timestamp:** ISO 8601 basic format (UTC) for chronological sorting.
- **Hash (`sha12`):** First 12 chars of SHA256 of `(query_redacted, provider_name, selected_urls_count, timestamp)`. This ensures uniqueness even for identical queries.

### Frontmatter schema proposal (v0.1)

```yaml
---
schema_version: "0.1"
artifact_type: "search_run_manifest"
generated_at_utc: "2026-05-11T12:00:00Z"
command:
  name: "search-query"
  refresh: false
  follow_redirects: false
query:
  original_sha256: "abc123..."
  normalized: "what is krn-search"
  redacted: "what is krn-search"
provider:
  name: "searxng"
  config:
    max_candidates: 10
    searxng_url_redacted: "https://search.example.com"
    language: "en"
    categories: ["general"]
    safesearch: 1
discovery:
  candidates_total: 8
  selected_for_fetch: 6
  blocked: 1
  duplicates: 1
  errors: 0
fetch:
  requested_urls: 6
  evidence_packs: 6
  succeeded: 4
  blocked: 1
  failed: 1
artifacts:
  fetch_list_manifest: "evidence/manifest-20260511T120000Z-def456.md"
limitations:
  - "Query redaction is best-effort and not a security boundary."
---
```

### Body sections proposal

```md
# Search Run Manifest

## Query
- **Normalized:** `what is krn-search`
- **Original SHA256:** `abc123...`

## Provider
- **Name:** `searxng`
- **Instance:** `https://search.example.com` (redacted)

## Discovery Summary
- **Total candidates:** 8
- **Selected for fetch:** 6
- **Blocked:** 1 (file:// scheme)
- **Duplicates:** 1

## Fetch Summary
- **Requested:** 6
- **Evidence packs written:** 6
- **Success:** 4
- **Failed/Blocked:** 2

## Artifacts
- [Fetch List Manifest](manifest-20260511T120000Z-def456.md)

## Limitations
- Query redaction is best-effort.
```

## Discovery metadata policy

To keep the manifest concise, we will **not** store full snippets or titles for every discovery candidate in the body. The `DiscoveryResult` summary counts (total/selected/blocked/duplicates/errors) are sufficient for the parent manifest.

## Privacy / redaction policy

1.  **Original Query:** Store `sha256(query_original)` only. Do not store the raw original query if it differs from the redacted query.
2.  **Redacted Query:** Store `query_redacted` in frontmatter and body.
3.  **Provider URL:** Store host only or redact secrets from the path/query of the SearXNG URL.
4.  **Evidence Titles/Snippets:** Do not store in the search-run manifest to avoid bloat and potential metadata leakage. They are already in the individual evidence packs.

## Failure honesty model

1.  **Discovery Failures:** If the provider returns errors, they must be recorded in the `discovery.errors` count and listed in the manifest body.
2.  **Zero URLs:** If discovery produces zero fetchable URLs, the manifest is still written, recording 0 URLs fetched.
3.  **Writer Failures:**
    *   If `_write_manifest` (fetch-list) fails, `search_query` should still attempt to write the search-run manifest, marking the `fetch_list_manifest` artifact as `null`.
    *   If `search-run` manifest writer fails, the CLI should exit with a warning/error to stderr, even if evidence packs were written.
4.  **CLI Exit Code:** Success (0) if the manifest is written, even if all discovery/fetches failed. Failure (1) only for CLI misuse or fatal IO errors preventing artifact production.

## Relationship to existing fetch-list manifest

The search-run manifest **points to** the fetch-list manifest. It does not replace it. The fetch-list manifest remains the authoritative record of the batch fetch itself, while the search-run manifest provides the "why" (the query).

## CLI output contract impact

The final line of stdout will now be:
`SearchManifest:\tevidence/search-*.md`

Existing lines (`url\tstatus...` and `Manifest:\t...`) remain to preserve backward compatibility.

## Test plan for implementation

1.  **Unit tests for manifest generator:** Verify YAML frontmatter and Markdown body against various `SearchRunResult` states (happy path, zero URLs, provider errors).
2.  **CLI tests:** Verify `search-query` produces the new file and prints the `SearchManifest:` line.
3.  **Privacy tests:** Verify that secret-bearing SearXNG URLs or queries are redacted in the manifest.
4.  **Fail-honesty tests:** Verify manifest content when discovery or fetch fails completely.

## Non-goals

- No discovery JSON file persistence (deferred).
- No synthesis or answer generation.
- No ranking or filtering metadata in the manifest.

## Decision

Implement Strategy C (Search-run manifest only) in MVP-1E.9. This provides a clean "parent" artifact that links query intent to evidence outcome.

## Next recommended task

MVP-1E.9 — implement search-run manifest generation and wiring.
