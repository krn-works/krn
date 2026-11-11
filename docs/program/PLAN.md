# KRN delivery plan

This plan records program sequence and exit conditions. It is not task status, acceptance, or authority. Product's shipped in-repository `krn task` tracker is the task-status source under [ADR 0015](../adr/0015-repository-task-tracker.md). The Paperclip host service and data were removed on operator order on 2026-10-27; no archive was made.

## Scope and decision owners

Follow [ADR 0014 D20–D29](../adr/0014-operator-decisions-2026-10-23.md). The numbered tracks are a sequence, not parallel work; the WIP limit counts deliveries in flight, at most two. Product is the one repository ([ADR 0013](../adr/0013-repository-consolidation.md), trigger superseded). Name work by role and purpose, not by phase, slice, ticket, round, date, or version.

## Sequence and exit checks

### 1. Delivery proof

Run the two-week proof of full KRN against a plain harness, plus a market review, in parallel with FR-40. Measure lead time p50/p90, review rounds and noise, escaped defects, and cost per PR. First extend delivery records, then compare them (`t-ste3f73` → `t-6vhm7we`).

**Exit:** comparison is recorded with raw per-task results and a win or loss for each metric.

### 2. Review evidence

KRN ships no review command or judge panel (ADR 0014 D10/D22 amendment). Review is opt-in (KRN-07): `codex review` or Claude Code `/code-review`.

**Exit:** a reviewed PR names the reviewer and the head it covered.

### 3. One merge path and delivery record

Product merges through GitHub auto-merge: the author pushes, opens the PR and runs `gh pr merge --auto --squash`; GitHub merges once the required Actions `Check` (App `15368`) passes on the exact HEAD (ADR 0014 D30). GitHub refuses direct pushes and PRs missing the required check.

**Exit:** GitHub refuses a direct push and a PR missing a required check; one delivery record holds review, gate, CI, and merge evidence.

### 4. Memory test

Run FR-40 under D20, with the Wizard-of-Oz set as a harness pilot only. Check power first (`t-dpxbq2y`); below 0.8, the operator decides. The harness checks (`t-9ser2tw`) are paused; the eval session accounting must match real Codex captures (`t-1hg9s06`); then run FR-40 (`t-y46gy0w`). Blinding (`t-sv9t252`) is paused.

**Exit:** threshold verdicts are recorded or the operator records a park decision.

### 5. Reviewed memory loop

Capture only approved delivery fields as evidence. Review episodes, reusable lessons, and any rule or check as separate steps. Measure review rounds and delivery incidents. The proposed always-on agent is dropped. Put lessons where the executor reads them: mechanical checks first, repository `AGENTS.md` second, and lead memory only for operator preferences and decisions. Task: `t-3ha9z96`.

**Exit:** capture is explicit, each promotion step has review evidence, and outcome measures are recorded.

## Paused until delivery proof

- Qualified worker environment — paused; `t-7zm0211` covers the CI-image gate; prior exit: real-task qualification proves required tests and commits in an isolated worktree without secrets or host access.

## In-repository task tracker

Product's shipped tracker uses committed `tasks/<id>.json` records, dependencies, readiness, claims, and one `krn task` command. The lead manages readiness, claims, releases, and closure; workers receive the task id and use it in commit titles and the `Ticket:` trailer. No Paperclip or legacy queue data is imported. Product and GLOBAL Paperclip integrations were removed; `krn` on the host links to this repository, and there is no forwarder.

**Exit: met** (`t-sqfffx9`). The tracker is frozen to defects only, with no new features except comments under D29 (`t-30wmab4`).

## Open items

- **P-052:** complete the caller inventory under ADR 0013 before runtime or repository ownership migration; include the legacy Git-ref task queue and remaining compatibility callers.
- **P-060:** resolved by the merge-path state above; see the [proposal register](proposals.md).

## Consistency repair (operator 2026-10-28)

- `t-rcs9vtn` — record decisions D25–D29 and align Product program docs.
- `t-8zvy7c5` — enforce the two-round review limit in the engine and preflight.
- `t-30wmab4` — add comments to `krn task` under the D29 exception.
- `t-m1mxsfp` — retire lesson-page enforcement and Beads setup in GLOBAL.
- `t-gdct2bc` — align GLOBAL instructions with D10–D13, D18, D21, and D22.
- `t-5fd4gcn` — remove legacy tracker and process references from GLOBAL docs.
- `t-zkepy2m` — move host lead policy into GLOBAL and install it by release.

See [proposal register](proposals.md), [lead rules](lead-rules.md), and [ADR index](../adr/README.md).
