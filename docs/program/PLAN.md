# KRN delivery plan

This plan records program sequence and exit conditions. It is not task status, acceptance, or authority. Product's shipped in-repository `krn task` tracker is the task-status source under [ADR 0015](../adr/0015-repository-task-tracker.md). The Paperclip host service and data were removed on operator order on 2026-10-27; no archive was made.

## Scope and decision owners

Follow [ADR 0014 D20–D24](../adr/0014-operator-decisions-2026-10-23.md). Keep one current sequence and work in progress to at most two deliveries. Product and Global remain separate until the measured trigger in [ADR 0013](../adr/0013-repository-consolidation.md). Name work by role and purpose, not by phase, slice, ticket, round, date, or version.

## Sequence and exit checks

### 1. Delivery proof

Run the two-week proof of full KRN against a plain harness, plus a market review, in parallel with FR-40. Measure operator minutes per merge, lead time p50/p90, review rounds and noise, escaped defects, and cost per PR. First extend delivery records, then compare them (`t-ste3f73` → `t-6vhm7we`).

**Exit:** comparison is recorded with raw per-task results and a win or loss for each metric.

### 2. Review evidence

First make red-first prove an assertion failure on base and a pass on head (`t-c2pnpbq`); then replace two Codex judges with `codex review` and Claude Code `/code-review` (`t-809s3yc`). Keep the exact-head record.

**Exit:** records show base=assertion/head=pass pairs and three distinct judge implementations.

### 3. One merge path and delivery record

Product merges through GLOBAL `krn ship` with the base-declared verifier (`krn.ship.json` → `scripts/pr-preflight.mjs`); the first real merges were #121 and #123. Next, `t-5wbkv1w` adapts `krn ship` to GitHub Team server-side rulesets on `main` in both repositories: merge through the pull request API pinned to the reviewed head, then require PRs and required status checks with no bypass. CI stays on the self-hosted fleet.

**Exit:** GitHub refuses a direct push and a PR missing a required check; one delivery record holds review, gate, CI, and merge evidence.

### 4. Memory test

Run FR-40 under D20, with the Wizard-of-Oz set as a harness pilot only. Check power first (`t-dpxbq2y`); below 0.8, the operator decides. The harness checks (`t-9ser2tw`) are paused; then run FR-40 (`t-y46gy0w`). Blinding (`t-sv9t252`) is paused.

**Exit:** threshold verdicts are recorded or the operator records a park decision.

### 5. Reviewed memory loop

Capture only approved delivery fields as evidence. Review episodes, reusable lessons, and any rule or check as separate steps. Measure review rounds and delivery incidents. The proposed always-on agent is dropped. Put lessons where the executor reads them: mechanical checks first, repository `AGENTS.md` second, and lead memory only for operator preferences and decisions. Task: `t-3ha9z96`.

**Exit:** capture is explicit, each promotion step has review evidence, and outcome measures are recorded.

## Paused until delivery proof

- Qualified worker environment — paused; `t-7zm0211` covers the CI-image gate; prior exit: real-task qualification proves required tests and commits in an isolated worktree without secrets or host access.
- Product delivery through `krn delegate` — paused; prior exit: one real delivery through `krn delegate` and `krn review` with independent exact-head reviews, gates, and CI.
- Orchestration build-out (`foreman`, `relay`, `hosts`, `trace`) — paused until proof metrics exist; prior exit: one end-to-end orchestration delivery with trace evidence.

## In-repository task tracker

Product's shipped tracker uses committed `tasks/<id>.json` records, dependencies, readiness, claims, and one `krn task` command. The lead manages readiness, claims, releases, and closure; workers receive the task id and use it in commit titles and the `Ticket:` trailer. No Paperclip or legacy queue data is imported. Product and GLOBAL Paperclip integrations were removed; GLOBAL forwards `krn task` to Product.

**Exit: met** (`t-sqfffx9`). The tracker is frozen to defects only, with no new features (D23).

## Open items

- **P-052:** complete the caller inventory under ADR 0013 before runtime or repository ownership migration; include the legacy Git-ref task queue and remaining compatibility callers.
- **P-060:** resolved by the merge-path state above; see the [proposal register](proposals.md).

See [proposal register](proposals.md), [lead rules](lead-rules.md), and [ADR index](../adr/README.md).
