---
name: krn-search-implementation
description: Execute a small implementation task. Read only ACTIVE_TASK-specified files, implement smallest viable diff, add tests, run test suite, preserve evidence schema.
---

# krn-search-implementation

Execute a small implementation task scoped by ACTIVE_TASK.md.

## Steps

1. Read ACTIVE_TASK.md and identify:
   - The task scope
   - Files to inspect
   - Files to modify
   - What must NOT change

2. Read only the files listed in ACTIVE_TASK.md. Do not run broad Explore unless the task explicitly requires understanding code outside those files. If broader exploration is needed, explain why first.

3. Implement the smallest viable diff that satisfies the task scope. Prefer editing existing files over creating new ones. Prefer adding a few lines over refactoring.

4. Add tests before or with code. Run targeted tests first:
   ```bash
   if [ -x .venv/bin/python ]; then PYTHON_BIN=.venv/bin/python; else PYTHON_BIN=python3; fi
   $PYTHON_BIN -m pytest tests/test_<module>.py -v
   ```
   Then run full test suite:
   ```bash
   $PYTHON_BIN -m pytest tests/ -v
   ```

5. Preserve evidence schema (v0.1) and manifest schema (v0.1) unless the task explicitly authorizes schema changes.

6. Never add dependencies without documentation verification. If a new dependency is needed, mark it UNVERIFIED and document the verification requirement.

7. Commit only after all tests pass:
   ```bash
   git add <specific files>
   git commit -m "<conventional commit message>"
   ```

8. Final report:
   - Baseline hash
   - New hash
   - Files changed
   - Tests: N/N passing
   - Known limitations
   - Git status

## Constraints

- Do not modify files not listed in ACTIVE_TASK.md scope
- Do not add dependencies without explicit task authorization
- Do not change evidence schema unless explicitly allowed
- Do not change fetch-list manifest schema unless explicitly allowed
- Do not add hooks, MCP config, or browser automation
- Do not commit generated evidence/cache/tmp files

## Contract-hardening checklist

Before marking implementation done, verify:

- Evidence schema v0.1 preserved (unless task explicitly authorizes schema change)
- Manifest schema v0.1 preserved (unless task explicitly authorizes schema change)
- CLI output format stable or versioned (no silent format changes)
- Failure modes honest (blocked, failed, skipped cases have tests)
- Privacy redaction preserved (query redacted, provider URLs sanitized, no secrets in output)
- Cache behavior intentional (key derivation, hit/miss/bypass semantics documented)
- No WebSearch/WebFetch fallback references in changed files
- `recovery.websearch_allowed` is `false` in all JSON output paths
- `--work-dir` isolation verified (no cross-contamination between runs)
- New limitations documented in skill or CLAUDE.md
- Eval corpus considered for new scenarios
