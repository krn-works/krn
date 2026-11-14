# MVP-1Q.0 — Deterministic Relevance Scoring Design

**Status:** Design complete. No code changes.

**Date:** 2026-05-21

## Summary

Design for deterministic, non-LLM relevance scoring in krn-search. Adds two relevance signals:
1. **Candidate relevance** (pre-fetch): textual overlap between query terms and candidate title/snippet/URL path
2. **Evidence relevance** (post-fetch): textual overlap between query terms and extracted content

Both are metadata-only. No behavior changes to discovery, fetch, extraction, or source ordering.

## Deliverables

- `docs/architecture/deterministic-relevance-scoring.md` — full design document
- This file — design report and handoff

## Design decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Scoring method | Keyword overlap (token intersection ratio) | Deterministic, no LLM, no dependencies, fast |
| Score range | 0.0 – 1.0 per component, combined weighted | Granular but bounded |
| Stop words | English-only fixed set (~40 words) | Simple, predictable. Polish diacritics preserved as-is. |
| Stemming/lemmatization | None | Deterministic. Exact match is the defined scope. |
| New module | `search_tool/relevance.py` | Isolated. No changes to existing module logic. |
| Score combination weights | Documented defaults, tunable in Q.4 dogfood | Transparent. Not final. |
| Evidence pack frontmatter | No relevance score | Scores are query-dependent. Evidence packs are query-independent. |
| Auto-filtering/reranking | Not in MVP-1Q | Metadata-only first. Behavior changes are later-stage. |

## Key data structures

```python
QueryTokens(raw_tokens, important_tokens, normalized_query)
CandidateRelevance(score, components: CandidateComponents)
EvidenceRelevance(score, components: EvidenceComponents)
EvidenceRelevanceEntry(url, score, components)
```

## Staged plan

- MVP-1Q.1: Candidate relevance in discovery-diagnostics.json
- MVP-1Q.2: Evidence relevance in search-run manifest and CLI output
- MVP-1Q.3: Compact summary relevance column
- MVP-1Q.4: Dogfood + threshold exploration

## Risks

See full design doc: keyword overfit, Polish tokenization, false confidence, SEO gaming, authority/relevance conflict. All documented with mitigations.

## Stop condition check

- No implementation code written: PASS
- No LLM scoring proposed: PASS
- No behavior/ranking changes proposed for MVP-1Q.1: PASS (explicitly marked as later-stage)

## Files changed

- `docs/architecture/deterministic-relevance-scoring.md` (new) — full design
- `notes/MVP1Q0_RELEVANCE_SCORING_DESIGN.md` (new) — this file
- `notes/ACTIVE_TASK.md` — update current status
- `notes/EXPERIMENT_LOG.md` — add entry

## Next

MVP-1Q.1 implementation: `search_tool/relevance.py` with `tokenize_query()` and `score_candidate_relevance()`, integrated into discovery-diagnostics output.
