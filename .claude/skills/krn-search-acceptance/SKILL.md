---
name: krn-search-acceptance
description: Create acceptance and evaluation docs after an implementation phase. Run tests, evaluate scenarios, update project notes, commit docs-only.
---

# krn-search-acceptance

Create acceptance/evaluation documentation after an implementation phase is complete.

## Steps

1. Verify baseline:
   ```bash
   git status --short
   git rev-parse HEAD
   if [ -x .venv/bin/python ]; then PYTHON_BIN=.venv/bin/python; else PYTHON_BIN=python3; fi
   $PYTHON_BIN -m pytest tests/ -v
   ```

2. Read ACTIVE_TASK.md to identify:
   - What was implemented
   - Acceptance criteria for the phase
   - Evaluation scenarios (if defined)

3. Run the full test suite and record results:
   ```bash
   $PYTHON_BIN -m pytest tests/ -v
   ```

4. Evaluate each scenario from the task's acceptance checklist. For each scenario, record:
   - Score (if applicable)
   - Evidence
   - Any deviations from expected behavior

5. Create the evaluation memo at `notes/MVPxx_<topic>_EVALUATION.md` with:
   - Baseline commit
   - What was evaluated
   - Scenario results
   - Acceptance checklist
   - Known limitations discovered
   - Decision (ACCEPT / REJECT / CONDITIONAL)

6. Update project notes:
   - `notes/PROJECT_STATE.md` — update phase, HEAD, CLI docs if changed
   - `notes/ACTIVE_TASK.md` — mark current task complete, set next task
   - `notes/EXPERIMENT_LOG.md` — add session entry
   - `notes/DECISION_CANDIDATES.md` — add durable candidates only

7. Commit docs-only:
   ```bash
   git add <evaluation memo and notes files>
   git commit -m "docs: evaluate <phase name>"
   ```

8. Do not modify runtime source code. This skill produces documentation only.

## Output format

```
Baseline: [commit hash]
New commit: [commit hash]
Evaluation: [file path]
Decision: ACCEPT / REJECT / CONDITIONAL
Scenarios: N evaluated, scores [list]
Acceptance: N/M criteria met
Known limitations: [list]
Next task: [description]
```

## Constraints

- Do not modify any source files in `search_tool/`
- Do not modify any test files in `tests/`
- Do not modify pyproject.toml
- Do not add dependencies
- Do not run end-to-end scenarios that hit the network (all tests use mocks)
- Do not create hooks or MCP config
