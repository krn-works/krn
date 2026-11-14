# MVP-1S.1 — Research Provider Resolution and Error UX

**Date:** 2026-05-24
**Status:** Implemented
**Scope:** Implement `--research` auto-provider behavior and operator error UX while preserving non-research legacy behavior.

## Goal

Ensure research mode treats SearXNG as the only automatic discovery provider and fails
clearly when it is unreachable, with no silent fallback to static and no run/session
artifacts created on provider-resolution failure.

## Required behavior delivered

- `krn-search search-query "<query>" --research` resolves `provider=auto` to `searxng` only.
- `krn-search search-query "<query>" --research --provider auto` follows identical SearXNG-only behavior.
- `krn-search search-query "<query>" --research --candidate-url "<url>"` does **not** auto-select static.
  It fails with guidance to use:

  ```bash
  --research --provider static --candidate-url "<url>"
  ```

- `krn-search search-query "<query>" --research --provider static --candidate-url "<url>"` remains
  explicitly supported.
- Non-research behavior remains unchanged: `--provider auto --candidate-url "<url>"` resolves to
  `static` as before.

## Error UX delivered

For unreachable SearXNG in research mode, stderr now includes:

- `error: research mode requires SearXNG discovery, but SearXNG is unreachable.`
- effective endpoint and source line: `SearXNG URL: <url> (source: <source>)`
- `No fallback provider was used. Static provider is only an explicit known-URL override.`
- health / retry / manual override guidance.
  In S.1, health guidance now points to `krn-search health --research` for research recovery (`SEARXNG_URL=<url> krn-search health --research`).

JSON error output remains top-level schema-compatible and includes:

- `status: error`
- `failures[0].stage: provider_resolution`
- reason mentioning `research mode requires SearXNG`
- limitations that include: no fallback provider, no public/native web search, no LLM-generated URL candidates
- `recovery.websearch_allowed: false`

## Deterministic tests added

- `tests/test_research_mode.py::TestResearchModeEdgeCases`
  - `test_research_provider_auto_requires_reachability`
  - `test_research_provider_auto_option_has_same_reachability`
  - `test_research_candidate_url_does_not_imply_static`
  - `test_research_static_explicit_override_stays_supported`
  - `test_non_research_auto_candidate_url_uses_static`
  - existing no-generated-files test retained to guard repository root artifact behavior.

## Files changed

- `search_tool/cli.py`
- `tests/test_research_mode.py`
- `notes/ACTIVE_TASK.md`
- `notes/PROJECT_STATE.md`
- `notes/EXPERIMENT_LOG.md`
- `notes/MVP1S1_RESEARCH_PROVIDER_RESOLUTION.md`

## Validation

- Added deterministic S.1 edge tests with mocked SearXNG reachability checks.
- `.venv/bin/python -m pytest -q` -> 1057 passed
- `.venv/bin/python -m search_tool eval-corpus tests/fixtures/search_corpus/basic.json` -> 11/11 passed
