---
name: handoff
description: Prepare compact continuation context for another Codex session or subagent. Use before context compaction, session reset, delegation, long-running work pauses, or when the next agent needs exact state without reading the full transcript.
---

# Handoff

Write a short, factual continuation note. Do not duplicate artifacts that already exist; reference paths, commits, PRs, issues, and commands.

## Include

- **Objective:** the current goal in one sentence.
- **Current state:** what exists now, including changed files and important runtime/process state.
- **Decisions:** only durable decisions that a future agent must not re-litigate.
- **Evidence:** exact commands/checks already run and their outcome.
- **Next steps:** ordered, concrete actions.
- **Suggested skills:** which skills the next agent should invoke and why.
- **Risks:** known unknowns, unverified surfaces, and anything intentionally out of scope.

## Exclude

- Long transcripts.
- Sensitive values, tokens, cookies, private keys, or credentials.
- Generic advice.
- Speculative ideas not needed for the next action.

## Storage

For temporary handoffs, write outside the repo in the OS temp directory. For durable project handoffs, write under the repo only when the user asks or when the repo already has a handoff convention.

Read `references/handoff-template.md` for a compact template.
