---
name: krn-search-review
description: Review local changes before push. Inspect git diff, verify scope, check for drift, run tests, recommend push/no-push.
---

# krn-search-review

Review local changes before pushing to remote.

## Steps

1. Inspect the current state:
   ```bash
   git status --short
   git diff --stat
   git diff
   git diff --check
   ```

2. Read ACTIVE_TASK.md and verify that all changes are within the scoped task. Flag any changes that exceed the task scope.

3. Check for source drift:
   - Were any files modified that are not in the task scope?
   - Were any dependencies added or version-bumped?
   - Was pyproject.toml changed?
   - Was the evidence schema (v0.1) modified?
   - Was the manifest schema (v0.1) modified?
   - Was the URL policy modified?
   - Were security-relevant constants changed?

4. Run the full test suite:
   ```bash
   if [ -x .venv/bin/python ]; then PYTHON_BIN=.venv/bin/python; else PYTHON_BIN=python3; fi
   $PYTHON_BIN -m pytest tests/ -v
   ```

5. Check for generated files that should not be tracked:
   - evidence/ directory
   - cache/ directory
   - tmp/ files
   - __pycache__/

6. Classify changes:
   - **Blockers:** test failures, scope violations, schema changes not in task, security regressions
   - **Polish:** formatting, comments, docs, minor refactorings that don't change behavior
   - **Expected:** the changes described in ACTIVE_TASK.md

7. Recommend: push / no push / fix first

8. Do not edit any files unless explicitly asked.

## Output format

```
Scope: [in scope / out of scope — details]
Source drift: none / [describe]
Schema drift: none / [describe]
Dependency drift: none / [describe]
Tests: N/N passing
Generated files: none / [describe]
Blockers: none / [describe]
Recommendation: push / no push / fix first
```
