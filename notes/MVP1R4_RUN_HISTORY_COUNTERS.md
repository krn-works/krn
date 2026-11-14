# MVP-1R.4 — Session Summary Run-History Counters

**Date:** 2026-05-23  
**Status:** Complete  
**Scope:** Small deterministic bugfix for `session-summary` run-history counters.

## Goal

Fix the R.3 dogfood follow-up where `session-summary.md` run-history URL counters showed zero even though the same run artifact contained successful evidence rows, relevance rows, and snippets.

## Change

- `search_tool/session_summary.py` now reads explicit `fetch` counters when present.
- If `fetch` counters are absent or zero while `evidence_results[]` exists, run-history counters are derived mechanically from `evidence_results`.
- `success` and `truncated` count as succeeded.
- Failed and blocked statuses remain separate for the run-history table: `blocked`/`policy_blocked` count as blocked, while `failed`/`error`/`timeout` count as failed.
- `skipped_duplicate` remains separate when already present.

## Non-Goals Preserved

- No schema changes.
- No new dependencies.
- No provider, discovery, `search-query`, evidence pack, relevance, or snippet path-safety changes.
- No AI synthesis.

## Regression

`tests/test_session_summary_complete.py` includes a dogfood-shaped artifact where top-level fetch counters are zero and `evidence_results[]` contains successful rows. The regression asserts non-zero run-history counters in both the summary object and rendered markdown.

## Verification

```bash
.venv/bin/python -m pytest -q
# 1053 passed

.venv/bin/python -m search_tool eval-corpus tests/fixtures/search_corpus/basic.json
# scenarios=11 passed=11 failed=0 errors=0

git diff --check
# clean

git status --short --branch
# Only expected source/test/notes files modified; no generated .local artifacts staged.
```
