# MVP-1R.3 — Research Session Dogfood

**Date:** 2026-05-22  
**Status:** Dogfood complete (docs-only)  
**Scope:** End-to-end session workflow validation using existing CLI surfaces only.

## Goal

Validate the implemented research session workflow end to end:
- create a session,
- run multiple `search-query --research --session` runs,
- generate `session-summary`,
- inspect session metadata and run artifacts,
- evaluate usefulness and awkward points.

## Commands executed

```bash
krn-search search-query "research session directory metadata yaml" --research --session "mvp-1r3-dogfood-research-sessions" --work-dir ".local/krn-search-runs-r3-dogfood" --json
krn-search search-query "session summary snippets overlap relevance" --research --session "mvp-1r3-dogfood-research-sessions" --work-dir ".local/krn-search-runs-r3-dogfood" --json
krn-search session-summary --work-dir ".local/krn-search-runs-r3-dogfood" --session "mvp-1r3-dogfood-research-sessions"
```

## Environment note

Initial attempt with default `--research` provider (`auto`) failed in this environment because local SearXNG was unreachable:

```text
--provider auto: no candidate URLs provided and SearXNG unreachable (SearXNG URL: http://localhost:9999)
```

To complete dogfood without code changes, runs were repeated with explicit override:
- `--provider static`
- `--candidate-url ...` (controlled URLs)

This is consistent with current CLI behavior where explicit flags override research defaults.

## Session artifacts inspected

- Work dir: `.local/krn-search-runs-r3-dogfood`
- Session topic: `mvp-1r3-dogfood-research-sessions`
- Session ID: `session-966dbe334942`
- Session metadata: `.local/krn-search-runs-r3-dogfood/sessions/session-966dbe334942/session.yaml`
- Run artifacts:
  - `.local/krn-search-runs-r3-dogfood/sessions/session-966dbe334942/runs/20260522T175043Z-155cb676cac4/search-run.json`
  - `.local/krn-search-runs-r3-dogfood/sessions/session-966dbe334942/runs/20260522T175045Z-4912bf464c2a/search-run.json`
- Summary:
  - `.local/krn-search-runs-r3-dogfood/sessions/session-966dbe334942/session-summary.md`

## Acceptance check

1. At least one dogfood session created: **PASS** (`session-966dbe334942`)
2. At least two runs in same session: **PASS** (`runs_total: 2`)
3. `session-summary.md` generated: **PASS**
4. Summary includes run history, unique sources, relevance, overlap, snippets: **PASS**
5. Report covers what worked, awkward points, candidate fixes: **PASS** (this document)
6. Generated artifacts not committed: **PASS** (verified via git status in review packet)
7. Final output docs-only unless blocker: **PASS** (no code changes)

## What worked

- Session creation and deterministic session ID worked as designed.
- Two runs appended to one session and updated `session.yaml` correctly.
- `session-summary` rendered required sections:
  - Session metadata
  - Run history
  - Cross-run unique sources
  - Source relevance
  - Source snippets
  - Cross-run overlap report
- Snippets were populated mechanically from run artifacts/evidence and escaped into a stable markdown table.

## What was awkward

1. Research preset dependency on local SearXNG in this environment.
   - `--research` default path (`provider=auto`) fails quickly when SearXNG is unavailable and no fallback candidates are provided.
   - Workaround exists (`--provider static --candidate-url ...`) but reduces frictionless dogfood flow.

2. Run history numeric URL counters show zeros in this scenario.
   - `session-summary.md` showed `URLs Requested/Succeeded/Failed = 0` for both runs,
   - while run artifacts contained successful evidence and relevance/snippet rows.
   - This makes operational interpretation weaker during dogfood.

## Candidate fixes (follow-up, no implementation in R.3)

1. Improve `--research` resilience in non-SearXNG environments.
   - Option A: clearer guided limitation in output with explicit fallback command template.
   - Option B: controlled fallback provider path when auto discovery is unavailable.

2. Harden session-summary run-history counters for JSON artifact variants.
   - Derive run counters from available `evidence_results`/run metadata when top-level count fields are absent.
   - Keep behavior mechanical and schema-compatible.

## Verdict

`ACCEPT_MVP1R3_DOGFOOD_WITH_CANDIDATES`

Core session workflow is usable and produces required session-level evidence views. Two UX/data-shape rough edges were identified and documented as follow-up candidates; no blocker requiring immediate implementation was found in this slice.

## Verification

- `pytest -q`: fails in this environment at collection with `ModuleNotFoundError: No module named 'search_tool'` (import path / wrong launcher).
- `.venv/bin/python -m pytest -q`: 1052 passed.
- `.venv/bin/python -m search_tool eval-corpus tests/fixtures/search_corpus/basic.json`: 11/11.
- `git diff --check`: clean.
- `git status --short --branch`: generated `.local/krn-search-runs-r3-dogfood/` artifacts are not staged.
