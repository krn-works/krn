# MVP-1L.4 — Real-world llms provider dogfood / acceptance

**Date:** 2026-05-17
**Baseline:** 45f05da6b53f0b281a942d992fea0b1fd1b5e346
**Verdict:** ACCEPT_LLMS_PROVIDER (with tiny fix)

## Baseline verification

- HEAD == origin/main == 45f05da
- Working tree clean
- Parser tests: 51/51
- Provider tests: 43/43
- Alias tests: 16/16
- Init tests: 26/26
- Full suite: 792/792
- Eval-corpus: 11/11
- Compile: OK
- Whitespace: OK

## Tested targets

| # | Target | URL | Query | Discovery | Search | Evidence | Quality |
|---|--------|-----|-------|-----------|--------|----------|---------|
| A | Pydantic | https://docs.pydantic.dev/latest/llms.txt | validation models | PASS (88->8 candidates) | OK (10 evidence) | 10/10 | 3/3 |
| B | FastAPI | https://fastapi.tiangolo.com/llms.txt | dependency injection security | FAIL (404) | FAIL (honest) | 0 | N/A |
| C | GitHub Docs | https://docs.github.com/llms.txt | GitHub Actions workflow permissions | FAIL (0 entries) | FAIL (honest) | 0 | N/A |
| D | Claude Code | https://code.claude.com/docs/llms.txt | hooks skills commands | OK (132->8 candidates) | OK (10 evidence) | 10/10 | 3/3 |

After `*` bullet fix (see Fixes):

| # | Target | Before | After |
|---|--------|--------|-------|
| C | GitHub Docs | FAIL (0 entries) | OK (117->10 candidates, 10 evidence, 3/3) |

## Acceptance criteria per target

### A. Pydantic (docs.pydantic.dev)
- DISCOVERY_PASS: PASS — 88 URLs found, capped to 8, query-relevant candidates
- FETCH_PASS: PASS — 10 evidence packs written
- QUALITY_PASS: PASS — all 3/3, actual docs content (not nav chrome)
- QUERY_RELEVANCE_PASS: PASS — "Models", "Dynamic models", "Validation Decorator" all relevant to "validation models"
- HONEST_FAILURE_PASS: N/A (success)

### B. FastAPI (fastapi.tiangolo.com)
- DISCOVERY_PASS: FAIL — no llms.txt at domain (404)
- FETCH_PASS: N/A
- QUALITY_PASS: N/A
- QUERY_RELEVANCE_PASS: N/A
- HONEST_FAILURE_PASS: PASS — valid JSON, clear "fetch_failed: 404" error, single redaction limitation

### C. GitHub Docs (docs.github.com)
- DISCOVERY_PASS (before fix): FAIL — markdown `*` bullet format not parsed (0 entries)
- DISCOVERY_PASS (after fix): PASS — 117 entries parsed
- FETCH_PASS (after fix): PASS — 10 evidence packs
- QUALITY_PASS (after fix): PASS — 3/3, "Understanding GitHub Actions", "GitHub Actions documentation" relevant to query
- QUERY_RELEVANCE_PASS (after fix): PASS
- HONEST_FAILURE_PASS (before fix): PASS — honest "no parseable URLs" error

### D. Claude Code (code.claude.com)
- DISCOVERY_PASS: PASS — 132 URLs found, capped to 8, highly relevant candidates
- FETCH_PASS: PASS — 10 evidence packs
- QUALITY_PASS: PASS — 3/3, "Commands", "Skills", "Hooks" docs
- QUERY_RELEVANCE_PASS: PASS — all top results directly about hooks/skills/commands
- HONEST_FAILURE_PASS: N/A (success)

## Evidence quality assessment

### Pydantic top evidence
- "Models" — actual API docs for `pydantic.BaseModel`, quality 3/3
- "Dynamic models" — `create_model()` API reference, quality 3/3
- "Validation Decorator" — `validate_call` reference, quality 3/3

### GitHub Docs top evidence (after fix)
- "GitHub Actions documentation" — hub doc, quality 3/3
- "Understanding GitHub Actions" — core concepts, quality 3/3
- "GitHub Actions billing" — operational, quality 3/3

### Claude Code top evidence
- "Commands" — complete command reference, quality 3/3
- "Skills" — skill creation docs, quality 3/3
- "Hooks" — hook intercept/control docs, quality 3/3

## Failures and limitations

### FastAPI — no llms.txt
FastAPI's documentation site (fastapi.tiangolo.com) does not publish an llms.txt or llms-full.txt at any standard location. This is a legitimate finding: not all docs sites follow the llms.txt convention. The provider handles this correctly with a clear 404 error.

### GitHub Docs — `*` bullet format (fixed)
GitHub's llms.txt uses `* [Title](URL): description` format instead of `- [Title](URL): description`. The parser only matched `-` bullets. Fixed in this task.

### Known deferred limitations
- Parser warnings not surfaced in JSON output (L.3 limitation, deferred to L.4 follow-up)
- Duplicate redaction limitation (fixed in this task)
- `--research` mode doesn't auto-select llms provider (by design — explicit `--provider llms` required)
- No recursive llms.txt fetching (hard non-goal)
- No llms-full ingestion (deferred)
- No llms.txt discovery auto-detection (would need DNS/HTTP well-known endpoint)

## Frictions found

| Friction | Severity | Classification | Resolution |
|----------|----------|----------------|------------|
| `search-query --provider llms` missing llms_url | blocker | fix applied | Stored llms_url on provider instance |
| Duplicate redaction limitation in JSON | polish | fix applied | Dedup via dict.fromkeys |
| `*` bullet not parsed in markdown links | polish | fix applied | Extended regex from `[-]?` to `[-*]?` |
| FastAPI has no llms.txt | info | expected | Honest failure reported |
| GitHub llms.txt uses API links, not article links | observation | not a bug | Scoring still produces relevant results |
| 88+ candidates capped silently | polish | acceptable | "Capped candidates from N to M" in limitations |

## Fixes applied

1. **cli.py**: Pass `llms_url=effective_url` to `LlmsTxtProvider` constructor so `search-query --provider llms` has the URL.
2. **discovery_llms.py**: Add `llms_url` field to `LlmsTxtProvider` dataclass; `discover()` falls back to `self.llms_url` when not passed as kwarg.
3. **discovery_llms.py**: Extended `_MARKDOWN_LINK_RE` from `[-]?` to `[-*]?` to match `*` bullet markdown links (GitHub docs format).
4. **cli.py**: Deduplicate limitations in JSON output using `dict.fromkeys()` to eliminate duplicate "Query redaction" limitation.

## Verification

- Parser/provider/alias/init tests: PASS (793/793, +1 new test)
- Full suite: 793/793
- Eval-corpus: 11/11
- Compile: OK
- Whitespace: OK
- No generated artifacts tracked in git

## Recommended next task

L.4 follow-up: Surface parse warnings in JSON output. The parser already collects warnings but they're not surfaced. Also consider:
- Auto-discovery: try common llms.txt paths before falling back to explicit --url
- llms-full support: some sites (GitHub) only publish structured content via llms-full
