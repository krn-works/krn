# MVP-1S.2 — Research Health Check and Docs Sync

**Date:** 2026-05-24
**Status:** Completed

## Result

`ACCEPT_MVP1S2_RESEARCH_HEALTH_CHECK`

## Goal

Make `krn-search health` research-aware so that research-mode discovery can be validated directly from the CLI.

- `krn-search health` remains unchanged as a general health check.
- `krn-search health --research` requires SearXNG reachability.
- Add optional `--searxng-url` override for this health mode.
- Sync guidance in Claude/Codex research docs to stop implying that SearXNG is globally optional.

## Required behavior implemented

1. `krn-search health`
   - Preserves existing behavior.
   - Non-research SearXNG status remains informational/warn depending on env/default source.

2. `krn-search health --research`
   - Treats SearXNG as required.
   - Exits non-zero when SearXNG is unreachable.
   - Human output includes the required research wording.
   - JSON `overall` is `fail` when required SearXNG is unreachable.

3. `krn-search health --research --searxng-url <url>`
   - Overrides `SEARXNG_URL`.
   - Uses the supplied URL for health checks.

4. Research recovery UX
   - `search-query --research` unreachable SearXNG next actions now point to `SEARXNG_URL=<url> krn-search health --research`.

## Files updated

- `search_tool/health.py`
- `search_tool/cli.py`
- `tests/test_health.py`
- `tests/test_research_mode.py`
- `CLAUDE.md`
- `notes/ACTIVE_TASK.md`
- `notes/PROJECT_STATE.md`
- `notes/EXPERIMENT_LOG.md`
- `notes/MVP1S1_RESEARCH_PROVIDER_RESOLUTION.md`
- `.claude/commands/krn-search-research.md`
- `search_tool/templates/claude/commands/krn-search-research.md`
- `notes/MVP1S2_RESEARCH_HEALTH_CHECK.md`

## Validation plan

- `.venv/bin/python -m pytest tests/test_health.py -q`
- `.venv/bin/python -m pytest tests/test_research_mode.py -q`
- `.venv/bin/python -m pytest -q`
- `.venv/bin/python -m search_tool eval-corpus tests/fixtures/search_corpus/basic.json`
- `git diff --check`
- `git status --short --branch`
