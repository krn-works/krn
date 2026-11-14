# MVP-1L.2 — llms.txt discovery provider implementation

**Date:** 2026-05-17
**Phase:** MVP-1L
**Task:** MVP-1L.2 — Implementation
**Status:** Complete

## Baseline

- **SHA:** 11a1edd0d05421cdeed47e00994c6e8cc4e27849 (MVP-1L.1 design, pushed)
- **Tests before:** 682/682 pass
- **Eval-corpus:** 11/11 pass
- **Working tree:** clean

## Implementation summary

Added `llms` as a new discovery provider type, parallel to `static` and `searxng`. The provider fetches a single llms.txt file at a user-supplied URL, parses it with a lightweight markdown parser (stdlib only), extracts URLs, applies deterministic keyword scoring over the query, and emits normal `RawDiscoveryCandidate`s into the existing pipeline.

**Pre-push simplify pass:** Removed unused imports (`field`, `urlunparse`, `DiscoveryCandidate`), deduped `ALLOWED_SCHEMES` by importing from `url_policy`, removed unreachable `raw_url.endswith(")")` branch, removed no-op warning truncation loop, replaced 8 repeated redaction limitation strings with `_REDACTION_LIMITATION` constant, wired `timeout_seconds` through to `_do_fetch` (was silently ignored).

### New files

- `search_tool/discovery_llms.py` — Parser + provider
- `tests/test_llms_parser.py` — 40 parser tests
- `tests/test_llms_provider.py` — 48 provider tests
- `tests/fixtures/llms/basic-llms.txt` — Full-featured fixture
- `tests/fixtures/llms/relative-llms.txt` — Relative URL fixture
- `tests/fixtures/llms/malformed-llms.txt` — Edge-case fixture

### Modified files

- `search_tool/cli.py` — Added `llms` provider choice, `--url` flag, `_run_llms_discover` handler, `search-query` llms branch
- `search_tool/profiles.py` — Added `llms-docs` profile
- `README.md` — CLI examples for llms provider

## Parser rules implemented

### Supported formats

| Format | Example | Extracted |
|--------|---------|-----------|
| Markdown link | `[Title](https://...)` | title, url |
| Markdown link with description | `[Title](url): description` | title, url, snippet |
| Bullet markdown link | `- [Title](url) — desc` | title, url, snippet |
| Named URL | `Title: https://url` | title, url |
| Raw URL | `https://url` | url only |
| H2 section | `## Section Name` | section for subsequent entries |
| Relative URL | `/path` → resolved against source origin | resolved url |

### Ignored content

- Fenced code blocks (```)
- Unsupported schemes: `file:`, `javascript:`, `data:`, `mailto:`
- Empty links `[]()`
- Fragments-only links
- Malformed links silently skipped

### Deduplication

- By normalized absolute URL
- First occurrence preserved (title, snippet, section, line number)

### Scoring

Deterministic keyword scoring for query relevance:
1. Title match: +10 per term
2. Section/description match: +5 per term
3. URL match: +3 per term
4. Tie-break: line number (first occurrence wins)

## Provider behavior

- `--provider llms` requires `--url` (llms.txt source URL)
- Missing `--url` returns clear error
- Invalid llms.txt URL blocked by URL policy
- Fetch failure returns clear provider error
- Zero parseable URLs returns clear error
- Candidate URLs go through existing URL policy
- Private/local candidates blocked
- Respects `max_candidates`
- No LLM ranking

## CLI contract

```bash
# discover-query
krn-search discover-query "query" --provider llms --url "https://example.com/llms.txt"

# search-query
krn-search search-query "query" --provider llms --url "https://example.com/llms.txt" --json --work-dir .local/krn-search-runs
```

## Tests

### Parser tests (40 tests)

- Fenced code stripping (3)
- Markdown links (5)
- Raw URLs (2)
- Section capture (3)
- Title/description (2)
- Relative URL resolution (4)
- Scheme blocking (6)
- Deduplication (3)
- Malformed content (5)
- Fenced code in llms.txt (2)
- URL validation helpers (6)
- Keyword scoring (7)
- Real-world fixtures (3)

### Provider tests (48 tests)

- Missing --url (2)
- Invalid index URL (2)
- Fetch failure (5)
- Candidates returned (6)
- Query scoring (4)
- Max candidates (2)
- Private candidate rejection (3)
- No network (2)
- Empty query (2)
- Provider isolation (7)
- Dedup in provider (1)
- Integration with build_discovery_result (2)

### Test counts

| Suite | Before | After |
|-------|--------|-------|
| init tests | 26/26 | 26/26 |
| full suite | 682/682 | **770/770** (+88) |
| eval-corpus | 11/11 | 11/11 |

## Smoke test

Command: `search-query "validation models" --provider llms --url "https://docs.pydantic.dev/latest/llms.txt" --json`

Result: Valid JSON, provider=llms, 0 candidates, error="no_entries" (pydantic.llms.txt returns 301 redirect; MVP doesn't follow redirects for the source URL). Honest error reporting confirmed.

## Known limitations

1. **No redirect following for llms.txt source URL** — The provider uses `fetch_url(follow_redirects=False)`. Sites like pydantic.dev redirect `/latest/llms.txt` → `/llms.txt`. L.3 should add `--follow-redirects` support.
2. **No recursive llms.txt fetching** — Subsection indexes listed in the llms.txt are NOT fetched. They become regular evidence URLs in the fetch phase.
3. **No llms-full.txt ingestion** — Not in scope for L.2.
4. **No H1 title stored as entry metadata** — H1 lines parsed but not attached to entries.
5. **Blockquote descriptions not parsed** — Lines like `> Description` are silently skipped.
6. **Warnings not surfaced** — Parse warnings are collected but not exposed in the result. L.3 should add a warnings field.
7. **No max llms.txt size limit** — Parser accepts entire body. Could be a DOS vector for huge files.
8. **llms provider not in `--research` preset** — L.3 should consider adding llms as an auto-discovery option.

## Next task: MVP-1L.3

- Add `llms-docs` profile (DONE — implemented in L.2)
- Wire llms provider into `--research` preset auto-resolution
- Add `--follow-redirects` support for llms provider
- Surface parse warnings in JSON output
- Dogfood with real llms.txt files (docs.github.com, fastapi.tiangolo.com)
- Acceptance evaluation
