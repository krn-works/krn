# Repository workflow

This repository adopts KRN as a software delivery layer above agent harnesses; KRN is not a harness. Use role names for people and agents. Name work by its purpose and role, never by phase, slice, ticket, round, date, or version. Prefer deep modules with small interfaces and substantial work behind them.

## Instructions and boundaries

`AGENTS.md` is the single repository instruction source; every repository `CLAUDE.md` is a symlink to it. Codex-specific standards and paths live under `.agents/skills`. The global agent contract stays minimal and universal. KRN process belongs only in repositories that explicitly adopt KRN; this repository has adopted it, while non-adopting projects receive no KRN context, onboarding, CLI, or tracker calls.

The accepted request records the current outcome, scope, authority, and uncertainty. A native Goal may continue that outcome but is not durable repository truth. Repository `AGENTS.md` owns local workflow and gates; trusted host settings and actual tool limits remain host-owned. Select one procedure for a task. CI or host policy owns publication and deployment checks.

Keep KRN-created repository state in ignored `.krn/worktrees/<branch>/`, `.krn/runs/<owner>/`, `.krn/sources/`, `.krn/tmp/`, or `.krn/task-claims/` paths; host tool configuration is exempt.

Safety comes from system boundaries, not shell parsing ([ADR 0014 D9](../adr/0014-operator-decisions-2026-10-23.md)). Codex sandbox and approvals, Claude Code sandbox and permissions, and server-side branch protection provide the safety boundaries.

## Control plane and durable state

Use the selected in-repository `krn task` tracker as the task-status source: store each task in one canonical JSON file at `tasks/<id>.json` and compute the index in memory for each command. Task dependencies, readiness, and claiming are supported by one command. This replaces the legacy Git-ref `krn task` queue and host-SQLite `krn work`. The tracker format follows ADR 0015. No legacy board data is imported; its Product integration is removed. Local `krn review` records and git history provide review and delivery evidence without board publication.

The tracker records task status, not PR acceptance. Apply [ADR 0014 D10–D11 and D30](../adr/0014-operator-decisions-2026-10-23.md): deterministic checks block; run parallel LLM judges before the gate; each judge reports all findings in one pass, with `BLOCKING` reserved for material defects and a reproduction preferred. The review panel is `standards`, `spec`, and `adversarial` ([`src/flow/types.ts`](../../src/flow/types.ts)); `krn/judge-standards` and `krn/judge-spec` are published only from a record with `panelVerdict` PASS or a recorded D10 override. Allow two review attempts by default, then the lead decides; each extra ordinal needs its explicit operator exception. Run cheap preflight (types, lint, documentation-reading tests, test-impact review, and contracts) before review. Under the ADR 0014 D30 amendment, the full Product gate is required CI on the exact HEAD (`npm run gate`): `krn/gate` from GitHub App `5548482`, selected from the authoritative PR base. Independent preflight and review remain mandatory. `npm run gate:local` remains available for optional local diagnostics (source-selected isolation tests with zero isolation skips); delivery does not invoke it or wait for host load. Global does not run its full local gate.

Run `npm run preflight` before review: it reuses types, lint, rules, task check, documentation and core-import observers. Manually review test impact and run the changed behavior's observers and real receiver proof. This is separate from the networked exact-head `scripts/pr-preflight.mjs` used by ship.

Create a draft PR first, then run `krn review --repo <repo> --pr <number> --base <exact-base-sha> --head <exact-head-sha> --lens <lens> --prepass --checklist docs/program/hardening-checklist.md`. The direct API and CLI verify authoritative PR metadata before cost. The budget is two attempts per canonical base repository + PR number + target base ref, shared across worktrees through Git's common-directory anchor and `.krn/runs/review-series/`. Head, session, URL spelling and moving main do not reset it; inconsistent established base refs fail closed. A PR-bound review runs red-first and parses per-commit change contracts before reserving an ordinal; deterministic failures refuse with zero attempts consumed. After red-first passes, the ordinal is reserved before prepass or judges; input errors and crashes during red-first consume zero, while crashes after reservation consume one. Corrupt, gapped or missing established state refuses review/admission without stale-lock recovery. Earlier incomplete consumption can precede a later complete attempt on the same or a different head; current exact-head evidence must be complete. Unbound legacy v1/v2 evidence still parses but cannot admit a PR; never infer a count from `round`.

PR admission requires the reviewed base to be an ancestor of the requested base and exact head, allowing the target base to move without another review attempt.

