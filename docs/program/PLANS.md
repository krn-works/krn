# ExecPlans for krn

An ExecPlan is a living design-and-execution document that lets a stateless agent, or a human new to this repository,
deliver one observable change from only the plan file and the current working tree. It adapts the OpenAI cookbook article
"Using PLANS.md for multi-hour problem solving" (openai/openai-cookbook, `articles/codex_exec_plans.md`) to the krn rules in
[`AGENTS.md`](../../AGENTS.md) and [lead methods](lead-rules.md).

## When to write one

Write an ExecPlan before implementing any task that spans more than one session, more than one pull request, or more than
one module. Every R1 task card in [`r1/tasks/`](r1/tasks/) is a seed ExecPlan: the agent that picks the task copies the
card to `.krn/runs/r1/<task>/plan.md`, completes the missing sections, and keeps it current. When the task merges, the final
plan text goes into the pull request body under "ExecPlan" so the decision log survives in Git.

## Non-negotiable requirements

- The plan is self-contained. It names files by repository-relative path, functions by name, and repeats every assumption.
  It never says "as discussed" or "see the audit" without quoting the needed fact.
- The plan produces demonstrably working behaviour, not code that merely matches a definition.
- Every runtime contract has one falsifier test that fails first **by assertion** at the merge-base (a missing import or
  module is a procedural failure and does not count) and passes at the head. Record both transcripts.
- Claims carry evidence labels: `[CODE]`, `[VENDOR]`, `[EMPIRICAL]`, `[OURS-EVIDENCE]`, `[HYPOTHESIS]`, `[POLICY]` (KRN-17).
- The plan never weakens, deletes, or skips an existing test, check, or acceptance criterion to reach green. If an existing
  test is wrong, the plan says why, with evidence, and the change gets an independent review.
- Every implementation passes `npm run gate` (KRN-07) before review.

## Living sections (mandatory)

Keep these four sections current at every stopping point. A stopping point is any moment where work could be interrupted:
before a long command, after a commit, before handing off, before a context compaction.

- `Progress`: checkbox list with UTC timestamps. Split partially done items into "done" and "remaining".
- `Surprises & Discoveries`: unexpected behaviour with a short evidence snippet (test output is ideal).
- `Decision Log`: `Decision / Rationale / Date-Author` for every choice, including choices that deviate from the card.
- `Outcomes & Retrospective`: what was achieved, what remains, and what the next task should know.

## Skeleton

    # <Task ID>: <short action-oriented title>

    This ExecPlan is a living document maintained according to docs/program/PLANS.md.

    ## Purpose / Big Picture
    What the operator can do after this change that they could not do before, and how to see it working.

    ## Progress
    - [ ] (YYYY-MM-DD HH:MMZ) step

    ## Surprises & Discoveries
    - Observation: ... Evidence: ...

    ## Decision Log
    - Decision: ... Rationale: ... Date/Author: ...

    ## Outcomes & Retrospective

    ## Context and Orientation
    Current state, key files by full path, terms defined in plain language.

    ## Plan of Work
    Edits in order: file, function, what changes and why.

    ## Concrete Steps
    Exact commands with working directory and short expected output.

    ## Validation and Acceptance
    Falsifier: test name, failing transcript at merge-base, passing transcript at head.
    Gate: npm run gate → exit 0, "# tests N", "Isolation-dependent tests skipped: 0" on the operator host.
    Behaviour: the observable scenario that proves the change.

    ## Idempotence and Recovery
    How to re-run safely; how to roll back (git revert of the merge commit).

    ## Interfaces and Dependencies
    Types and function signatures that must exist at the end; modules allowed to import each other.

## Formatting

Write prose first. Use checklists only in `Progress`. Show commands and transcripts as indented blocks. Define any term
that is not ordinary English the first time it appears and say where it lives in this repository.

## Revising a plan

When the plan changes course, update every affected section, add a Decision Log entry, and append a one-line note at the
bottom describing the change and why. It must always be possible to restart the task from the plan alone.
