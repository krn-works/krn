# MVP-1P.2 — Workflow Skills

**Status:** Complete
**Date:** 2026-05-21
**Baseline:** 4e1ad9f (main), 922/922 tests, 11/11 eval.

## Goal

Add three Claude Code workflow skills for krn-search: diagnose, design-grill, handoff.

## Changes

### New skills (`.claude/skills/`)

1. **krn-search-diagnose** — Bug/diagnostic workflow. Enforces deterministic feedback loop before fixes. Phases: reproduce → inspect diagnostics → form hypotheses → minimal fix → verify → regression test → review packet.

2. **krn-search-design-grill** — Design-only workflow. Reads CLAUDE.md + PROJECT_STATE.md + ACTIVE_TASK.md first, checks existing architecture, produces structured design proposals. No code implementation.

3. **krn-search-handoff** — Session handoff artifact. Writes to `.local/krn-search-handoffs/` (gitignored, uncommitted; OS temp dir as fallback). Includes SHA, recent PRs, active task, risks, verification state. Redacts secrets.

### Template mirrors (`search_tool/templates/claude/skills/`)

All three skills mirrored to packaged templates for `init-claude` distribution.

### Bootstrap update (`search_tool/bootstrap.py`)

- Added 3 new template constants: `TEMPLATE_SKILL_DIAGNOSE`, `TEMPLATE_SKILL_DESIGN_GRILL`, `TEMPLATE_SKILL_HANDOFF`
- Updated `MANAGED_FILES` and mappings to include new skills
- init-claude now copies 5 files (2 research + 3 workflow) instead of 2

### Tests (`tests/test_init_claude.py`)

- Updated file counts: 2 → 5 (default), 3 → 6 (with hook)
- Added `TestInitClaudeWorkflowSkills` class with 3 tests verifying guardrails:
  - diagnose: deterministic feedback loop, hypotheses, review packet
  - design-grill: no code implementation, reads required docs
  - handoff: `.local/krn-search-handoffs/`, gitignored, OS temp fallback, redact secrets

## Verification

- Tests: 925/925 (922 baseline + 3 new)
- Eval-corpus: 11/11
- No runtime changes
- No hooks or git guardrails
- No MVP-1Q.1 implementation
