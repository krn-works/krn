# MVP-1G.1 No-WebSearch Dogfooding & Guard Verification

**Date:** 2026-05-12
**Baseline commit:** `fa02b3a` (fix: switch websearch guard to deny-with-recovery mode)
**Uncommitted changes:** 13 files (MVP-1G.0 work in progress — not committed)

## Summary

All core verification items PASS. krn-search operates correctly in No-WebSearch mode. One friction item identified: `--provider auto` failure path does not emit JSON to stdout when `--json` is requested.

## Test Suite

**Result: PASS — 512/512 tests passed** (14.48s)

Breakdown:
- 20 hook guard tests
- 20 health tests
- 11 search JSON tests
- 3 work-dir integration tests
- 9 postcommit hook tests
- 449 existing tests

## Hook Verification

**Result: PASS**

- `build_response` returns `permissionDecision: "deny"` for both WebSearch and WebFetch
- Reason contains krn-search recovery commands:
  - `krn-search search-query ... --provider searxng`
  - `krn-search search-query ... --provider static --candidate-url`
  - `krn-search fetch-url ...`
  - `/krn-search-research <question>`
- Reason contains "Do not retry WebSearch/WebFetch"
- Reason does NOT mention WebSearch approval or fallback
- Stdin integration: valid JSON output, malformed/empty input handled safely
- Bash/Read/other tools return `None` (not blocked)

## Health Check JSON

**Result: PASS**

```json
{
  "schema_version": "0.1",
  "overall": "ok",
  "checks": [
    {"name": "package_import", "status": "ok"},
    {"name": "static_provider", "status": "ok"},
    {"name": "searxng_reachable", "status": "info", "message": "SEARXNG_URL not configured"},
    {"name": "evidence_writable", "status": "ok"},
    {"name": "objects_writable", "status": "ok"}
  ]
}
```

All fields present. `overall: "ok"` as expected (no SEARXNG configured, static provider available).

## CLI search-query — Auto Provider

**Result: FRICTION — stderr-only, no JSON on stdout**

```
error: --provider auto: no candidate URLs provided and SearXNG unreachable
  SearXNG URL: http://localhost:9999
  Set SEARXNG_URL environment variable or provide --candidate-url
```

Exit code: 1

**Assessment:** The CLI printed the error to stderr and exited with code 1. No JSON was emitted to stdout despite `--json` being requested.

**Classification:** Friction item, not a dogfooding failure. Docelowo `--json` should produce valid JSON on the failure path as well. **Candidate for MVP-1G.2.**

## CLI search-query — Static Fallback (Live Smoke)

**Result: PASS**

Valid JSON output with:
- `status: "ok"`
- `discovery.provider: "static"`, `candidates_total: 1`, `selected_for_fetch: 1`
- `evidence_results[0].url: "https://docs.python.org/3/library/http.server.html"`
- `evidence_results[0].status: "success"`, `quality_score: 3`
- `evidence_results[0].cache_status: "miss"`
- `failures: []`
- `recovery.websearch_allowed: false`

**Note:** Live smoke test — requires network access to docs.python.org. Not deterministic.

## Work-dir Artifact Isolation

**Result: PASS**

Actual layout under `/tmp/krn-dogfood-static/`:

```
cache/
  entries/2abf146ab93f026648c1a185999c10c4.json     # cache metadata
  objects/48c16d49...                                # cached body (SHA256-keyed)
runs/
  20260512T091643Z-3e81135f382b/
    search-run.json                                  # run manifest (JSON)
    evidence/
      docs-8fae9440670993da.md                       # evidence pack
      manifest-20260512T091644Z-8fae94406709.md      # fetch-list manifest
      search-20260512T091644Z-d10a57b38da9.md        # search-run manifest (markdown)
```

All artifacts confined to work-dir. Cache uses SHA256-keyed entries. Run artifacts isolated under timestamped run ID. Evidence packs contain valid YAML frontmatter with schema_version, URLs, and content hash.

No artifacts created outside work-dir. Auto provider failure (step 5) did not create a work-dir at all (expected — failure before artifact generation).

## Forbidden Phrases Audit

### Main source (search_tool/, CLAUDE.md, .claude/commands/, skills/krn-search-research/SKILL.md)

| File | Line | Phrase | Classification |
|------|------|--------|----------------|
| `CLAUDE.md` | (usage policy) | "Do not fall back to WebSearch. Do not ask for WebSearch approval." | **Acceptable policy mention** (negation) |
| `.claude/commands/krn-search-research.md` | 7 | "Do not suggest WebSearch fallback." | **Acceptable policy mention** (negation) |

### Skills, evals, and notes (broader scope)

| File | Phrase | Classification |
|------|--------|----------------|
| `.claude/skills/krn-search-research/evals/evals.json` | ~~"suggest WebSearch fallback" in expected_output~~ | **Fixed in MVP-1G polish** — eval updated to deny-with-recovery language |
| `.claude/skills/krn-search-research-workspace/skill-snapshot/SKILL.md` | "suggest WebSearch fallback" / "Fall back to WebSearch" | **Legacy workspace snapshot** (pre-deny mode) |
| `.claude/skills/krn-search-research-workspace/skill-snapshot/evals/evals.json` | "suggest WebSearch fallback" | **Legacy workspace snapshot eval** |
| `notes/MVP1F4_KRN_SEARCH_RESEARCH_SKILL_DOGFOODING.md` | "ask whether to fall back to WebSearch" | **Legacy note** (pre-deny mode documentation) |
| `notes/DECISION_CANDIDATES.md` | ~~"ask the user whether to fall back to WebSearch"~~ | **Fixed in MVP-1G polish** — decisions superseded with updated status |
| `notes/MVP1F3_CLAUDE_CODE_SKILLS_RULES_DESIGN.md` | "ask user whether to fall back to WebSearch" | **Legacy design doc** (pre-deny mode) |

**No true violations found.** All hits are either policy negations (correct) or legacy artifacts from before MVP-1G.0 deny-with-recovery mode.

## Remaining Friction

1. **`--json` failure path**: When `--provider auto` fails, the CLI prints to stderr without JSON. A `--json` caller cannot parse the error programmatically. Candidate for MVP-1G.2.

2. **Legacy eval/workspace snapshots**: `.claude/skills/krn-search-research/evals/evals.json` and `.claude/skills/krn-search-research-workspace/` contain pre-deny-mode language. These should be updated to reflect deny-with-recovery policy. Docs-only cleanup, no code changes needed.

3. **SEARXNG_URL default**: Auto provider tries `http://localhost:9999` as default SearXNG URL, which is unlikely to be correct in most environments. The error message correctly explains this, but the default could be confusing.

## Recommended Next Task

**MVP-1G.2 — `--json` structured failure output.** When `--json` is requested and the command fails (e.g., auto provider unavailable), emit a valid JSON error object to stdout with status `"error"`, error message, and recovery hints. This makes `--json` a reliable machine-readable interface for both success and failure paths.

Alternative: **MVP-1G.2 — Legacy docs cleanup.** Update evals, workspace snapshots, and historical notes to reflect deny-with-recovery policy. Docs-only, no code changes.
