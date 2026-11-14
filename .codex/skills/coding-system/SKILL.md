---
name: coding-system
description: Orchestrate the full Codex coding workflow for high-quality shipping. Use when starting non-trivial feature work, repo setup, architecture work, multi-step fixes, research-to-implementation tasks, agent delegation, or any task where Codex should move from intent to verified delivery instead of answering casually.
---

# Coding System

Use this as the top-level operating loop. Keep the system small: load deeper skills only when the current task needs them.

## Core Loop

1. **Frame the outcome.** Convert the user's request into concrete acceptance criteria and proof levels. If the request is ambiguous, state the safest assumption and continue unless the assumption would be expensive or risky.
2. **Read reality first.** Inspect the current repo, docs, scripts, runtime, and relevant history before proposing changes. Prefer `rg`, `rg --files`, exact command output, and rendered/runtime proof over guesses.
3. **Pick the mode.**
   - Use `$debug` for bugs, stack traces, failing tests, runtime regressions, or "sprawdz" requests.
   - Use `$implementation` for features, refactors, config changes, and direct code edits.
   - Use `$review` before declaring work complete or when asked for a review.
   - Use `$handoff` when context must survive compaction, reset, or another agent.
4. **Slice the work.** Break work into vertical beads: each bead should produce a demonstrable behavior or a verified repository state. Avoid horizontal slices like "all docs", "all tests", then "all implementation" unless the task is purely documentation.
5. **Delegate only independent beads.** Use subagents for read-heavy exploration, isolated implementation with disjoint write sets, or independent review. Do not delegate broad ownership of the whole task.
6. **Verify before claims.** Run the narrowest meaningful checks first, then broader checks if the blast radius requires them. Report exact commands and what they proved.
7. **Ship or stop cleanly.** End with changed files, verification, residual risk, and the next concrete action. Never call local-only evidence production proof.

## Default Bead Shape

Use this shape when the user asks for a multi-step build:

```text
Bead: <small outcome>
Files/areas: <owned paths>
Acceptance: <observable behavior>
Proof: <command, test, HTTP check, screenshot, or runtime check>
Risk: <what could still be wrong>
```

Keep beads independent when possible. If two beads need the same file, run them sequentially or assign one owner.

## Proof Levels

Read `references/proof-levels.md` when the task involves runtime, production, UI, deploy, WordPress, external APIs, or anything where local code inspection is not enough.

## Codex Surfaces

Use Codex-native surfaces:

- `AGENTS.md` for always-active repo guidance.
- `.codex/skills/<name>/SKILL.md` for conditional workflows and domain procedures.
- `.codex/agents/*.toml` for subagent roles with narrow jobs.
- `docs/agents/` for durable project operating docs.

Do not copy Claude-specific paths blindly. Translate `.claude/skills`, `CLAUDE.md`, hooks, and slash-command assumptions into Codex equivalents.
