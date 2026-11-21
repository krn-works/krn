---
name: delivery-retro
description: Run a short retrospective before a slice's last commit or when it stops, and turn each lesson into an executable check, a repository rule or a task. Use at the end of a slice; skip mid-slice.
compatibility: Requires the krn CLI on PATH and git; works in any repository stack, reading commands from `krn repo contract`.
---

# Delivery retro

Goal: the next slice is cheaper. A defect with an obvious few-line fix is fixed now, with its regression test. Another lesson inside the task scope ships in the slice pull request; one outside it becomes `krn task create`. Never open a separate retro pull request. Cite evidence by pointer.

## Measure first

Start from `krn state retro --sessions 20` (recurring causes, each with a transcript or PR pointer), then list the task's commits, wall time, PRs, CI reruns and interventions.

If the slice hit a workaround or a tool refusal, write each (with evidence paths) to `.krn/tmp/friction.md` and run the repository's critique script on it, if any. Each finding gets a task or a disposition.

## Find candidates

- **Automated checks:** an error a check could have caught earlier. Extend the cheapest check (a lint rule, a test, a CI step). This is the preferred outcome.
- **Fix chains:** a repeat fix of one task or file gets a real-receiver case or a redesign task, not another edge-case rule.
- **Reviewer rules:** a review finding no deterministic check can catch. Add it to the repository rules in `AGENTS.md`.
- **Steering files:** instructions that changed nothing, duplicate an owner or contradict a decision record. Delete or move them.
- **Navigation:** time lost finding an owner. Add a pointer in `AGENTS.md`.
- **Tool economy:** expensive calls (raw logs, repeated full runs). Script a verdict.
- **Information access:** a fact the lead lacked (CI logs, host state). Add a command for it.
- **Flakiness:** a timing failure. Record a defect task with the failing test; never add a retry policy.

## Disposition

Each candidate becomes, in this order of preference:

1. an executable check;
2. a rule in `AGENTS.md`;
3. a `krn task create` task with observable acceptance.

A trap lesson (a known defect that cost a step) also needs its steering fix as a task unless the file holding the workaround is in scope.

## Propose upstream

A lesson that holds in other repositories too also becomes a standards proposal KRN can harvest into the pack every adopted project inherits:

`krn standards propose --text "<the lesson as one statement>" --kind check|template|skill|prose --evidence <#PR, commit SHA, path or https URL>`

Write the principle, keep the incident as evidence (`--evidence`); a text that retells one incident is refused (exit 65).

It writes one file under `.agents/standards-proposals/`; commit it with the slice. Evidence is mandatory.

## Output

At most fifteen lines: the candidates, their dispositions, the created task ids and the proposal files; name the top three in the handoff.
