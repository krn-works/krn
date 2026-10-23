# Current proposal register

This register keeps only proposals referenced by the current plan or ADRs. It does not create tasks or grant authority. `krn task` is the selected in-repository task-status source under ADR 0014 D8; Paperclip is legacy and is not a status source.

| ID | Status | Current disposition |
|---|---|---|
| P-052 | proposed | Complete the caller inventory before runtime or repository ownership migration; see [ADR 0013](../adr/0013-repository-consolidation.md). |
| P-058 | superseded by ADR 0014 D8 | The former host-SQLite `krn work` tracker design in [ADR 0011](../adr/0011-krn-work-tracker.md) is superseded by a Git-backed in-repository `krn task` tracker. |
| P-059 | superseded by ADR 0014 D10–D11 | Product review uses parallel judges and a preflight-before-review, `gate:local`-after-review order; see [the delivery plan](PLAN.md). |
| P-060 | status to verify from code and CI before acting | The proposal describes Global KRN's `krn ship` merge path with exact-head evidence and required CI. Product forwards `ship`; it does not implement merge. Paperclip is not a status source. |
