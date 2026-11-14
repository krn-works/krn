# AGENTS.md

## Repository Contract

This repository is `krn-search`: a minimal URL-to-evidence-pack tool for controlled untrusted web ingestion. It is not a search engine, synthesis system, database, browser automation stack, or agent framework.

Codex uses repo-local workflow surfaces from `.codex/`: skills, subagents, and config. Claude Code surfaces remain under `.claude/` and `CLAUDE.md`; do not collapse the two systems into one file or one runtime assumption.

## Startup

Start from the project state, not broad exploration.

Read first:
1. `CLAUDE.md`
2. `notes/PROJECT_STATE.md`
3. `notes/ACTIVE_TASK.md`

Then inspect only files required by the active task. If broader exploration is needed, state why before doing it.

## Working Agreements

- Use repo-local Codex surfaces: `.codex/skills`, `.codex/agents`, `.codex/config.toml`, and this `AGENTS.md`.
- Keep `CLAUDE.md` concise and compatible with existing Claude Code workflow; use this file for Codex-specific operating rules.
- Prefer concise skills with progressive disclosure over large always-loaded instructions.
- Before editing, state the current bead, expected files, and proof.
- Verify changes with exact commands. If verification is blocked, say what blocked it.
- Do not overwrite unrelated user changes.
- Do not run destructive git commands unless the user explicitly asks.
- Do not add production dependencies without checking existing repo patterns and explaining the reason.

## Skill Map

- `$coding-system`: top-level workflow for turning intent into verified delivery.
- `$grill`: stress-test plans against project language, code reality, `CONTEXT.md`, and ADRs.
- `$debug`: bugs, broken runtime, stack traces, regressions, and reproduction-first fixes.
- `$implementation`: surgical feature/refactor/config implementation.
- `$review`: defect-oriented review before shipping or after subagent work.
- `$handoff`: compact continuation context for reset, compaction, or delegation.

## Proof Levels

Use the proof level that matches the claim: static, unit, integration, runtime, rendered, remote, or production. Never present lower-level proof as higher-level proof.

For this repo, common gates are:

- `$PYTHON_BIN -m pytest`
- `$PYTHON_BIN -m search_tool eval-corpus tests/fixtures/search_corpus/basic.json`
- `git diff --check`

Use the Python launcher guidance in `CLAUDE.md` for local verification.

## krn-search Policy

Use `krn-search search-query "<query>" --research` for web research, URL ingestion, source verification, and evidence generation.

Claude Code has hook-policy enforcement for native WebSearch/WebFetch in this repo. For Codex, treat this as repo policy instruction until a separate enforcement audit confirms deterministic blocking through Codex requirements, hooks, or wrapper configuration.

krn-search produces evidence artifacts, not answers. Base claims only on evidence pack content, local files, or user-provided sources. If evidence is insufficient, report the limitation honestly.

Do not commit generated evidence/cache artifacts. Do not bypass URL policy.

## Non-Goals

- No AI synthesis or inference in evidence generation.
- No schema changes unless an active task explicitly authorizes them.
- No SQLite/database storage.
- No MCP server, agent framework, browser rendering, dashboard, or API server.
- No new runtime dependencies without task-level approval.
