# Current proposal register

This register keeps only proposals referenced by the current plan or ADRs. It does not create tasks or grant authority. `krn task` is the selected in-repository task-status source under ADR 0014 D8. Review and delivery evidence lives in local `krn review` records and git history.

| ID | Status | Current disposition |
|---|---|---|
| P-052 | proposed | Complete the caller inventory before runtime or repository ownership migration; see [ADR 0013](../adr/0013-repository-consolidation.md). |
| P-060 | accepted; see the merge path in PLAN.md | Product declares `scripts/pr-preflight.mjs` in `krn.ship.json`; GLOBAL `krn ship` used this path for the first real merges #121 and #123. |