For prior verification, add `--prior-record <prior-record.json>` with the first FAIL record (a regular, non-symlink file of at most 1 MB), bound to the same PR series and the same panel roles. Deterministic checks always block under D10. Each judge verifies every prior BLOCKING finding with `RESOLVED` or `UNRESOLVED` and evidence. New findings are advisory unless marked as regressions introduced between the prior and fixed heads in a changed file; only those regressions and unresolved prior findings block. The record preserves prior provenance, statuses, and demotions. A checklist supplied with `--prepass --checklist` becomes a panel search aid in this mode, without a separate blocking prepass.

After two attempts the lead decides. Each additional ordinal requires `--budget-exception <path>`: a strict JSON object with `schemaVersion: 1`, canonical `repository`, `pr`, `baseRef`, exact `ordinal` (at least 3), exact `headSha`, nonempty `authority` and `evidence` recording the explicit operator exception. See the [README example](../../README.md). The exception is kept in the reservation and raw record and cannot grant another slot/head. Acceptance override (`--override --reason <text> --evidence <text>`, plus `--pr <number> --base <exact-base-sha>` for a bound record) preserves PR binding, grants no budget and never bypasses deterministic FAIL or incomplete current evidence.

When an outcome uses a delivery-loop capsule, its state belongs at `.krn/runs/delivery-loop/<outcome-id>/state.md`. The delivery-loop owner is its sole writer; use `krn state check` to validate it and `krn state resume` to resume it. Durable repository decisions belong in `CONTEXT.md` and `docs/adr/`. Native Goals, transcripts, and personal memory are not durable repository truth.

## Roles and delivery

Briefs and reviews use the single [hardening checklist](hardening-checklist.md); `krn brief check` verifies brief coverage and `krn deliver` requires a review digest matching the head checklist.

The lead follows the project skills in `.agents/skills` (also exposed to Claude Code through `.claude/skills`): `krn-lead` for the slice loop, `krn-retro` when a slice ends, and `krn-handoff` to start the next slice in a fresh session.

Merges go only through `krn ship`, which pins the reviewed head through the pull request API under D21.

- **Lead:** follows [lead rules](lead-rules.md), owns the outcome loop, and decides after two review attempts by default. Do not treat a task update or worker handoff as acceptance.
- **Worker:** implements the assigned work and returns changes, evidence, and limits. Every fix round starts in a fresh session and ends with a one-page handoff. Use `--resume` only for an interrupted run and refuse it above 500k tokens. Universal worker hygiene belongs in the worker wrapper; KRN conventions belong in this repository.
- **Judge:** independently reviews the requested standards or specification against the exact candidate head SHA. Judges run in parallel and return one complete finding set each. Only material defects block, preferably with a reproduction. Required CI and successful independent Standards and Spec reviews are required for PR merge on the same SHA; authors never judge their own work.

Use one writer per outcome at a time and transfer the writer role explicitly before a mutating handoff. Parallel implementation uses isolated worktrees and returns through one integrator; independent read-only work may run in parallel. Reuse recorded authority for the same outcome's commit, push, PR, and merge without repeating per-step prompts.

## Lessons and corrections

KRN tooling does not enforce or create the standalone `docs/research/workflow-lessons.md` page; lesson findings are warnings, and existing pages in other repositories remain theirs (ADR 0014 D27). Put lessons where the executor reads them: mechanical checks first and repository `AGENTS.md` second; lead memory is only for operator preferences and decisions. Turn regressions into expected behavior or mechanical rules for code invariants; do not add lint that pins implementation technique. Fix flaky tests. A single recorded retry is allowed only for untouched files while a fix is pending. Use private test temp directories, condition waits with deadlines, and no wall-clock assertions.

Backups are temporary: back up, edit, verify, and delete in the same step. Host migrations may retain one only for the observation window.

Use Conventional Commits for authored commits, PR titles, and squash subjects. For a repository that has `npm run changes:check`, a commit changing its guard contract records `Change-contract: <check>:red->green` with its `Ticket:` trailer in the same trailer block. The contract names an existing executable check. Changed or new observers need observed before-state via `--before`; behavior-preserving changes keep their checks green. Run `npm run changes:check` to verify declared predictions.

At every terminal PR, `$delivery-loop` records each owned branch and worktree as retired under recorded deletion authority after preserving needed evidence, or retained with one owner, consumer, and removal trigger. A merged head branch is retired locally and remotely and its worktree removed in the same closeout. For a closed unmerged or superseded PR, retain a branch or worktree only while a named successor or evidence consumer needs it; otherwise preserve needed evidence and retire it under deletion authority. PR closure grants no deletion authority. Do not delete another owner's ref or worktree, and leave none unowned.

Keep the minimal set of true, current docs. Delete outdated docs; Git history is the archive. Stale instructions lose to current code and passing tests.
