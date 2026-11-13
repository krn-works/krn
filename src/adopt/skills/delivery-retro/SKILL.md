---
name: delivery-retro
description: Run a short retrospective before a slice's last commit or when it stops, and turn each lesson into an executable check, a repository rule or a task. Use at the end of a slice; skip mid-slice.
compatibility: Requires the krn CLI on PATH and git; works in any repository stack, reading commands from `krn repo contract`.
---

# Delivery retro

Goal: the next slice is cheaper. A lesson inside the task scope ships in the slice pull request; one outside it becomes `krn task create`, never an edit in the slice pull request. Cite evidence by pointer. Read the test and fast commands from `krn repo contract`.

## Find candidates

- **Automated checks:** an error a check could have caught earlier. Extend the cheapest check (a lint rule, a test, a CI step). This is the preferred outcome.
- **Reviewer rules:** a review finding no deterministic check can catch. Add it to the repository rules in `AGENTS.md`.
- **Steering files:** instructions that changed nothing or duplicate another owner. Delete them or move them to their owner.
- **Navigation:** time lost finding a file or an owner. Add one pointer in `AGENTS.md`.
- **Tool economy:** expensive calls such as raw logs or repeated full test runs. Script a verdict instead.
- **Flakiness:** a timing failure. Record a defect task with the failing test; never add a retry policy.

## Disposition

Each candidate becomes, in this order of preference:

1. an executable check;
2. a rule in `AGENTS.md`;
3. a `krn task create` task with observable acceptance.

## Output

At most fifteen lines: the candidates, their dispositions and the created task ids.
