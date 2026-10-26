# KRN delivery plan

This plan records program sequence and exit conditions. It is not task status, acceptance, or authority. Product's shipped in-repository `krn task` tracker is the task-status source under [ADR 0015](../adr/0015-repository-task-tracker.md). Product's Paperclip integration is removed (#109), no legacy board data is imported, and GLOBAL's Paperclip removal remains backlog work.

## Scope and decision owners

The sequence covers delivery flow, gate quality, and memory. Product and Global KRN remain separate until the measured trigger in [ADR 0013](../adr/0013-repository-consolidation.md). Work one accepted outcome at a time and name work by its role and purpose, not by phase, slice, ticket, round, date, or version.

Apply [ADR 0014 D10–D11](../adr/0014-operator-decisions-2026-10-23.md): run cheap preflight (types, lint, documentation-reading tests, test-impact review, and contracts) before review; run independent judges in parallel; have each judge report all findings in one pass, blocking only for material defects and preferably with a reproduction; allow at most two rounds, then let the lead decide. Product's `npm run gate:local` runs after review. CI runs the same steps. The operator retains approval for host, security, and irreversible actions.

## Sequence and exit checks

### Scope and hygiene

Keep one current sequence, use the in-repository tracker for task status, and limit work to accepted outcomes. Outdated instructions lose to current code and passing tests.

**Exit:** active work has a role owner and tracker record; stale plans and snapshots do not act as status sources.

### One merge path and delivery record

Keep Global KRN's `krn ship` as the only merge path. Product has no `ship` handler; KRN-06 forwards it to Global, which performs the merge. Before review, Product runs its cheap preflight. After review, Product runs `npm run gate:local`; CI runs the same steps. The delivery record binds base/head, checks, independent exact-head reviews, CI, merge SHA, and main CI.

**Exit:** a focused falsifier shows that Global `krn ship` cannot bypass required evidence, and one delivery record contains all required review, gate, and CI evidence.

### Qualified worker environment

Qualify the worker environment on a real task. It must support required tests and commits in its own worktree without access to secrets or the host. Each fix round uses a fresh session and a one-page handoff; resume only interrupted runs and refuse resume above 500k tokens. Fix flaky tests; allow one recorded retry only for untouched files while a fix is pending.

**Exit:** observed qualification proves the required capabilities and confinement.

### Product delivery flow

Run one real delivery through Product `krn delegate` and `krn review`. Use `krn task` as the task-status source. Local `krn review` records and git history provide review and delivery evidence without board publication. Use the delivery to identify runtime boundary gaps without inferring broader ownership migration from one delivery.

**Exit:** one real delivery completes through both commands with parallel independent exact-head reviews, the required gates, and CI.

### In-repository task tracker

Product's shipped tracker uses committed `tasks/<id>.json` records, dependencies, readiness, claims, and one `krn task` command with create, show, list, ready, claim, release, close, dep, edit, and check verbs. `--json` returns an `ok` envelope. The lead manages readiness, claims, releases, and closure; workers receive their task id in the brief and use it in commit titles and the `Ticket:` trailer. No Paperclip or legacy queue data is imported. Product Paperclip integration was removed in #109, and GLOBAL forwards `krn task` to Product (#457, #459); the remaining tracker-related work is removing Paperclip from GLOBAL.

**Exit:** Product tracker behavior and forwarding are shipped; the remaining GLOBAL Paperclip removal is tracked in `tasks/` and does not require a data import or per-project cutover.

### Reviewed memory loop

Capture only approved delivery fields as evidence. Review episodes, reusable lessons, and any rule or check as separate steps. Measure review rounds and delivery incidents. The proposed always-on agent is dropped. Put lessons where the executor reads them: mechanical checks first, repository `AGENTS.md` second, and lead memory only for operator preferences and decisions.

**Exit:** capture is explicit, each promotion step has review evidence, and outcome measures are recorded.

## Open items

- **P-052:** complete the caller inventory under ADR 0013 before runtime or repository ownership migration; include the legacy Git-ref task queue and remaining compatibility callers.
- **P-060:** verify the proposed `krn ship` path and Product preflight integration from code and CI before acting; task status comes from `krn task`.
- Consolidation starts only if an ADR 0013 trigger is observed over its specified ten-PR sample.

See [proposal register](proposals.md), [lead rules](lead-rules.md), and [ADR index](../adr/README.md).
