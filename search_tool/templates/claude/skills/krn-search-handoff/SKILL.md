---
name: krn-search-handoff
description: >
  Create a session handoff artifact for krn-search work. Use when ending a work session,
  switching context, or preparing state for a future conversation. Writes handoff to
  `.local/krn-search-handoffs/` (uncommitted, gitignored) — never commits to the repo
  unless explicitly asked. Use when the user says "handoff", "wrap up", "session summary",
  "what did we do", "leaving", "done for today", or wants a portable summary of current
  work state.
---

# krn-search-handoff

Session handoff artifact for krn-search. Captures current state for the next conversation.

## When to use

- Ending a work session
- Switching to a different task
- Preparing state for a future conversation
- Before closing Claude Code

## When NOT to use

- During active implementation (use krn-search-implementation)
- During active diagnosis (use krn-search-diagnose)
- During design (use krn-search-design-grill)

## Process

### Step 1: Gather state

Collect current state without modifying any files:

```bash
git rev-parse HEAD
git log --oneline -5
git branch --show-current
git status --short
```

Read:
1. `notes/ACTIVE_TASK.md` — current task status
2. `notes/PROJECT_STATE.md` — overall project state
3. `CLAUDE.md` — project identity and constraints

### Step 2: Assess verification state

Run verification commands:

```bash
if [ -x .venv/bin/python ]; then PYTHON_BIN=.venv/bin/python; else PYTHON_BIN=python3; fi
$PYTHON_BIN -m pytest -q --tb=no 2>&1 | tail -1

krn-search eval-corpus tests/fixtures/search_corpus/basic.json --work-dir "$(mktemp -d)" 2>&1 | tail -1
```

Record pass/fail counts.

### Step 3: Identify open risks

Based on ACTIVE_TASK.md and recent work, list:
- Unresolved issues or blockers
- In-progress work that needs continuation
- Known limitations that might bite next session
- Stop conditions from the active task that haven't been verified

### Step 4: Write handoff artifact

Write to `.local/krn-search-handoffs/` in the repo working tree. This directory is local, gitignored, and uncommitted.

```bash
HANDOFF_DIR=".local/krn-search-handoffs"
mkdir -p "$HANDOFF_DIR"
HANDOFF_FILE="$HANDOFF_DIR/handoff-$(date +%Y%m%d-%H%M%S).md"
```

If the directory cannot be created, fall back to OS temp dir and print the absolute path clearly.

Write the handoff markdown to `$HANDOFF_FILE` containing:

```markdown
# krn-search session handoff

**Date:** <current date>
**Branch:** <current branch>
**HEAD:** <SHA>
**Verification:** <test results>

## Recent merged PRs

<last 5 commits>

## Active task

<summary from ACTIVE_TASK.md>

## Open risks

<from Step 3>

## Verification state

- Tests: N/N
- Eval corpus: N/N
- Working tree: <clean or list of changes>

## Next recommended action

<skill or command to run next>

## References (in repo)

- CLAUDE.md — project identity and constraints
- notes/ACTIVE_TASK.md — current task status
- notes/PROJECT_STATE.md — full project state
```

### Step 5: Redact secrets

Review the handoff artifact for any accidentally included secrets:
- API keys
- Tokens
- Passwords
- Local paths with usernames (if sharing externally)

Remove or redact any found.

### Step 6: Present

Present the handoff file path to the user. Do not commit it to the repo unless explicitly asked.

## Handoff content rules

- Reference repo artifacts by path instead of duplicating their content
- Keep the handoff concise — it's a pointer, not a copy
- Include enough context for a fresh conversation to pick up
- Do not include evidence pack content — reference the work directory

## Constraints

- Write to `.local/krn-search-handoffs/` by default (gitignored, uncommitted)
- Fall back to OS temp dir only if the default path is unavailable
- Do not write to `notes/` unless explicitly asked
- Do not create committed notes unless explicitly asked
- Do not duplicate repo file content — reference it
- Do not include secrets or credentials
- Do not modify any repo files during handoff
