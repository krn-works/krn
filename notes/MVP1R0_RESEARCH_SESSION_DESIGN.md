# MVP-1R.0 — Research Session Design

**Date:** 2026-05-22
**Status:** Design complete. Ready for review.
**Scope:** Design-only. No code changes.

## Goal

Design the research session layer that sits above existing krn-search capabilities (discovery, evidence packs, discovery diagnostics, candidate relevance, evidence relevance, compact summaries) to support multi-query, multi-source research workflows.

## Baseline

993/993 tests, 11/11 eval-corpus. HEAD: 23693fd.

## Problem

krn-search is single-pass: one query produces one set of evidence. Real research requires multiple queries with different strategies. The agent currently drives multi-run research manually, with:
- No accumulated view across runs
- No cross-run dedup visibility
- No session state record
- No session-level summary

## Design decisions

### D1: Session is a directory of runs with metadata, not a database

Consistent with project constraints (no SQLite, no database). Session metadata in `session.yaml`. Run structure unchanged. Session summary generated on demand.

### D2: Agent drives strategy, session observes and reports

Session does not recommend queries, assess completeness, or drive iteration. It accumulates, deduplicates, and reports. The agent decides what to search for next.

### D3: Session dedup is observational, not blocking

Cross-run dedup reports overlaps and cache hits. It does not prevent re-fetching. The agent decides whether to use `--refresh`.

### D4: Best relevance per source across runs (not average or most recent)

If a source scored 65% in run 1 and 45% in run 2, the session summary shows 65%. The higher score indicates better query-source term overlap.

### D5: Shared cache (not session-scoped)

URL evidence doesn't change per session. Sessions use the existing global cache. No session-scoped cache.

### D6: Session metadata is best-effort

Failed metadata write produces a limitation on the run but does not block evidence generation. Corrupted metadata can be recovered from run artifacts.

### D7: Session summary is mechanical aggregation

Same philosophy as compact summary: deterministic, reproducible, no AI synthesis. Cross-run aggregation of existing run-level data.

## Architecture

Full design at `docs/architecture/research-session-design.md`.

### Session directory structure

```
<work-dir>/
  cache/                    # shared (unchanged)
  runs/                     # non-session runs (unchanged)
  sessions/
    <session-id>/
      session.yaml          # session metadata
      runs/
        <run-id>/           # existing run structure
      session-summary.md    # generated on demand
```

### Session metadata (session.yaml)

- `schema_version: "0.1"`
- `session_id`, `topic`, `created_at`, `updated_at`, `status`
- `runs_total` and per-run records (query, provider, profile, status, source counts, best relevance)
- Append-only run records

### Session summary (session-summary.md)

- Session metadata header
- Run history table
- Unique source table (cross-run dedup by final_url, sorted by best relevance)
- Source snippets (deduplicated)
- Cross-run overlap report
- Session statistics
- Limitations

### Agent interaction

1. Specify session (implicit creation on first query)
2. Add runs (each search-query updates session metadata)
3. View session state (on-demand summary generation)
4. Close session (optional, informational)

## Staged implementation plan

| Phase | Deliverable | Scope |
|-------|-------------|-------|
| R.1 | Session directory and metadata | Structure, session.yaml, wiring into search-query, recovery |
| R.2 | Session summary | Cross-run unique source table, snippets, overlap, statistics |
| R.3 | Dogfood | Real research scenarios, summary quality, agent experience |

## Alternatives considered and rejected

1. **No session, agent accumulates manually** — context is lossy, error-prone
2. **Session as SQLite database** — hard non-goal (no database)
3. **Session tracking in Claude Code skill** — too complex for skill-level logic
4. **Implicit sessions via shared work-dir** — lacks identity, concurrent topics harder

## Risks

- Cross-run URL dedup misses semantic duplicates (accepted limitation)
- Corrupted metadata blocks runs (mitigated: best-effort, recovery from run artifacts)
- Session encourages over-researching (mitigated: observational only, agent drives)

## Non-goals for R.0–R.3

- Evidence gap analysis
- Provider effectiveness tracking
- Session export
- Evidence ledger
- Evidence graph
- Any AI-driven judgment or recommendation

## Files

- **Created:** `docs/architecture/research-session-design.md`
- **Updated:** `notes/ACTIVE_TASK.md`, `notes/PROJECT_STATE.md`, `notes/EXPERIMENT_LOG.md`

## Verification

No code changes. 993/993 tests, 11/11 eval-corpus (unchanged).
