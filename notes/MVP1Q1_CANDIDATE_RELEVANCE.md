# MVP-1Q.1 — Candidate Relevance Metadata

**Status:** Complete. PR #10 squash-merged to main at `a2e3950`.

## Summary

Deterministic candidate relevance scoring integrated into discovery diagnostics. Each selected candidate in `discovery-diagnostics.json` now has a `candidate_relevance` object with score (0.0–1.0) and 7 interpretable components. Whole-token matching prevents short-token false positives (AI matching inside "main").

## Scope

- Create `search_tool/relevance.py` with tokenization and scoring
- Integrate into `write_discovery_diagnostics()` (additive field)
- Tests for all scoring paths

Non-goals preserved: no evidence relevance, no compact changes, no manifest changes, no reranking, no filtering, no provider refactor, no LLM, no new dependencies, no behavior changes.

## Files changed

| File | Change |
|------|--------|
| `search_tool/relevance.py` | New module (~170 lines) |
| `search_tool/search.py` | ~15 lines added to `write_discovery_diagnostics()` |
| `tests/test_relevance.py` | New test file (34 tests) |

## Schema change

Additive only. `selected_candidates[]` entries in `discovery-diagnostics.json` gain a `candidate_relevance` field:

```json
{
  "rank": 1,
  "url": "...",
  "title": "...",
  "snippet": "...",
  "source_engine": "...",
  "source_quality": { ... },
  "candidate_relevance": {
    "score": 0.85,
    "components": {
      "title_overlap": 1.0,
      "snippet_overlap": 1.0,
      "url_path_overlap": 0.5,
      "exact_phrase_in_title": true,
      "exact_phrase_in_snippet": true,
      "source_quality_modifier": 0.0,
      "generic_page_penalty": 0.0
    }
  }
}
```

## Whole-token matching

`_text_tokens()` tokenizes text using `re.compile(r"[^\W_]+", re.UNICODE)` into a frozenset. `_token_overlap()` checks set membership, not substring. This prevents short tokens (AI, UI, JS, WP) from matching inside unrelated words.

Example: query "AI agents" does not match "Main available pages" because "ai" is not in the frozenset `{"main", "available", "pages"}`.

## Scoring formula

```
base_score = 0.40 * title_overlap
           + 0.25 * snippet_overlap
           + 0.15 * url_path_overlap
           + 0.20 * exact_phrase_bonus

score = clamp(base_score + source_quality_modifier + generic_page_penalty, 0.0, 1.0)
```

- **exact_phrase_bonus**: 1.0 if normalized query appears as substring in title or snippet, else 0.0
- **source_quality_modifier**: SEO=-0.20, forum+low_auth=-0.10, official=+0.10, else 0.0
- **generic_page_penalty**: largest of listing title (-0.15), generic path segment (-0.15), empty snippet (-0.10)

## Verification

- Tests: 959/959 (925 baseline + 34 new)
- Eval-corpus: 11/11
- PR #10 CI: passed
- `git diff --check`: clean

## Non-goals preserved

- No evidence relevance (Q.2)
- No compact summary changes (Q.3)
- No manifest schema changes
- No reranking or filtering
- No discovery/fetch/extraction behavior changes
- No LLM scoring
- No new dependencies

## Next

MVP-1Q.2 — Evidence relevance metadata. Post-fetch textual overlap between query tokens and extracted evidence content.
