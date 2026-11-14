# Operating Model

This project is `krn-search`, with a repo-local Codex workflow layer for disciplined implementation, review, and handoff.

## Layers

1. `AGENTS.md`: always-active repo contract.
2. `.codex/skills`: conditional workflows that load only when relevant.
3. `.codex/agents`: narrow subagent roles for exploration, implementation, and review.
4. `docs/agents`: durable explanations of the operating model.
5. `.claude` and `CLAUDE.md`: existing Claude Code workflow surfaces; keep them separate from Codex runtime assumptions.

## Default Flow

1. Clarify the outcome and proof level.
2. Inspect the real repo state, starting from `CLAUDE.md`, `notes/PROJECT_STATE.md`, and `notes/ACTIVE_TASK.md`.
3. Select a skill.
4. Use `$grill` when language, ownership, architecture, or acceptance criteria are still fuzzy.
5. Slice work into vertical beads.
6. Implement or delegate independent beads.
7. Verify with exact commands.
8. Review before claiming completion.
9. Handoff if context must survive.
