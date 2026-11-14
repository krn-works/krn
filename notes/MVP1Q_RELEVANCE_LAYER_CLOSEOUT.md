# MVP-1Q — Relevance Layer Closeout

**Date:** 2026-05-22
**Status:** Accepted. No immediate tuning.

## Layer summary

MVP-1Q delivered deterministic, non-LLM relevance scoring for krn-search. Two signals: candidate relevance (pre-fetch, textual overlap with title/snippet/URL) and evidence relevance (post-fetch, textual overlap with extracted content). Both are metadata-only — no reranking, no filtering, no behavior changes.

## Phase timeline

| Phase | Deliverable | Tests | PR |
|-------|-------------|-------|----|
| Q.0 | Design document | 925 baseline | — |
| Q.1 | Candidate relevance in `discovery-diagnostics.json` | 925 → 959 (+34 tests) | #10 |
| Q.2 | Evidence relevance in `SearchRunResult`, CLI JSON, manifest YAML | 959 → 984 (+25 tests) | #12 |
| Q.3 | Relevance column in compact evidence index (percentage display) | 984 → 993 (+9 tests) | #14 |
| Q.4 | Dogfood/calibration: 6 scenarios, 12 source evaluations | 993 (unchanged) | #16 |

Final baseline: 993/993 tests, 11/11 eval-corpus.

## Accepted capabilities

1. **Candidate relevance** — `tokenize_query()`, `score_candidate_relevance()` in `search_tool/relevance.py`. Whole-token matching via `_text_tokens()` frozenset. Weighted formula: 0.40*title + 0.25*snippet + 0.15*url_path + 0.20*exact_phrase_bonus, clamped [0.0, 1.0], plus source_quality_modifier and generic_page_penalty. Recorded in `discovery-diagnostics.json` per candidate.

2. **Evidence relevance** — `score_evidence_relevance()` in `search_tool/relevance.py`. Whole-token membership via `_token_overlap()` with `_text_tokens()`. Weighted formula: 0.30*text + 0.15*headings + 0.25*early_content + 0.10*density + 0.20*exact_phrase_bonus, clamped [0.0, 1.0], plus low_content_penalty. Recorded in `SearchRunResult.evidence_relevance`, CLI JSON, and search-run manifest YAML.

3. **Compact visibility** — `Relevance` column in compact evidence index source table. Percentage display (e.g. `72%`). Fallback `0%` when no evidence relevance metadata.

4. **Query-run metadata only** — Scores are not stored in evidence packs (query-independent artifacts) or used for ordering/filtering. The caller (agent, human) uses scores as informational signals.

## Known limitations

1. **Keyword-only, not semantic** — Scores measure textual overlap between query terms and content. No understanding of query intent, synonyms, or related concepts. A high score does not mean the source answers the query.

2. **English-centric stop words** — Stop word list is English-only. Polish queries work via exact diacritics-preserving token matching but receive no Polish-specific stop word filtering.

3. **Score range compression** — Evidence relevance for useful content clusters in 30-65% range. The interpretation guide's upper bands (0.6-0.8, 0.8-1.0) are rarely achievable with current weights because `heading_match` is often 0.0 and `exact_phrase_in_text` rarely triggers.

4. **No entity/package-name awareness** — Whole-token matching correctly avoids substring false positives but cannot distinguish a library name (e.g. `requests`) from a generic concept (e.g. `request` in `urllib.request`). Scores can be dominated by overlapping generic tokens.

5. **SPA/JS-heavy pages** — Pages that render as "Loading..." get 0% evidence relevance, which is correct (no useful content extracted) but may confuse callers who see a high candidate score with 0% evidence.

6. **Official docs may underscore relative to blog/tutorial content** — Source quality and relevance are independent signals. A blog with all query terms in the snippet can outscore official docs that uses different vocabulary. The caller must weigh both signals.

## Calibration candidates (deferred)

The following candidates remain in `notes/DECISION_CANDIDATES.md` for future consideration. No immediate action.

| Candidate | Priority | Trigger |
|-----------|----------|---------|
| Update score interpretation guide bands | Recommended | Before any caller depends on score ranges |
| Package/entity-name disambiguation | Medium | If library-name queries become a pattern |
| Official modifier floor | Low | If irrelevant official docs confuse callers |
| Generic page penalty strengthening | Low-Medium | If SEO listings consistently outrank official docs |
| Heading match weight redistribution | Informational | If heading_match continues at 0.0 across more scenarios |

**Decision: no immediate tuning.** Q.4 found no blockers. The scoring is deterministic, predictable, and honest about its limitations. Weight tuning should only proceed when future evidence demands it.

## New module

`search_tool/relevance.py` — all relevance scoring code. Tokenization, candidate scoring, evidence scoring, dataclasses. No changes to existing modules' logic.

## What did not change

- Discovery, fetch, extraction, ranking, filtering — untouched
- Evidence pack schema (v0.1) — no relevance fields
- Manifest schema (v0.1) — additive only (lightweight evidence_relevance section)
- URL policy — unchanged
- Cache behavior — unchanged
- No new dependencies
- No LLM scoring
- No behavior changes anywhere in the pipeline

## Recommended next phase

**MVP-1R.0 — Research session design.** The relevance layer is complete. The next natural step is designing how a full research session uses krn-search capabilities (discovery, ingestion, relevance, compact summaries) to support multi-query, multi-source research workflows. This is a design-only task.

## Review packet

- **Task:** MVP-1Q.5 — Relevance layer closeout summary
- **Scope:** Docs-only
- **Files created:** `notes/MVP1Q_RELEVANCE_LAYER_CLOSEOUT.md`
- **Files updated:** `ACTIVE_TASK.md`, `PROJECT_STATE.md`, `EXPERIMENT_LOG.md`, `CLAUDE.md`
- **Code changes:** None
- **Test results:** 993/993 (unchanged), 11/11 eval-corpus (unchanged)
- **Blockers:** None
