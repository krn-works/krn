# Repository workflow

This repository adopts KRN as a software delivery layer above agent harnesses; KRN is not a harness. Use role names for people and agents. Name work by its purpose and role, never by phase, slice, ticket, round, date, or version. Prefer deep modules with small interfaces and substantial work behind them.

## Instructions and boundaries

`AGENTS.md` is the single repository instruction source; every repository `CLAUDE.md` is a symlink to it. Codex-specific standards and paths live under `.agents/skills`. The global agent contract stays minimal and universal. KRN process belongs only in repositories that explicitly adopt KRN; this repository has adopted it, while non-adopting projects receive no KRN context, onboarding, CLI, or tracker calls.

The accepted request records the current outcome, scope, authority, and uncertainty. A native Goal may continue that outcome but is not durable repository truth. Repository `AGENTS.md` owns local workflow and gates; trusted host settings and actual tool limits remain host-owned. Select one procedure for a task. CI or host policy owns publication and deployment checks.

Keep KRN-created repository state in ignored `.krn/worktrees/<branch>/`, `.krn/runs/<owner>/`, `.krn/sources/`, `.krn/tmp/`, or `.krn/task-claims/` paths; host tool configuration is exempt.

Safety comes from system boundaries, not shell parsing ([ADR 0014 D9](../adr/0014-operator-decisions-2026-10-23.md)). Codex sandbox and approvals, Claude Code sandbox and permissions, and server-side branch protection provide the safety boundaries.

## Control plane and durable state

Use the selected in-repository `krn task` tracker as the task-status source: store each task in one canonical JSON file at `tasks/<id>.json` and compute the index in memory for each command. Comments live beside a task in append-only `tasks/<id>.comments.jsonl` (`merge=union`, so parallel branches keep both entries); add one with `krn task comment ID --body-file`. Task dependencies, readiness, and claiming are supported by one command. The tracker format follows ADR 0015.

The tracker records task status, not PR acceptance. Delivery has one gate: required CI on the exact HEAD (`npm run gate` locally; the aggregate GitHub Actions `Check`, App `15368`, `.github/workflows/ci.yml`). Before committing run `npm run fast` once (Biome `--write` and tsc on changed files plus tests touching changed or deleted files, one PASS/FAIL line; CI runs the rest); then `gh pr create --head <branch>` and `gh pr merge --auto --squash`. `npm run gate` stay available on demand; no record, budget, brief or contract trailer is required for a merge.

When an outcome uses a delivery-loop capsule, its state belongs at `.krn/runs/delivery-loop/<outcome-id>/state.md`. The delivery-loop owner is its sole writer; use `krn state check` to validate it and `krn state resume` to resume it. Durable repository decisions belong in `CONTEXT.md` and `docs/adr/`. Native Goals, transcripts, and personal memory are not durable repository truth.

## Roles and delivery

Run the changed behavior's tests and real receiver proof yourself, and ask for an independent review when the change is risky.

A session is the lead only when the operator or its brief names that role or invokes `krn-lead`. Any other session works and commits in the checkout it was started in: it creates no worktree, branch or task, claims nothing, and skips the lead skills.

The lead follows the project skills in `.agents/skills` (also exposed to Claude Code through `.claude/skills`): `krn-lead` for the no-gates loop, `krn-retro` when a slice ends, `architecture` when designing or reviewing module structure, `typescript` when writing or reviewing TypeScript, and `krn-handoff` to start the next slice in a fresh session.

Merges go through `gh pr merge --auto --squash` once the `Check` passes; the `main integrity` ruleset requires it and allows only squash, so a PR is one commit on main. Bodies follow `.github/pull_request_template.md`; retro edits ride in the slice PR.

- **Lead:** follows [lead rules](lead-rules.md) and owns the outcome loop. Do not treat a task update or worker handoff as acceptance.
- **Worker:** optional Codex delegation (`krn worker start|send|stop`) for bounded work; it returns uncommitted changes, evidence and limits, and the lead commits. Use `codex exec --resume` only for an interrupted run.
- **Judge:** an optional independent review against an exact head SHA; authors never judge their own work.

Use one writer per outcome at a time and transfer the writer role explicitly before a mutating handoff. Parallel implementation uses isolated worktrees and returns through one integrator; independent read-only work may run in parallel. Reuse recorded authority for the same outcome's commit, push, PR, and merge without repeating per-step prompts.

## Lessons and corrections

KRN tooling does not enforce or create a standalone workflow-lessons page; lesson findings are warnings, and existing pages in other repositories remain theirs (ADR 0014 D27). Put lessons where the executor reads them: mechanical checks first and repository `AGENTS.md` second; lead memory is only for operator preferences and decisions. Turn regressions into expected behavior or mechanical rules for code invariants; do not add lint that pins implementation technique. Fix flaky tests. A single recorded retry is allowed only for untouched files while a fix is pending. Use private test temp directories, condition waits with deadlines, and no wall-clock assertions.

Backups are temporary: back up, edit, verify, and delete in the same step. Host migrations may retain one only for the observation window.

Use Conventional Commits for authored commits, PR titles and squash subjects. Commits for a managed task carry a `Ticket: <id>` trailer and their PR closes it (CI enforces this), or `Refs: <id>` if the PR leaves it open; no other trailer is required.


At every terminal PR, `$delivery-loop` records each owned branch and worktree as retired under recorded deletion authority after preserving needed evidence, or retained with one owner, consumer, and removal trigger. A merged head branch is retired locally and remotely and its worktree removed in the same closeout. For a closed unmerged or superseded PR, retain a branch or worktree only while a named successor or evidence consumer needs it; otherwise preserve needed evidence and retire it under deletion authority. PR closure grants no deletion authority. Do not delete another owner's ref or worktree, and leave none unowned.

Keep the minimal set of true, current docs. Delete outdated docs; Git history is the archive. Stale instructions lose to current code and passing tests.
