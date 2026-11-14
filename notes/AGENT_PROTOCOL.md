# Agent Protocol

## Startup budget

Target onboarding: under 5k tokens.

## Required first files

Read these before any source code or exploration:

1. `CLAUDE.md`
2. `notes/PROJECT_STATE.md`
3. `notes/ACTIVE_TASK.md`
4. `notes/AGENT_PROTOCOL.md`

Then inspect only the source files listed in `ACTIVE_TASK.md`.

## Forbidden first actions

- Broad repo Explore (searching for patterns across many files)
- Reading all source files or all test files
- Scanning full git history (`git log` with no path restriction)
- Loading all notes files at once
- Generating implementation plans from memory without reading handoff docs
- Implementing features before confirming the current phase
- Making assumptions about project state from file names or directory structure

## When broad exploration is allowed

Only when the active task requires it and the reason is stated first. Keep exploration scoped to what the task requires. Do not use exploration as a substitute for missing handoff docs.

## Staleness and contradiction handling

If `CLAUDE.md` conflicts with `PROJECT_STATE.md` or `ACTIVE_TASK.md`, stop and do a docs-sync task before implementation. Do not work around stale docs.

## Final report template

Every session must produce:

1. Baseline commit
2. New commit hash (if any)
3. Files changed
4. What changed
5. Commands run
6. Test results
7. Known limitations
8. Next recommended action
9. Git status

## Commit discipline

- Do not commit until all deliverables are complete
- Do not commit until tests pass
- Do not ask to commit with incomplete work
- Do not force push, amend published commits, or skip hooks
