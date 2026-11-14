# MVP-1R.2a — Source Snippets for Session Summaries

**Date:** 2026-05-22
**Status:** Implementation complete. Review/commit pending.
**Scope:** Add mechanical source snippets to `krn-search session-summary`.

## Summary

Session summaries now include a `## Source Snippets` table. The table is generated only from existing run artifacts and evidence packs. There is no AI synthesis, no summarization, and no rewriting.

## Behavior

Snippet extraction order for each successful/truncated source:

1. Existing `snippet` field in `search-run.json`
2. Existing `excerpt` field in `search-run.json`
3. Existing `content` field in `search-run.json`
4. Existing evidence pack referenced by `evidence_path`

Evidence pack fallback extracts fenced source text from the existing pack and strips only common leading navigation chrome. The recorded `evidence_path` must be relative and resolve inside the current run directory; absolute paths and traversal outside `run_dir` are rejected. Snippets are capped at 1000 characters. Markdown table cells are escaped and single-lined so pipes, angle brackets, and newlines do not break the table.

Missing snippet data renders as an empty snippet. Unreadable evidence paths record a session-summary limitation and continue.

## Ordering

Snippet rows are deterministic:

1. Best evidence relevance descending
2. URL ascending

Best relevance remains the maximum `evidence_relevance[].score` observed for that source across runs. Frequency and `runs_count` remain separate visibility signals and are not used as relevance.

## Files changed

| File | Change |
|------|--------|
| `search_tool/session_summary.py` | Adds snippet extraction, capping, table escaping, and `## Source Snippets` output |
| `tests/test_session_summary_complete.py` | Adds behavior tests for run-JSON snippets, evidence-pack fallback, capping, escaping, missing data, path-safety rejection, and existing CLI selector behavior |
| `notes/ACTIVE_TASK.md` | Records current local R.2a state |
| `notes/PROJECT_STATE.md` | Records R.2a capability and verification state |
| `notes/EXPERIMENT_LOG.md` | Adds R.2a experiment entry |

## Non-goals preserved

- No evidence schema changes
- No run manifest schema changes
- No session metadata schema changes
- No new dependencies
- No provider refactor
- No database, MCP, hooks, dashboard, or API server
- No changes to existing `search-query` behavior

## Verification

- `pytest -q` -> 1052 passed
- `python -m search_tool eval-corpus tests/fixtures/search_corpus/basic.json` -> 11/11
- `git diff --check` -> clean
