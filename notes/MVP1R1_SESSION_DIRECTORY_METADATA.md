# MVP-1R.1 — Session Directory and Metadata

**Date:** 2026-05-22
**Status:** Implementation complete. Pending review.
**Scope:** Session directory structure, session.yaml read/write/append, wiring into search-query, corrupted metadata recovery.

## Summary

Implements the first implementation slice of the research session layer. A session groups multiple search-query runs under a shared topic with metadata tracking in session.yaml. Runs are stored in the session directory, cache remains shared, metadata writes are best-effort.

## Scope

### In scope

- Session directory structure: `<work-dir>/sessions/<session-id>/runs/<run-id>/`
- session.yaml read/write/append (manual YAML serializer/parser)
- Corrupted metadata recovery from run artifacts
- `--session <topic>` flag on search-query
- Session info in JSON output (additive `session` key)
- Shared cache (not session-scoped)
- 44 new tests

### Out of scope (R.2+)

- Session summary generation (cross-run unique source table, snippets, statistics)
- Session close command
- AI synthesis
- Provider refactor
- New dependencies
- MCP/hooks

## Files changed

| File | Change |
|------|--------|
| `search_tool/session.py` | **New.** Session module (220 lines) |
| `search_tool/cli.py` | Modified. +71 lines: --session flag, session wiring, JSON output |
| `tests/test_session.py` | **New.** 44 tests |

No evidence schema changes. No manifest schema changes. No dependency changes.

## CLI surface

```
krn-search search-query "<query>" --session <topic> --research
krn-search search-query "<query>" --session <topic> --work-dir <dir> --provider <p> --json
```

- `--session <topic>` requires `--work-dir` or `--research`
- Empty topic rejected with error
- Without `--session`, behavior is identical to pre-R.1

## Session directory layout

```
<work-dir>/
  cache/                              # shared (unchanged)
  runs/                               # non-session runs (unchanged)
  sessions/
    <session-id>/
      session.yaml                    # session metadata
      runs/
        <run-id>/
          evidence/
            ...
          search-run.json
          discovery-diagnostics.json
          search-summary-*.md
          ...
```

## Session ID decision

**R.1 decision: deterministic `session-<topic_hash[:12]>`**

R.0 design specified `<timestamp>-<hash>`. R.1 changes this to `session-<sha256(topic)[:12]>` for determinism.

**Rationale:** The primary agent interaction is `--session "my research topic"`. Deterministic ID means same topic always maps to the same session directory. This is agent-friendly (no need to store/remember a session ID) and idempotent (re-running with the same topic appends to the existing session).

**Trade-off accepted:** Cannot create two independent sessions with the same topic without an additional override mechanism. This is a known limitation documented below. If needed, a future `--session-id <explicit-id>` override can be added without breaking the `--session <topic>` path.

**Why this differs from R.0:** R.0's `<timestamp>-<hash>` would generate a new session ID on every invocation, requiring the agent to store and pass back the session ID for subsequent queries. This adds state management burden for the agent with no clear benefit in the current single-agent workflow. The deterministic approach removes this burden.

## JSON output

Additive `session` key in search-query JSON output:

```json
{
  "session": {
    "session_id": "session-abc123def456",
    "topic": "my research topic",
    "run_number": 3,
    "metadata_status": "ok"
  }
}
```

- `session` is `null` when `--session` is not specified
- `metadata_status` is `"ok"` or `"write_failed"` (best-effort)

No other JSON output keys changed.

## session.yaml schema

```yaml
schema_version: "0.1"
session_id: "session-abc123def456"
topic: "research topic"
created_at: "2026-05-22T12:00:00+00:00"
updated_at: "2026-05-22T12:45:00+00:00"
status: "active"
runs_total: 3
runs:
  - run_id: "20260522T120000Z-abc123"
    query: "query text"
    query_sha256: "..."
    provider: "searxng"
    profile: "official-docs"
    status: "ok"
    sources_total: 8
    sources_succeeded: 7
    sources_failed: 1
    best_evidence_relevance: 0.66
    created_at: "2026-05-22T12:00:00+00:00"
```

Manual YAML serializer/parser. Single-pass left-to-right unescaping for double-quoted values. Parser handles only the format produced by `_serialize_yaml` — not arbitrary YAML.

## Recovery behavior

When session.yaml is missing or corrupted:

1. `load_session_metadata()` validates: `schema_version == "0.1"`, non-empty `session_id`, `session_id == session_dir.name`, non-empty `status`.
2. Invalid metadata returns `None` (treated as corrupted).
3. `update_session_metadata()` calls `recover_session_metadata()` when `load` returns `None`.
4. `create_session()` calls `recover_session_metadata()` when `load` returns `None`, fills topic from caller.
5. Recovery scans `<session-dir>/runs/*/search-run.json` from existing run directories.
6. Sets `status: "recovered"` and writes recovered session.yaml (best-effort).

Recovery is non-destructive: it never deletes run directories or artifacts.

### Corrupted metadata handling

`_parse_yaml()` is intentionally lenient — it does not raise exceptions for arbitrary text. Validation is a separate layer (`_validate_metadata()`) that checks:

- `schema_version` matches `SCHEMA_VERSION`
- `session_id` is non-empty and matches `session_dir.name`
- `status` is non-empty
- `runs_total` is an integer

This means arbitrary junk like `{{{{invalid yaml` or `hello world\nnot yaml` produces a `SessionMetadata` with empty/default fields that fails validation, correctly triggering recovery instead of silently accepting corrupted data.

## Verification

- Tests: 1037/1037 (993 baseline + 44 new)
- Eval corpus: 11/11
- `diff --check`: clean
- No new dependencies
- No evidence schema changes (v0.1)
- No manifest schema changes (v0.1)

## Known limitations

1. **Same-topic constraint:** Cannot create two independent sessions with the same topic. All queries with the same topic string append to the same session.
2. **Empty topic after recovery:** Recovered metadata cannot reconstruct the original topic (not stored in search-run.json).
3. **YAML parser is format-specific:** Only handles the exact format produced by `_serialize_yaml`.
4. **No session summary:** Cross-run aggregation is deferred to R.2.
5. **No session close:** Session status is always "active" (close is R.2+).

## Non-goals preserved

- No session summary / cross-run source table / snippets
- No AI synthesis
- No evidence schema changes
- No manifest schema changes
- No new dependencies
- No MCP/hooks
- No browser automation
- No database storage
