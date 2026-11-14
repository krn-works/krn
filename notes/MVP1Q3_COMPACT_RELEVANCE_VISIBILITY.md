# MVP-1Q.3 — Compact Summary Relevance Visibility

**Status:** Complete. PR #14 squash-merged to main at `d596756`.

## Summary

Relevance visibility in compact evidence index. `Relevance` column added to source table with percentage display. Visibility-only: no reranking, no filtering, no behavior changes.

## Scope

- Add `relevance_score` to `SourceEntry` dataclass
- Build relevance lookup from `SearchRunResult.evidence_relevance`
- Add `Relevance` column to compact source table
- Display as rounded percentage (e.g. `72%`)
- Fallback `0%` when no evidence relevance metadata

Non-goals preserved: no reranking, no filtering, no behavior changes, no JSON changes, no search-run manifest changes, no evidence pack changes, no discovery diagnostics changes, no provider refactor, no LLM, no new dependencies.

## Files changed

| File | Change |
|------|--------|
| `search_tool/compact.py` | `relevance_score` on `SourceEntry`; `relevance_map` in `_build_source_entries()`; `Relevance` column in table |
| `tests/test_compact_summary.py` | 9 new tests in `TestRelevanceVisibility` |

## Output format

### Before (Q.2)

```
| # | Title | URL | Type | Auth | Official | Status | Quality | Evidence |
```

### After (Q.3)

```
| # | Title | URL | Type | Auth | Official | Status | Quality | Relevance | Evidence |
```

Row example: `| 1 | Python Docs | https://docs.python.org/3/ | official_docs | 3/3 | True | success | 3/3 | 72% | /evidence/... |`

## Fallback behavior

| Condition | Display |
|-----------|---------|
| Evidence relevance score 0.72 | `72%` |
| Evidence relevance score 1.0 | `100%` |
| No `evidence_relevance` on SearchRunResult | `0%` |
| Failed/blocked fetch | `0%` |
| Score not found in relevance_map | `0%` |

## URL mapping

`relevance_map` keyed by `EvidenceRelevanceEntry.url`. Lookup per evidence result uses `r.final_url or r.normalized_url` — matches the key set in `search_query()`.

## Verification

- Tests: 984 baseline → 993/993 (+9)
- Eval-corpus: 11/11
- PR #14 CI: passed
- `git diff --check`: clean

## Non-goals preserved

- No reranking or filtering
- No behavior changes to discovery, fetch, extraction, ranking
- No JSON/manifest/evidence pack/discovery diagnostics changes
- No new dependencies
- No LLM scoring

## Next

MVP-1Q.4 — Relevance dogfood/calibration. Run real queries, record scores alongside manual usefulness assessment, document weight tuning recommendations. Dogfood/evaluation only unless issues are found.
