# MVP-1P.1 — Discovery Diagnostics Artifact

## Summary

Added a structured JSON diagnostics artifact that records discovery-stage accounting alongside search evidence. Pure mechanical accounting — no relevance scoring, no LLM, no provider refactoring.

## Changes

### `search_tool/search.py`

- Added `write_discovery_diagnostics()`: writes `discovery-diagnostics.json` to the evidence directory
- Added `discovery_diagnostics_path: Path | None = None` to `SearchRunResult` (last field with default, backward-compatible)
- `search_query()` calls the writer when `evidence_dir` is available; failure is non-fatal

### `search_tool/cli.py`

- `_print_search_result_json()` includes `discovery_diagnostics_path` in JSON output and `search-run.json`

### `tests/test_discovery_diagnostics.py` (new)

20 tests covering:
- JSON file creation and structure
- Query hash and redacted query
- Provider name, candidate counts
- Blocked candidates with reasons
- Duplicate candidates with original URLs
- Selected candidates with rank, title, snippet, source_engine, source_quality
- Discovery errors and limitations
- Secret redaction (API keys)
- Empty discovery (zero candidates)
- Directory creation
- Integration: written with evidence_dir, not written without, written on empty fetch URLs, graceful failure
- URL credential redaction: credentials stripped from blocked, selected, and duplicate candidate URLs

## Artifact format

```json
{
  "schema_version": "0.1",
  "artifact_type": "discovery_diagnostics",
  "query": {
    "hash_sha256": "...",
    "redacted": "..."
  },
  "provider_name": "static",
  "candidates_total": 3,
  "selected_for_fetch": 1,
  "blocked_candidates": [{"rank": 2, "url": "...", "reason": "..."}],
  "duplicate_candidates": [{"rank": 3, "url": "...", "duplicate_of": "..."}],
  "selected_candidates": [{
    "rank": 1,
    "url": "...",
    "title": "...",
    "snippet": "...",
    "source_engine": "...",
    "source_quality": {
      "source_type": "...",
      "authority_score": 3,
      "is_official": false,
      "is_primary_source": false,
      "domain": "...",
      "reason": "..."
    }
  }],
  "discovery_errors": [{"code": "...", "message": "..."}],
  "discovery_limitations": ["..."]
}
```

## Design decisions

- Single flat file at `evidence_dir / "discovery-diagnostics.json"` — no subdirectory
- Only written when `evidence_dir` is available (same gate as compact summary, search-run manifest)
- Writer failure is non-fatal — `discovery_diagnostics_path` is `None` on error
- Source quality computed at diagnostics-write time using `classify_source_quality()`
- URL credential redaction: `_redact_url_for_diagnostics()` strips username/password from all candidate URLs before writing (applied to selected, blocked, and duplicate entries)
- No raw pre-dedup results captured (task scope: "do not refactor providers heavily just to capture raw pre-dedup results")

## Verification

- Tests: 922/922 (902 baseline + 20 new)
- Eval-corpus: 11/11
- `git diff --check`: clean
- No new dependencies
- No behavior changes to fetch/extraction
- Evidence schema v0.1 preserved
- Manifest schema v0.1 preserved
