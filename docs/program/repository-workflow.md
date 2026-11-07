# Repository workflow

This repository adopts KRN as a software delivery layer above agent harnesses; KRN is not a harness. Use role names for people and agents. Name work by its purpose and role, never by phase, slice, ticket, round, date, or version. Prefer deep modules with small interfaces and substantial work behind them.

## Instructions and boundaries

`AGENTS.md` is the single repository instruction source; every repository `CLAUDE.md` is a symlink to it. Codex-specific standards and paths live under `.agents/skills`. The global agent contract stays minimal and universal. KRN process belongs only in repositories that explicitly adopt KRN; this repository has adopted it, while non-adopting projects receive no KRN context, onboarding, CLI, or tracker calls.

The accepted request records the current outcome, scope, authority, and uncertainty. A native Goal may continue that outcome but is not durable repository truth. Repository `AGENTS.md` owns local workflow and gates; trusted host settings and actual tool limits remain host-owned. Select one procedure for a task. CI or host policy owns publication and deployment checks.

Keep KRN-created repository state in ignored `.krn/worktrees/<branch>/`, `.krn/runs/<owner>/`, `.krn/sources/`, `.krn/tmp/`, or `.krn/task-claims/` paths; host tool configuration is exempt.

Safety comes from system boundaries, not shell parsing ([ADR 0014 D9](../adr/0014-operator-decisions-2026-10-23.md)). Codex sandbox and approvals, Claude Code sandbox and permissions, and server-side branch protection provide the safety boundaries.

## Control plane and durable state

Use the selected in-repository `krn task` tracker as the task-status source: store each task in one canonical JSON file at `tasks/<id>.json` and compute the index in memory for each command. Task dependencies, readiness, and claiming are supported by one command. This replaces the legacy Git-ref `krn task` queue and host-SQLite `krn work`. The tracker format follows ADR 0015. No legacy board data is imported; its Product integration is removed.

The tracker records task status, not PR acceptance. Delivery has one gate: required CI on the exact HEAD (`npm run gate` locally; the aggregate GitHub Actions `Check`, App `15368`, `.github/workflows/ci.yml`). Before committing run `npm run fast` once (Biome `--write` and tsc on changed files plus tests for changed and importing modules, one PASS/FAIL line; CI runs the rest); then `gh pr create --head <branch>` and `gh pr merge --auto --merge`. `krn review` (parallel `standards`, `spec` and `adversarial` judges, [`src/flow/types.ts`](../../src/flow/types.ts)) and `npm run gate:local` stay available on demand; no record, budget, brief or contract trailer is required for a merge.

When an outcome uses a delivery-loop capsule, its state belongs at `.krn/runs/delivery-loop/<outcome-id>/state.md`. The delivery-loop owner is its sole writer; use `krn state check` to validate it and `krn state resume` to resume it. Durable repository decisions belong in `CONTEXT.md` and `docs/adr/`. Native Goals, transcripts, and personal memory are not durable repository truth.

## Roles and delivery

Run the changed behavior's tests and real receiver proof yourself; `krn review` is optional for risky changes.

The lead follows the project skills in `.agents/skills` (also exposed to Claude Code through `.claude/skills`): `krn-lead` for the no-gates loop, `krn-retro` when a slice ends, `architecture` when designing or reviewing module structure, `typescript` when writing or reviewing TypeScript, and `krn-handoff` to start the next slice in a fresh session.

Merges go through `gh pr merge --auto --merge` once the `Check` passes; the `main integrity` ruleset requires it.

- **Lead:** follows [lead rules](lead-rules.md) and owns the outcome loop. Do not treat a task update or worker handoff as acceptance.
- **Worker:** optional Codex delegation (`krn worker start|send|stop`) for bounded work; it returns uncommitted changes, evidence and limits, and the lead commits. Use `codex exec --resume` only for an interrupted run.
- **Judge:** an optional independent `krn review` panel against an exact head SHA; authors never judge their own work.

Use one writer per outcome at a time and transfer the writer role explicitly before a mutating handoff. Parallel implementation uses isolated worktrees and returns through one integrator; independent read-only work may run in parallel. Reuse recorded authority for the same outcome's commit, push, PR, and merge without repeating per-step prompts.

## Lessons and corrections

KRN tooling does not enforce or create the standalone `docs/research/workflow-lessons.md` page; lesson findings are warnings, and existing pages in other repositories remain theirs (ADR 0014 D27). Put lessons where the executor reads them: mechanical checks first and repository `AGENTS.md` second; lead memory is only for operator preferences and decisions. Turn regressions into expected behavior or mechanical rules for code invariants; do not add lint that pins implementation technique. Fix flaky tests. A single recorded retry is allowed only for untouched files while a fix is pending. Use private test temp directories, condition waits with deadlines, and no wall-clock assertions.

Backups are temporary: back up, edit, verify, and delete in the same step. Host migrations may retain one only for the observation window.

Use Conventional Commits for authored commits, PR titles and squash subjects. Commits for a managed task carry a `Ticket: <id>` trailer; no other trailer is required.


At every terminal PR, `$delivery-loop` records each owned branch and worktree as retired under recorded deletion authority after preserving needed evidence, or retained with one owner, consumer, and removal trigger. A merged head branch is retired locally and remotely and its worktree removed in the same closeout. For a closed unmerged or superseded PR, retain a branch or worktree only while a named successor or evidence consumer needs it; otherwise preserve needed evidence and retire it under deletion authority. PR closure grants no deletion authority. Do not delete another owner's ref or worktree, and leave none unowned.

Keep the minimal set of true, current docs. Delete outdated docs; Git history is the archive. Stale instructions lose to current code and passing tests.
