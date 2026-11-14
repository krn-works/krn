# Handoff: Codex Operating Layer

## Objective
Continue `krn-search` after MVP-1R.2 and the repo-local Codex workflow setup without re-reading the full merge/review transcript.

## Current State
- Branch: `main`.
- Current HEAD after docs-sync: `1294b3a87894d4fccde0bbd35ce640fe78b878f2`.
- Remote HEAD after Codex setup: `5dd21c9851356cba395e5018aa38df1d22b58d37`.
- MVP-1R.2 was squash-merged earlier as `b3a15f36acddfb99b477d5eda56a61d89181546e`.
- `.codex/config.toml`, `.codex/skills/*`, `.codex/agents/*`, `AGENTS.md`, and `docs/agents/*` are on `main`.
- `.claude/` and `CLAUDE.md` remain separate Claude Code surfaces.
- Cleanup removed local untracked artefacts `FIXES_SUMMARY.md` and `tests/test_session_summary_session_selection.py`.

## Decisions
- Use repo-local Codex skills rather than installing this pack globally.
- Keep the Codex operating layer separate from Claude Code runtime assumptions.
- Source snippets are deferred to MVP-1R.2a; R.2 owns summary tables, relevance, run history, overlap, metadata fallback limitations, and artifact-safe output.
- Codex native-web blocking is not yet proven deterministic; treat it as policy instruction until audited.

## Evidence
- `codex debug prompt-input "probe"` -> `AGENTS.md` appeared in model-visible context and project-local skills `coding-system`, `debug`, `grill`, `handoff`, `implementation`, and `review` appeared in the available skills list.
- `for d in .codex/skills/*; do python3 /home/krn/.codex/skills/.system/skill-creator/scripts/quick_validate.py "$d"; done` -> 6 skills valid.
- `python3 - <<'PY' ... tomllib ... PY` -> `.codex/config.toml` and `.codex/agents/*.toml` parse.
- `git diff --check` -> clean after Codex setup.
- Previous R.2 gate: `.venv/bin/pytest -q` -> 1049 passed; `.venv/bin/python -m search_tool eval-corpus tests/fixtures/search_corpus/basic.json` -> 11/11.

## Next Steps
1. Start a fresh Codex session from repo root and trust the project when prompted; confirm `/skills` or debug output sees repo-local skills.
2. Choose next project work: Codex policy enforcement audit, MVP-1R.2a snippets, or MVP-1R.3 dogfood.
3. Before implementing snippets or dogfood, use `$coding-system`; for enforcement uncertainty, use `$debug` or `$grill` first.

## Suggested Skills
- `$coding-system`: default for the next non-trivial project task.
- `$grill`: use for R.2a snippet scope or enforcement design before implementation.
- `$debug`: use for Codex policy enforcement audit if native web behavior must be reproduced.
- `$handoff`: use before context reset or delegation.

## Risks
- Codex deterministic enforcement for native web is unverified.
- R.2a snippets should not reopen R.2 summary scope beyond additive source excerpts.
