# Repository workflow

This repository adopts KRN as a software delivery layer above agent harnesses; KRN is not a harness. Use role names for people and agents. Name work by its purpose and role, never by phase, slice, ticket, round, date, or version. Prefer deep modules with small interfaces and substantial work behind them.

## Instructions and boundaries

`AGENTS.md` is the single repository instruction source; every repository `CLAUDE.md` is a symlink to it. Codex-specific standards and paths live under `.agents/skills`. The global agent contract stays minimal and universal. KRN process belongs only in repositories that explicitly adopt KRN; this repository has adopted it, while non-adopting projects receive no KRN context, onboarding, CLI, or tracker calls.

The accepted request records the current outcome, scope, authority, and uncertainty. A native Goal may continue that outcome but is not durable repository truth. Repository `AGENTS.md` owns local workflow and gates; trusted host settings and actual tool limits remain host-owned. Select one procedure for a task. CI or host policy owns publication and deployment checks.

Keep KRN-created repository state in ignored `.krn/worktrees/<branch>/`, `.krn/runs/<owner>/`, `.krn/sources/`, or `.krn/tmp/` paths; host tool configuration is exempt.

Safety comes from system boundaries, not shell parsing. Remove the `krn_pretooluse.py` and `destructive_guard.py` parser guard. Codex sandbox and approvals, Claude Code sandbox and permissions, and server-side branch protection provide the safety boundaries.

## Control plane and durable state

Use the selected in-repository `krn task` tracker as the task-status source: tasks are Git-backed JSONL/files that travel with the repository; a local index is rebuildable; task dependencies, readiness, and claiming are supported by one command. This replaces the legacy Git-ref `krn task` queue and host-SQLite `krn work`. The implementation is a later slice. Paperclip is legacy: import existing records, then remove it everywhere. Do not add Paperclip dependencies.

The tracker records task status, not PR acceptance. Apply [ADR 0014 D10–D11](../adr/0014-operator-decisions-2026-10-23.md): deterministic checks block; run parallel LLM judges before the gate; each judge reports all findings in one pass, with `BLOCKING` reserved for material defects and a reproduction preferred. Allow at most two review rounds, then the lead decides. Run cheap preflight (types, lint, documentation-reading tests, test-impact review, and contracts) before review. After review, Product runs `npm run gate:local`; Global does not run its full local gate, and CI runs the same steps.

When an outcome uses a delivery-loop capsule, its state belongs at `.krn/runs/delivery-loop/<outcome-id>/state.md`. The delivery-loop owner is its sole writer; use `krn state check` to validate it and `krn state resume` to resume it. Durable repository decisions belong in `CONTEXT.md` and `docs/adr/`. Native Goals, transcripts, and personal memory are not durable repository truth.

## Roles and delivery

- **Lead:** follows [lead rules](lead-rules.md), owns the outcome loop, and decides after at most two review rounds. Do not treat a task update or worker handoff as acceptance.
- **Worker:** implements the assigned work and returns changes, evidence, and limits. Every fix round starts in a fresh session and ends with a one-page handoff. Use `--resume` only for an interrupted run and refuse it above 500k tokens. Universal worker hygiene belongs in the worker wrapper; KRN conventions belong in this repository.
- **Judge:** independently reviews the requested standards or specification against the exact candidate head SHA. Judges run in parallel and return one complete finding set each. Only material defects block, preferably with a reproduction. Required CI and successful independent Standards and Spec reviews are required for PR merge on the same SHA; authors never judge their own work.

Use one writer per outcome at a time and transfer the writer role explicitly before a mutating handoff. Parallel implementation uses isolated worktrees and returns through one integrator; independent read-only work may run in parallel. Reuse recorded authority for the same outcome's commit, push, PR, and merge without repeating per-step prompts.

## Lessons and corrections

Put lessons where the executor reads them: mechanical checks first, repository `AGENTS.md` second, and lead memory only for operator preferences and decisions. Turn regressions into expected behavior or mechanical rules for code invariants; do not add lint that pins implementation technique. Fix flaky tests. A single recorded retry is allowed only for untouched files while a fix is pending. Use private test temp directories, condition waits with deadlines, and no wall-clock assertions.

Backups are temporary: back up, edit, verify, and delete in the same step. Host migrations may retain one only for the observation window.

Use Conventional Commits for authored commits, PR titles, and squash subjects. For a repository that has `npm run changes:check`, a commit changing its guard contract records `Change-contract: <check>:red->green` with its `Ticket:` trailer in the same trailer block. The contract names an existing executable check. Changed or new observers need observed before-state via `--before`; behavior-preserving changes keep their checks green. Run `npm run changes:check` to verify declared predictions.

At every terminal PR, `$delivery-loop` records each owned branch and worktree as retired under recorded deletion authority after preserving needed evidence, or retained with one owner, consumer, and removal trigger. A merged head branch is retired locally and remotely and its worktree removed in the same closeout. For a closed unmerged or superseded PR, retain a branch or worktree only while a named successor or evidence consumer needs it; otherwise preserve needed evidence and retire it under deletion authority. PR closure grants no deletion authority. Do not delete another owner's ref or worktree, and leave none unowned.

Keep the minimal set of true, current docs. Delete outdated docs; Git history is the archive. Stale instructions lose to current code and passing tests.
