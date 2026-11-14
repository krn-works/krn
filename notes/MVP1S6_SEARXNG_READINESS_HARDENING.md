# 2026-05-25 — MVP-1S.6 SearXNG Readiness Hardening

## Goal

Improve operator ergonomics for checking local SearXNG readiness before running
`search-query --research`, without changing research provider semantics.

## Scope

- Add a small readiness wait path to `krn-search health --research`.
- Keep default health behavior unchanged.
- Keep SearXNG required only for research discovery.
- Keep static provider as an explicit known-URL/manual/test override.

Out of scope: provider semantics, search-query behavior, public/native web
fallback, LLM-generated URL candidates, browser automation, Docker automation
in application code, new dependencies, evidence/run/session schema changes, and
session-summary changes.

## Selected design

`krn-search health --research --wait <seconds>`.

Reasons:

- It extends the existing operator preflight instead of adding a new command.
- It is more direct for readiness than exposing low-level retry counts.
- It keeps JSON and human output on the existing health report structure.
- It avoids any change to discovery or query execution semantics.

Rejected for this slice:

- `--retries` / `--retry-delay`: lower-level than the operator need and less
  ergonomic for "wait until ready".
- `krn-search smoke searxng`: larger CLI surface than needed for this hardening
  slice.

## Behavior

- `krn-search health --research` keeps the existing immediate/current check path.
- `krn-search health --research --wait 10` polls SearXNG until reachable or the
  wait window expires.
- `krn-search health --research --wait 0` is equivalent to the immediate check.
- `krn-search health --research --json --wait 10` preserves the normal health
  JSON structure and `overall` status.
- Non-research `krn-search health` remains unchanged.
- `--searxng-url` still takes precedence over `SEARXNG_URL`.

## Verification

- `.venv/bin/python -m pytest tests/test_health.py -q` -> `34 passed`
- `.venv/bin/python -m pytest tests/test_research_mode.py -q` -> `22 passed`
- `.venv/bin/python -m pytest -q` -> `1069 passed`
- `.venv/bin/python -m search_tool eval-corpus tests/fixtures/search_corpus/basic.json` -> `11 passed`
- `git diff --check` -> clean
- `git status --short --branch` -> expected modified files only
