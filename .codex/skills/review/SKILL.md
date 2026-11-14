---
name: review
description: Code review for working-tree diffs, PRs, plans, generated code, or completed agent work. Use when asked to review, before shipping substantial changes, after subagent implementation, or when verifying whether code is correct, maintainable, secure, and sufficiently tested.
---

# Review

Review like a senior engineer looking for defects, not like a summarizer. Findings first.

## Review Order

1. **Understand intent.** Read the user request, issue/spec/plan, and changed files. If reviewing a PR, inspect the diff and relevant unchanged callers.
2. **Find behavior risks.** Prioritize correctness, data loss, broken contracts, runtime failures, security, concurrency, performance, and missed edge cases.
3. **Check proof quality.** Identify missing tests, shallow tests, wrong proof level, skipped runtime checks, or evidence that does not match the acceptance criteria.
4. **Check maintainability.** Look for shallow modules, duplicated logic, leaky interfaces, surprising naming, and changes that make the next task harder.
5. **Report only defensible findings.** Each finding needs file/line evidence, impact, and the smallest repair direction.

## Output Format

Use this structure:

```text
Findings
- Severity: file:line - concrete issue and impact.

Open questions
- Only include questions that block a confident decision.

Residual risk
- Mention commands or environments not verified.
```

If there are no issues, say that clearly and still mention test gaps or unverified surfaces.

## Severity

- **Blocker:** likely broken behavior, data loss, security exposure, or cannot ship.
- **High:** plausible production bug, serious regression, or missing proof on critical path.
- **Medium:** maintainability or edge-case risk that should be fixed before merge.
- **Low:** small cleanup only if already touching the area.

Read `references/review-checklist.md` for deeper checks.
