---
name: krn-retro
description: Run a short retrospective when a KRN slice merges or stops, and turn each lesson into an executable check, a repository rule or a task. Use at the end of a slice; skip mid-slice.
---

# KRN retro

Goal: the next slice is cheaper. Use the slice's own evidence by pointer (capsule, run folder, CI runs, PR), not memory.

## Measure first

From the records: wall time from claim to merge; worker time; CI reruns and why; operator interventions and why; defects that reached main. Numbers come from files and runs, not impressions.

## Find candidates

Categories adapted from mattpocock/skills `retro`:

- **Automated checks:** an error a check could have caught earlier. Add or extend the cheapest check (lint rule, a test, a CI step). This is the preferred outcome.
- **Reviewer rules:** a finding an on-demand `krn review` raised that no deterministic check can catch. Add it to a repository rule or `docs/program/hardening-checklist.md`.
- **Steering files:** instructions that changed nothing, duplicate another owner, or contradict an ADR. Delete them or move them to their owner (D19).
- **Navigation:** time lost finding a file or an owner. Add one pointer in `AGENTS.md` or `CONTEXT.md`.
- **Tool economy:** expensive calls, such as raw logs read by the lead or repeated full test runs. Script a verdict instead.
- **Information access:** a fact the lead lacked, such as CI logs or host state. Add a command that fetches it.
- **Flakiness:** a timing failure. Record a defect task with the failing test and evidence (D12); never add a retry policy.

## Disposition (D14)

Each candidate becomes, in this order of preference:

1. an executable check;
2. a rule in this repository's `AGENTS.md` through `spec/rules.json`;
3. a `krn task create` defect or task with observable acceptance.

A trap lesson (a known defect that cost a step) also patches the steering instruction that led into it, in the same slice: add the workaround to `krn-lead` or `docs/program/repository-workflow.md`, add a `Lead trap:` line to the task with `krn task edit <id> --append-body`, and list the id under the lead skill's "Open traps". A task alone is not a disposition for a trap.

Lead memory keeps only operator preferences and decisions. Never write a lessons page.

## Output

At most fifteen lines in the capsule field "Workflow friction and lesson candidates", plus the created tasks. Name the top three in the handoff.
