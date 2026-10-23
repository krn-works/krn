# Current proposal register

This register keeps only proposals referenced by the current plan or ADRs. Paperclip owns live task status; this file does not create tasks or grant authority.

| ID | Status | Current disposition |
|---|---|---|
| P-052 | proposed | Complete the caller inventory before runtime or repository ownership migration; see [ADR 0013](../adr/0013-repository-consolidation.md). |
| P-058 | accepted in part; superseded in part by ADR 0011 | The tracker design is accepted in [ADR 0011](../adr/0011-krn-work-tracker.md); conflicting reuse details from the proposal do not apply. |
| P-059 | superseded by the 2026-10-22 decision and Global ADR 0007 | The lead may accept eligible PR work after required evidence and gates pass; operator approval remains for host, security, and irreversible actions. See [the delivery plan](PLAN.md). |
| P-060 | live status unverified; refresh from Paperclip before acting | The proposal makes Global KRN's `krn ship` the mandatory merge path with exact-head evidence, required checks, CI, and planned Product preflight integration. Product forwards `ship`; it does not implement merge. |
