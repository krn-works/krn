# 24. Operator experience: one tracked plan every agent starts from, and three rule sources

Date: 2026-11-15

## Status

Accepted.

- Supersedes `docs/program/roadmap.md` and `docs/program/proposals.md` as plan surfaces.
- Supersedes the untracked `.krn/runs/brain-research/north-star.md` as the thesis authority. Its text is tracked at the top of `docs/program/plan.md`.
- Amends `spec/rules.json`: KRN-09 and KRN-10 are removed once their documents are folded.
- A new `krn handoff` command (J9 D4) is declined for now.

## Context

- The thesis is lost at every relay. `north-star.md` says "every successor prompt names this file first", but it sits in gitignored `.krn/` and SessionStart injects no plan (judge-J9 F4).
- At least 7 plan surfaces compete (judge-J9 F4):
  - `roadmap.md` (112 edits in 14 days);
  - handoff priorities;
  - the capsule;
  - 8 fable plans;
  - `program.md`;
  - stale `.krn/PLANS.md` and `.krn/TASK.md`;
  - a dead `PLAN.md` link at `lead-rules.md:21`.
- There are 17 rule sources, with a six-level precedence ladder to settle their conflicts. About 36.5 kB is mandatory by reference for a lead before any task text. 19% of commits in 14 days touched rules or skills (judge-J9 F3).
- A slice close takes about 13 commands, and the handoff checker enforces prose shape (judge-J9 F5). But successor launch is used 15 to 31 times a day, so the relay is real work and not ceremony to delete (judge-J10 section 1).
- Red team: cutting 17 sources to 3 in one move risks losing recipes that carry knowledge, for example the CI-runner repro at `lead-rules.md:29`. Fold gradually and watch the red-CI rate (judge-J10 section 3).
- Shared single files conflict under parallel lanes (judge-J4 F1), so the plan must not be edited by every lane.

## Decision

1. **One plan: `docs/program/plan.md`, tracked, at most 150 lines.**
   - Top: the north-star thesis (operator quote verbatim, the three verbs, items 1 to 5).
   - Then the ADR list.
   - Then sectors with ordered one-line slices, each with Outcome, Proof, Predicted and After.
2. **Every session starts from it.** SessionStart injects `plan.md@<short hash>` and the current slice line, at most 600 characters, within ADR 0020's budget. Lane briefs carry the same line. Successor prompts and Fable briefs stop naming `north-star.md`.
3. **Only plan PRs edit the plan.**
   - A lane never edits `plan.md`.
   - Slice status is the task's status. The plan line names the slice, and `krn task list --json` gives its state.
   - The lead edits the plan in a retro or plan PR when a falsifier fires or a sector completes. A plan change that moves none of items 1 to 5 is rejected in review.
4. **Three rule sources, plus ADRs as history.**
   - AGENTS.md: rules, inline, at most 600 tokens.
   - `plan.md`: direction.
   - Skills: procedure, on demand.
   - The precedence ladder is deleted when the sources it ranks are gone.
5. **Fold in two steps, measured between them.**
   - Step 1, pure deletion: `roadmap.md` and `scripts/claude/roadmap-prune.ts`; `proposals.md` (its rows become tasks); `.krn/PLANS.md`; `.krn/TASK.md`; the dead link; `hardening-checklist.md` moves into the krn-lead skill's references.
   - Step 2: `lead-rules.md` and `repository-workflow.md` fold into the krn-lead skill and AGENTS.md. Each recipe is kept verbatim where it encodes a repro (the CI-runner recipe is named). Then KRN-09 and KRN-10 go.
   - Step 2 starts only after 50 PRs of red-CI baseline are recorded following step 1.
6. **The operator reads three things:** the status line, the Polish report at handoff, and `plan.md`. The capsule and the roadmap are not operator surfaces.
7. **Handoff stays a skill.**
   - The capsule becomes pointers (ADR 0019).
   - The launch log is fixed (ADR 0022).
   - The prose-shape rules in `handoff-requests.ts` are replaced by one invariant: every open `origin: operator` inbox row maps to a task or a disposition.
   - A single `krn handoff` command is reconsidered only when the launch log shows the step count is still above 6.

## Expected effect

- SessionStart output contains `plan.md@<hash>` in 100% of sessions. Measure: `node --test test/claude/context-restart-plan.test.ts`, plus a transcript grep.
- Lane transcripts whose first 5 calls Read `north-star.md` or a fable plan fall to about 0. Measure: transcript scan over 7 days.
- Mandatory-by-reference bytes for a lead fall from about 36.5 kB to at most 15 kB, and rule sources from 17 to 3 plus ADRs. Measure: the sum in `spec/context-budget.json`; `ls docs/program | wc -l` is 2 (`plan.md`, `fable-plan-brief.md`).
- Commits touching `docs/program`, skills, AGENTS.md or `spec/rules.json` fall from 19% to under 8% of commits over 14 days. Measure: `git log --since=14.days --name-only --format=%h -- docs/program .agents/skills AGENTS.md spec/rules.json`.
- Operator prompts asking "what is the state or plan" fall by half over 2 weeks. Measure: grep over `origin: operator` rows of `.krn/operator/inbox.jsonl`.
- `plan.md` conflicts: 0 ship exit-76 events naming it.

## Consequences

- Deleted:
  - `docs/program/roadmap.md`, `docs/program/proposals.md`, `scripts/claude/roadmap-prune.ts`, `src/repo/roadmap.ts`;
  - `.krn/PLANS.md`, `.krn/TASK.md`;
  - later, `docs/program/lead-rules.md` and `docs/program/repository-workflow.md`;
  - the prose-shape checks in `src/successor/handoff-requests.ts`.
- `src/context/restart.ts` gains the plan pointer and loses the index, disk lines and stale claim lines (ADR 0020).
- `docs/program/fable-plan-brief.md` stays, with the `metric` prediction source (ADR 0021) and the instruction to attach `plan.md` in place of `north-star.md`.
- The krn-lead, krn-handoff and krn-retro skills and the `delivery-*` copies become one source through self-adoption (ADR 0023).

## Falsified if

- Plan-pointer injection does not reduce north-star or fable-plan reads, or off-thesis plans keep being written. Then injection is not what loses the thesis, and the relay prompt template is the next suspect.
- Red-CI rate or lane rework rises more than 10 points over 50 PRs after step 2. Then the folded documents carried knowledge, and the missing lines return to AGENTS.md.
- Open operator inbox rows older than 24 h appear after a relay. Then the prose checker was doing real work, and the invariant gets a blocking check in `krn state handoff`.
- `plan.md` exceeds 150 lines or is edited by more than 2 PRs a week for 2 weeks. Then it has become the roadmap again, and slice lines move to tasks only.
