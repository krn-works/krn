---
name: krn-search-next-task
description: Prepare the next task prompt from current repo state. Read handoff docs, verify baseline, summarize phase, propose next action.
---

# krn-search-next-task

Prepare the next task prompt by reading the current repo state.

## Steps

1. Read handoff docs in this order:
   - `CLAUDE.md`
   - `notes/PROJECT_STATE.md`
   - `notes/ACTIVE_TASK.md`
   - `notes/AGENT_PROTOCOL.md`

2. Read the latest MVP memo referenced in ACTIVE_TASK.md or PROJECT_STATE.md.

3. Verify baseline:
   ```bash
   git status --short
   git rev-parse HEAD
   if [ -x .venv/bin/python ]; then PYTHON_BIN=.venv/bin/python; else PYTHON_BIN=python3; fi
   $PYTHON_BIN -m pytest tests/ -q
   ```

4. Summarize current phase in one paragraph. Include:
   - Current HEAD
   - Phase name and status
   - Last decision made
   - Test count

5. Check for contradictions between CLAUDE.md, PROJECT_STATE.md, and ACTIVE_TASK.md. If any exist, stop and report them — do not proceed to next task until docs are synced.

6. Propose a next prompt. The prompt should be:
   - Scoped to the smallest viable task
   - Specific about files to modify
   - Clear about what NOT to change
   - Reference the skill to use for execution

7. Do not edit any files unless explicitly asked.

## Output format

```
Current phase: [phase name]
Baseline: [commit hash]
Tests: N/N passing
Contradictions: none / [describe]
Proposed next task: [one paragraph]
Recommended skill: [skill name]
```
