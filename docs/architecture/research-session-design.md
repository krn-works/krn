# Research Session Design

## Scope

Design for a research session layer that groups multiple search runs into a coherent multi-query, multi-source research workflow. Sessions sit above the existing single-run pipeline and provide cross-run accumulation, visibility, and mechanical aggregation.

A session answers: "What evidence do I have across all my research queries for this topic?"

It does NOT answer: "What should I search for next?" or "Is my research complete?"

## What a session IS

A session is a directory containing multiple search runs, session metadata, and an on-demand cross-run summary. It is NOT a database, NOT an agent framework, and NOT an iterative refinement engine.

A session provides:
1. **Session identity** — a named research topic with a unique directory
2. **Run accumulation** — multiple search-query runs stored under the session
3. **Cross-run visibility** — dedup reporting, cache hit reporting, overlap analysis
4. **Session-level summary** — mechanical aggregation of all run results

The agent drives strategy. The session observes and reports.

## Current gap

krn-search is single-pass: one query produces one set of evidence. Real research requires multiple queries with different strategies. The agent currently drives multi-run research manually with no cross-run visibility:

1. **No accumulated view** — each run produces its own compact summary
2. **No cross-run dedup visibility** — overlapping URLs across runs are invisible
3. **No session state record** — no record of what queries were tried, what providers were used
4. **No session-level summary** — no mechanical aggregation of results across runs

## Constraints

- Session state is a directory of evidence runs, not a database
- No iterative refinement loop in krn-search — the agent drives strategy
- Session operations are best-effort — failed metadata writes don't block runs
- Session summary is mechanical aggregation, not AI synthesis
- No new dependencies
- No changes to evidence pack schema (v0.1) or run-level manifest schema (v0.1)
- Compatible with existing `--work-dir` directory structure
- Shared cache across session runs (no session-scoped cache)

## Session directory structure

```
<work-dir>/
  cache/                              # shared cache (unchanged)
  runs/                               # non-session runs (unchanged)
    <run-id>/
      evidence/
      ...
  sessions/                           # session runs
    <session-id>/
      session.yaml                    # session metadata
      runs/
        <run-1-id>/
          evidence/
            ...
          search-run.json
          discovery-diagnostics.json
          search-summary-*.md
          ...
        <run-2-id>/
          ...
      session-summary.md              # generated on demand
```

Session ID format: `<timestamp>-<hash>` where hash is SHA-256 of session topic.

Non-session runs continue to use `<work-dir>/runs/<run-id>/` unchanged.

## Session metadata (session.yaml)

```yaml
schema_version: "0.1"
session_id: "20260522T120000Z-abc123def456"
topic: "building AI coding-agent operating systems"
created_at: "2026-05-22T12:00:00+00:00"
updated_at: "2026-05-22T12:45:00+00:00"
status: "active"
runs_total: 3
runs:
  - run_id: "20260522T120000Z-abc123"
    query: "building AI agents architecture"
    query_sha256: "..."
    provider: "searxng"
    profile: "official-docs"
    status: "ok"
    sources_total: 8
    sources_succeeded: 7
    sources_failed: 1
    best_evidence_relevance: 0.66
    created_at: "2026-05-22T12:00:00+00:00"
  - run_id: "20260522T121500Z-def456"
    query: "AI agent tool use patterns"
    query_sha256: "..."
    provider: "llms"
    profile: "official-docs"
    status: "partial_success"
    sources_total: 5
    sources_succeeded: 3
    sources_failed: 2
    best_evidence_relevance: 0.58
    created_at: "2026-05-22T12:15:00+00:00"
  - run_id: "20260522T123000Z-ghi789"
    query: "LangChain agent architecture"
    query_sha256: "..."
    provider: "searxng"
    profile: "official-docs"
    status: "ok"
    sources_total: 6
    sources_succeeded: 6
    sources_failed: 0
    best_evidence_relevance: 0.72
    created_at: "2026-05-22T12:30:00+00:00"
```

### Metadata update behavior

- Created on first run in the session (implicit creation)
- Updated after each run (append run record, update `updated_at`, increment `runs_total`)
- Best-effort: failed metadata write produces a limitation on the run but does not block evidence generation
- Append-only: run records are never modified after creation

### Corrupted metadata recovery

If `session.yaml` is missing or corrupted, the session summary generator reconstructs metadata by scanning run directories:
1. List `<session-id>/runs/*/`
2. Read `search-run.json` from each run directory
3. Reconstruct run records from JSON
4. Write recovered `session.yaml`

This is best-effort. If a run directory has no `search-run.json`, it is skipped with a limitation.

## Session summary (session-summary.md)

Generated on demand. Mechanical aggregation of all run results.

### Structure

