# MVP-1R — Research Session Layer Closeout

**Date:** 2026-05-24  
**Status:** Accepted  
**Scope:** Closeout for MVP-1R.0 through MVP-1R.4.

## Summary

MVP-1R adds a small research session layer above the existing single-run `search-query` pipeline. A session groups multiple runs under one topic, stores run artifacts under a session directory, records best-effort metadata, and generates an on-demand mechanical session summary.

The layer stays within the project contract: it is directory-based, deterministic, and evidence-oriented. It is not a database, search engine, synthesis layer, agent framework, browser automation stack, or provider orchestration system.

## Implemented Capabilities

### R.0 — Design

- Defined sessions as a directory of runs plus metadata, not a database.
- Kept strategy outside krn-search: the agent chooses queries; the session observes and reports.
- Chose observational cross-run dedup and best relevance per source across runs.
- Preserved shared cache behavior and best-effort metadata writes.

### R.1 — Session Directory and Metadata

- Added `search_tool/session.py`.
- Added `--session <topic>` to `search-query`.
- Stores session runs under `<work-dir>/sessions/<session-id>/runs/<run-id>/`.
- Uses deterministic session IDs: `session-<sha256(topic)[:12]>`.
- Writes and appends `session.yaml` with run metadata.
- Recovers from missing/corrupt metadata by scanning existing run artifacts.
- Adds an additive `session` key to JSON output when `--session` is used.

### R.2 — Session Summary

- Added `krn-search session-summary --work-dir <dir> (--session <topic> | --session-id <id>) [--output <file>]`.
- Generates a mechanical `session-summary.md` from existing session run artifacts.
- Includes session metadata, run history, cross-run unique sources, source relevance, cross-run overlap, statistics, and limitations.
- Keeps best relevance per source as `max(evidence_relevance[].score)` across runs.
- Handles missing or corrupt `session.yaml` as a limitation and continues from run artifacts where possible.

### R.2a — Source Snippets

- Adds `## Source Snippets` to session summaries.
- Extracts snippets mechanically from existing run JSON fields or referenced evidence packs.
- Caps snippets at 1000 characters.
- Escapes Markdown table cells.
- Rejects absolute paths and traversal outside the current run directory.
- Records unreadable snippet paths as limitations instead of aborting summary generation.

### R.3 — Dogfood

- Validated the session workflow end to end using CLI surfaces:
  - create a session,
  - run multiple `search-query --research --session` commands,
  - generate `session-summary`,
  - inspect `session.yaml`, per-run `search-run.json`, and rendered summary output.
- Confirmed session creation, deterministic session ID, metadata append, summary sections, overlap, relevance, and snippets worked as intended.
- Identified two follow-up candidates:
  - `--research` default `provider=auto` friction when local SearXNG is unavailable,
  - run-history URL counters showing zero for the dogfood artifact shape.

### R.4 — Run-History Counter Fix

- Fixed the R.3 counter follow-up in `search_tool/session_summary.py`.
- Keeps explicit `fetch` counters when present.
- Falls back to mechanical counts from `evidence_results[]` when explicit counters are missing or zero.
- Counts `success` and `truncated` as succeeded.
- Keeps blocked and failed fallback counters separate for the run-history table.
- Keeps `skipped_duplicate` separate when present.
- Added a regression for the dogfood-shaped artifact and rendered run-history markdown.

## Verification Baseline

Current accepted baseline:

```bash
.venv/bin/python -m pytest -q
# 1053/1053 passed

.venv/bin/python -m search_tool eval-corpus tests/fixtures/search_corpus/basic.json
# 11/11 passed
```

R.5 is docs-only. No new runtime tests are required for this closeout beyond repository hygiene checks.

## Non-Goals Preserved

- No evidence pack schema changes.
- No run manifest schema changes.
- No session metadata schema changes after the R.1 session metadata introduction.
- No new dependencies.
- No AI synthesis or inference.
- No provider/discovery/search-query ergonomics changes in R.3/R.4 follow-up work.
- No database, SQLite, MCP server, browser rendering, dashboard, or API server.
- No changes to relevance logic during R.4.
- No changes to source snippet path-safety during R.4.

## What Dogfood Proved

The dogfood session proved the core session layer is usable with existing CLI surfaces. A user can create a named session, append multiple research runs, and generate a session-level evidence view from stored artifacts. The generated summary exposed useful cross-run information: run history, unique sources, source relevance, source snippets, and overlap.

Dogfood also proved that generated runtime artifacts should remain untracked: `.local/krn-search-runs-r3-dogfood/` was used as evidence for review but was not committed.

## Known Limitations

- Same topic string maps to the same deterministic session ID; independent sessions with identical topics need a future explicit-ID path or topic variation.
- Recovered metadata cannot reconstruct the original topic if it is absent from recoverable artifacts.
- The session YAML parser is intentionally format-specific and supports the format emitted by this project, not arbitrary YAML.
- Session-level dedup is observational only and URL-shaped; semantic duplicates at different URLs are not detected.
- Session summary is mechanical and does not assess research completeness, evidence gaps, or next-query strategy.
- `--research` with default `provider=auto` can fail quickly in environments where local SearXNG is unavailable and no candidate URLs are provided.

## Deferred Candidates

1. Improve `--research` resilience or guidance when SearXNG is unavailable.
   - Candidate A: clearer limitation and fallback command template.
   - Candidate B: controlled fallback path when auto discovery has no reachable provider.

2. Add an explicit session ID override if the same-topic constraint becomes painful.

3. Add a session close/status update command only if session status starts driving user workflow. For now, status is informational.

4. Audit Codex native-web enforcement separately. Current Codex behavior is policy-instructed; deterministic enforcement has not been proven.

## Recommended Next Phase

Recommended next phase: **MVP-1S — Research-mode resilience and operator ergonomics**.

Rationale: the session layer is accepted, and the remaining high-value rough edge from dogfood is not session storage or summary behavior. It is the research preset path when `provider=auto` depends on unavailable local SearXNG. A narrow MVP-1S should improve the operator experience without weakening URL policy, adding AI synthesis, or changing evidence schemas.

Alternative next phase if operations are more important than research ergonomics: a Codex policy enforcement audit for deterministic native-web blocking.

## Verdict

`ACCEPT_MVP1R_RESEARCH_SESSION_LAYER`

The MVP-1R layer is complete enough to close: it provides deterministic session identity, run accumulation, metadata, on-demand summaries, source snippets, dogfooded end-to-end behavior, and a targeted fix for the only session-summary data-shape bug found during dogfood.
