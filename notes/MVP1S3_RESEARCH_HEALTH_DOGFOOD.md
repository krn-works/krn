# 2026-05-24 — MVP-1S.3 Dogfood Research Health and Operator UX

## Goal

Dogfood the research-mode required SearXNG operator workflow end-to-end for:

- unreachable SearXNG (`--research` health and `search-query --research`),
- explicit known-URL override behavior,
- reachable-path parity if available locally,
- `--searxng-url` override precedence.

## Scope

- No code changes unless dogfood finds a blocker.
- No schema/provider dependency refactors.
- No native/public web fallback.
- No generated `.local/...` artifacts committed.

## Commands and outcomes

### A) Unreachable SearXNG baseline (`http://localhost:19999`)

- `SEARXNG_URL=http://localhost:19999 .venv/bin/python -m search_tool health --research`
  - Exit code: `1`
  - Human output: fail with
    - `searxng_reachable: research mode requires SearXNG discovery, but SearXNG is unreachable at http://localhost:19999 (source: SEARXNG_URL).`

- `SEARXNG_URL=http://localhost:19999 .venv/bin/python -m search_tool health --research --json`
  - Exit code: `1`
  - JSON `overall`: `"fail"`
  - JSON check entry: `checks[].name == "searxng_reachable"` and `status == "fail"`.

- `SEARXNG_URL=http://localhost:19999 .venv/bin/python -m search_tool search-query "python http client documentation" --research --work-dir .local/krn-search-runs-s3-dogfood`
  - Exit code: `1`
  - stderr/main message includes research-mode SearXNG unreachable guidance and recovery command `krn-search health --research`.
  - JSON `failures[0].stage == "provider_resolution"` with `reason` about unreachable SearXNG.
  - Recovery JSON:
    - `next_action`: includes `Run \`SEARXNG_URL=http://localhost:19999 krn-search health --research\``.
  - Artifacts: no `.local/krn-search-runs-s3-dogfood` directory created (confirmation check: `DIR_MISSING`).

### B) Explicit known-URL override

- `.venv/bin/python -m search_tool search-query "python requests documentation" --research --provider static --candidate-url "https://requests.readthedocs.io/en/latest/" --work-dir .local/krn-search-runs-s3-dogfood --session "s3 known url override"`
  - Exit code: `0`
  - Output confirms `discovery.provider == "static"` and `selected_for_fetch == 1`.
  - Evidence produced with `session.session_id` and `run` files under:
    - `.local/krn-search-runs-s3-dogfood/sessions/session-10e5c89d615d/runs/20260524T163949Z-d2e21b73c264/evidence/`

### C) Reachability check without override

- `.venv/bin/python -m search_tool health --research`
  - Exit code: `1` in this environment.
  - Output source: `http://localhost:9999` (default) unreachable.
  - Conclusion: local reachable SearXNG not available now; scenario C1 (real query with reachable instance) not executed due environment limitation.

### D) Override precedence (optional)

- `SEARXNG_URL=http://localhost:19999 .venv/bin/python -m search_tool health --research --searxng-url http://localhost:19998 --json`
  - Exit code: `1`
  - Message/JSON check: `searxng_reachable` references `http://localhost:19998`.
  - Source explicitly reported as `--searxng-url`.

## Decision

- `ACCEPT_MVP1S2_OPERATOR_UX`

## Follow-up candidates

- No blockers found in operator UX for current slice.
- Optional next dogfood: rerun A/B once a real local SearXNG endpoint is available (to capture reachable `--research` operator experience).