```markdown
# Session Evidence Index

## Session Metadata

- **Topic:** building AI coding-agent operating systems
- **Session ID:** 20260522T120000Z-abc123def456
- **Created:** 2026-05-22T12:00:00Z
- **Updated:** 2026-05-22T12:45:00Z
- **Runs:** 3
- **Unique sources:** 15 (19 total, 4 duplicates across runs)

## Run History

| # | Query | Provider | Sources | OK | Failed | Best Rel | Time |
|---|-------|----------|---------|----|--------|----------|------|
| 1 | building AI agents architecture | searxng | 8 | 7 | 1 | 66% | 12:00 |
| 2 | AI agent tool use patterns | llms | 5 | 3 | 2 | 58% | 12:15 |
| 3 | LangChain agent architecture | searxng | 6 | 6 | 0 | 72% | 12:30 |

## Unique Source Table

> Reading order: best_relevance desc, quality desc, authority desc (mechanical ordering, not AI judgment)

| # | Title | URL | Type | Auth | Official | Best Q | Best Rel | Runs | Evidence |
|---|-------|-----|------|------|----------|--------|----------|------|----------|
| 1 | LangChain Agents | ... | docs | 3/3 | yes | 3/3 | 72% | 3 | ... |
| ... | ... | ... | ... | ... | ... | ... | ... | ... | ... |

## Source Snippets

> First 1000 characters per unique source. No synthesis.

### 1. LangChain Agents
- **URL:** ...
- **Authority:** 3/3 | **Quality:** 3/3 | **Best Relevance:** 72% | **Runs:** 3

```
[mechanical snippet from evidence pack]
```

## Cross-Run Overlap

Sources appearing in multiple runs:

| URL | Runs | Status |
|-----|------|--------|
| example.com/docs/agents | 1, 3 | cached in run 3 |
| example.com/blog/ai-agents | 1, 2 | cached in run 2 |

## Session Statistics

- **Total sources across all runs:** 19
- **Unique sources:** 15
- **Cross-run duplicates:** 4
- **Best evidence relevance:** 72%
- **Average evidence relevance (successful):** 48%

## Limitations

- Run 1: 1 blocked URL (private IP)
- Run 2: 2 failed fetches (timeout)
- Cross-run dedup is URL-based; semantically duplicate content at different URLs is not detected.

## Safety notice

[standard safety notice]
```

### Dedup rules for unique source table

- Dedup by `final_url` (or `normalized_url` if no final_url) across all runs
- If a source appeared in multiple runs, keep the evidence with highest quality + relevance
- `Runs` column shows which run numbers produced evidence for this source
- Cache hits reported in cross-run overlap section

### Reading order

Same mechanical ordering as compact summary, applied at session level:
1. `best_relevance` descending
2. `quality_score` descending
3. `authority_score` descending
4. `original_rank` ascending (from first run that found the source)

This is NOT AI ranking — it is a deterministic heuristic for source reading priority.

## Session and existing cache behavior

The existing SHA256-keyed cache already provides cross-run dedup at the fetch level. Run 2 fetching a URL from run 1 gets a cache hit.

Sessions make this VISIBLE:
- Session summary reports cache status per source
- Cross-run overlap section shows which sources were re-encountered
- Agent can see "URL X was already in the cache from a previous run"

Sessions do NOT add new cache logic. They report existing cache behavior.

## Session and existing dedup behavior

| Level | Mechanism | Scope | Behavior |
|-------|-----------|-------|----------|
| Run (existing) | Canonical URL dedup | Single run | Pre-fetch, marks duplicates |
| Run (existing) | Final-URL dedup | Single run | Post-fetch, mark/reference/skip |
| Session (new) | Final-URL dedup | All runs | Observational only, for summary |

Session-level dedup does NOT prevent re-fetching. The agent decides whether to use `--refresh`.

## Session and relevance

Each run computes its own evidence relevance scores. The session summary takes the **best** relevance score per source across all runs.

Why best (not average or most recent):
- If a source scored 65% in run 1 and 45% in run 2, the 65% is the most informative signal
- The query in run 1 had better term overlap with this source
- Averaging dilutes the signal; most recent loses better signals from earlier queries

Candidate relevance is NOT aggregated at session level — it is query-specific and run-scoped.

## Agent interaction model

### Start a session

Agent specifies a session topic/ID. First query creates the session directory and `session.yaml`. Implicit creation — no separate "create session" step.

### Add runs

Each search-query with the session specified adds a run. Run uses the session's `runs/` subdirectory. Session metadata is updated after each run. The run uses the shared cache directory (not session-scoped).

### View session state

Agent requests session summary. krn-search reads session metadata and all run artifacts, generates the cross-run accumulated view.

### Close a session

Optional. Agent marks the session as `closed` in metadata. No enforcement — the session directory persists. Closure is informational only.

### Error handling

| Failure | Behavior |
|---------|----------|
| Session metadata write fails | Log limitation on the run. Run artifacts still produced. |
| Session summary generation fails | Report error with recovery suggestion (individual run summaries). |
| Corrupted session metadata | Reconstruct from run artifacts (best-effort). |
| Missing run artifact | Skip run in summary with limitation. Other runs unaffected. |

## Session-level signals

### What the session produces (mechanical)

