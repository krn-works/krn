# KRN delivery plan

This plan records program sequence and exit conditions. It is not live task status, acceptance, or authority. Paperclip owns task status until an explicit per-project cutover under [ADR 0011](../adr/0011-krn-work-tracker.md).

## Scope and decision owners

The sequence covers delivery flow, gate quality, and memory. Product and Global KRN remain separate until the measured trigger in [ADR 0013](../adr/0013-repository-consolidation.md). Read live work status from Paperclip; do not infer it from phase descriptions here.

After the evidence required by Global ADR 0007 and all required gates pass, the lead may accept eligible PR work. The operator retains approval for host, security, and irreversible actions. This records the 2026-10-22 decision; ADR 0012 is not an acceptance prerequisite.

## Phases and exit checks

### F0 — Scope and hygiene

Keep one current sequence, use the live control plane for task status, and limit work to the accepted streams.

**Exit:** active work has an owner and control-plane record; stale plans and snapshots do not act as status sources.

### F1 — One merge path and delivery record

**F1a:** Keep Global KRN's `krn ship` as the only merge path. Product has no `ship` handler; KRN-06 forwards it to Global, which performs the merge. The planned path must invoke Product preflight, which is not yet wired to `ship`, alongside exact-head evidence, changes check, gate, and CI.

**Exit:** a focused falsifier shows that Global `krn ship` cannot bypass the required evidence, and the Global path invokes the required Product preflight.

**F1b:** Record base/head, falsifier results, checks, reviews, CI, merge SHA, and main CI for each PR. Review all material findings in one complete pass.

**Exit:** one delivery record contains the required evidence and review returns a complete finding set.

### F2 — Qualified worker environment

Qualify the worker environment on a real task. It must support required tests and commits in its own worktree without access to secrets or the host.

**Exit:** observed qualification proves the required capabilities and confinement.

### F3 — Product delivery flow

Run one real delivery through Product `krn delegate` and `krn review` while Paperclip remains the control plane. Use the result to identify runtime boundary gaps; do not infer broader ownership migration from one delivery.

**Exit:** one real delivery completes through both commands with the required independent exact-head reviews and gates.

### F4 — Planned Product `krn work` pilot, no cutover

Product does not yet implement `work`; KRN-06 currently forwards it to Global KRN. Add and pilot the accepted tracker design in ADR 0011 while Paperclip remains authoritative. Include the selected task commands and one CLI falsifier.

**Exit:** the pilot meets ADR 0011 and its falsifier passes. This phase does not cut over a project.

### F5 — Per-project Paperclip cutover

Cut over one project at a time. Verify acceptance parity, history export and restore, rollback, and every active consumer. Do not mirror writes; keep Paperclip read-only after cutover.

**Exit:** one project passes those checks and its live status owner is read back after cutover.

### F6 — Reviewed memory loop

Capture only approved delivery fields as evidence. Review episodes, reusable lessons, and any rule or check as separate steps. Measure review rounds and delivery incidents. The proposed always-on agent is dropped.

**Exit:** capture is explicit, each promotion step has review evidence, and the outcome measures are recorded.

## Open items

- **P-052:** complete the caller inventory under ADR 0013 before any runtime or repository ownership migration.
- **P-060:** refresh its live status from Paperclip before acting; this plan does not assert a current status.
- Consolidation starts only if an ADR 0013 trigger is observed over its specified ten-PR sample.

See [proposal register](proposals.md), [lead rules](lead-rules.md), and [ADR index](../adr/README.md).
