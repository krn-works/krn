# Bead Workflow

A bead is a small vertical slice of useful work.

## Bead Contract

```text
Bead: <small outcome>
Files/areas: <owned paths>
Acceptance: <observable behavior>
Proof: <command or runtime check>
Risk: <known remaining uncertainty>
```

## Delegation Rules

- Delegate only independent beads.
- Give each worker explicit file ownership.
- Avoid parallel writes to the same files.
- Review each worker's output before merging concepts into the main path.
- Prefer explorer subagents for read-heavy context gathering.