| Signal | Source | Description |
|--------|--------|-------------|
| Unique source count | Final-URL dedup across runs | Distinct sources found |
| Best relevance per source | Per-run relevance scores | Highest relevance across all runs |
| Cross-run overlap | URL matching across runs | Sources appearing in multiple runs |
| Query record | Session metadata | What queries were tried, with what providers |
| Provider outcomes | Session metadata | Which providers produced which results |
| Session statistics | Aggregation | Totals, rates, best/worst scores |

### What the session does NOT produce

- Query recommendations ("you should search for X")
- Relevance analysis ("evidence is insufficient for your question")
- Research completeness assessment
- Source synthesis or comparison
- Any AI-driven judgment

## Alternatives considered

### Alternative 1: No session — agent accumulates manually

Agent calls search-query multiple times and tracks results in its context.

**Rejected because:** Agent context is limited and lossy (context compression). Cross-run dedup in context is error-prone. Session infrastructure gives the agent persistent, inspectable accumulation.

### Alternative 2: Session as database (SQLite)

Store session state in SQLite for efficient querying.

**Rejected because:** CLAUDE.md hard non-goal: "SQLite, database storage." Session state as files is consistent with the project's file-based philosophy and enables direct inspection without tooling.

### Alternative 3: Session tracking in the Claude Code skill

The skill tracks session state in a markdown file; the agent manages it.

**Rejected because:** The skill would need to parse search-run JSON, track URLs across runs, and generate cross-run summaries — complex logic that belongs in krn-search. Skills should consume krn-search output, not reproduce its aggregation logic.

### Alternative 4: Implicit sessions via shared work-dir

Multiple runs already share a work-dir. Just add a summary generator.

**Partially accepted:** Sessions are essentially a shared work-dir with metadata. But implicit sessions lack identity (what topic? what queries?) and make concurrent research topics harder. Explicit session identity is worth the small additional surface.

## Risk analysis

| Risk | Likelihood | Mitigation |
|------|-----------|------------|
| Session metadata grows unbounded | Low | Sessions bounded by run count (agent decides when to close). Metadata is summary, not full content. |
| Corrupted metadata blocks runs | Medium | Metadata writes are best-effort. Runs continue without session tracking. Recovery from run artifacts. |
| Session summary expensive to generate | Low | Mechanical aggregation of existing files. No network, no AI. |
| Session encourages over-researching | Medium | Session is observational, not prescriptive. Agent drives strategy. |
| Cross-run URL dedup misses semantic duplicates | High | Accepted limitation. URL dedup is mechanical. Semantic dedup requires AI (out of scope). |
| Session directory structure conflicts with existing convention | Low | Sessions add one directory level under `sessions/`. Non-session runs unchanged. |

## Staged implementation

### MVP-1R.1 — Session directory and metadata

- Define session directory structure and creation logic
- Implement `session.yaml` read/write/append
- Wire session into search-query (accept session identifier, store run in session directory)
- Session metadata updated after each run
- Shared cache directory (not session-scoped)
- Corrupted metadata recovery
- Tests: session creation, metadata update, multi-run accumulation, recovery

### MVP-1R.2 — Session summary

- Cross-run unique source table (dedup by final_url)
- Per-source best relevance and quality
- Source snippets (cross-run deduplicated)
- Run history table
- Cross-run overlap report
- Session statistics
- CLI surface for summary generation (design in R.2 task)
- Tests: summary generation, dedup, multi-run aggregation, edge cases

### MVP-1R.3 — Dogfood

- Run real research scenarios using sessions
- Verify session summary quality and usefulness
- Verify cross-run dedup visibility
- Verify agent experience
- Record findings
- No code changes expected from dogfood

### Later stages (explicitly post-MVP-1R)

- Evidence gap analysis (mechanical: which query terms had no high-relevance evidence)
- Provider effectiveness tracking (which provider worked best for which queries)
- Session export (package session for sharing or archival)
- Evidence ledger (append-only record of searches, findings, rejections)
- Evidence graph (cross-reference and citation tracking)

## Relationship to existing artifacts

| Artifact | Scope | Produced by | Session impact |
|----------|-------|-------------|----------------|
| Evidence pack (.md) | Single URL | fetch pipeline | Unchanged. Stored in session run directory. |
| Fetch-list manifest (.md) | Single run | fetch-list | Unchanged. Stored in session run directory. |
| Search-run manifest (.md) | Single run | search pipeline | Unchanged. Stored in session run directory. |
| Discovery diagnostics (.json) | Single run | discovery pipeline | Unchanged. Stored in session run directory. |
| Compact summary (.md) | Single run | compact pipeline | Unchanged. Stored in session run directory. |
| search-run.json | Single run | CLI JSON output | Unchanged. Stored in session run directory. |
| session.yaml | Session (new) | session layer | New. Session metadata. |
| session-summary.md | Session (new) | session layer | New. Cross-run accumulated view. |

No existing artifact schema changes. Sessions add two new artifact types at a higher level.
