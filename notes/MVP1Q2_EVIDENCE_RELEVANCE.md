# MVP-1Q.2 — Evidence Relevance Metadata

**Status:** Complete. PR #12 squash-merged to main at `d626fb3`.

## Summary

Deterministic evidence-level relevance scoring integrated as query-run metadata. Post-fetch textual overlap between query tokens and extracted evidence content (text, headings, early content, content density). Query-run metadata only — not evidence pack frontmatter.

## Scope

- Add `score_evidence_relevance()` to `search_tool/relevance.py`
- Add `EvidenceRelevanceEntry` and `evidence_relevance` to `SearchRunResult`
- Add to search-run manifest YAML (lightweight: url + score)
- Add to CLI JSON output (full component details)
- Tests for all scoring paths and output integration

Non-goals preserved: no evidence pack frontmatter, no compact changes, no existing manifest fields renamed or removed; search-run manifest was additively extended with lightweight query-run metadata, no reranking, no filtering, no provider refactor, no LLM, no new dependencies, no behavior changes.

## Files changed

| File | Change |
|------|--------|
| `search_tool/relevance.py` | `EvidenceComponents`, `EvidenceRelevance` dataclasses; `_extract_text_and_headings()`, `_compute_content_density()`, `score_evidence_relevance()` |
| `search_tool/search.py` | `EvidenceRelevanceEntry` dataclass; `evidence_relevance` on `SearchRunResult`; computation in `search_query()`; manifest YAML section |
| `search_tool/cli.py` | `evidence_relevance` array in JSON output |
| `tests/test_relevance.py` | 25 new tests |

## Query-run metadata locations

| Artifact | What's recorded |
|----------|----------------|
| `SearchRunResult.evidence_relevance` | Full `EvidenceRelevanceEntry` (url, score, components) |
| CLI JSON output | Full components per entry (text_overlap, heading_match, early_content_overlap, content_density, exact_phrase_in_text, low_content_penalty) |
| Search-run manifest YAML | Lightweight: url + score per entry |
| Evidence pack frontmatter | **None** — not justified. Scores are query-specific. |
| Compact summary | **None** — Q.3 scope. |

## Scoring formula

```
base_score = 0.30 * text_overlap
           + 0.15 * heading_match
           + 0.25 * early_content_overlap
           + 0.10 * content_density
           + 0.20 * exact_phrase_bonus

score = clamp(base_score + low_content_penalty, 0.0, 1.0)
```

## Failed/blocked/skipped/truncated behavior

| extraction_status | fetch_status | Scored? |
|-------------------|-------------|---------|
| success | success | Yes |
| truncated | success | Yes — usable content |
| failed | any | No — 0.0 |
| skipped | any | No — 0.0 |
| any | failed | No — 0.0 |
| any | blocked | No — 0.0 |
| any | skipped_duplicate | No — 0.0 |

## Verification

- Tests: 959 baseline → 984/984 (+25)
- Eval-corpus: 11/11
- PR #12 CI: passed
- `git diff --check`: clean

## Non-goals preserved

- No evidence pack frontmatter changes
- No compact summary changes (Q.3)
- No breaking manifest changes; only additive lightweight query-run metadata
- No reranking or filtering
- No discovery/fetch/extraction behavior changes
- No LLM scoring
- No new dependencies

## Next

MVP-1Q.3 — Compact summary relevance visibility. Add relevance column to compact evidence index. Visibility-only: no reranking, no filtering.
