# Architecture decisions

| ADR | Status | Decision |
|---|---|---|
| [0001](0001-product-krn.md) | accepted; single-package shape confirmed by 0017 | Product KRN is a private TypeScript package with a CLI strangler boundary. |
| [0002](0002-brain-v2.md) | accepted target; amended by 0019, 0020, 0021 | Temporal brain v2 is the memory target (ADR 0014 D31); record types, retrieval budgets and the retire rule are now set by 0019–0021. |
| [0013](0013-repository-consolidation.md) | accepted; amended by 0017 | Product is the repository home; the one-repository shape is now decided, with a measured exit test (0017). |
| [0014](0014-operator-decisions-2026-10-23.md) | accepted; amended by 0018 (D29 comments removed), 0019 (where decisions are queryable), 0021 (reading of the D23 comparison), 0023 (run checks) | Operator decisions D1–D37 for Product KRN. |
| [0015](0015-repository-task-tracker.md) | accepted; amended by 0018 (archive, fields, claim lock, comments) and 0022 (routing until the plugin trigger) | Git-backed repository task tracker and its shipped routing. |
| [0016](0016-pull-request-is-the-delivery-record.md) | accepted | A delivery is a pull request; KRN keeps no delivery store and derives windows from GitHub and git. |
| [0017](0017-one-repository-versioned-file-contracts.md) | accepted | One repository and one package; versioned file formats are the contract; research joins by candidate files; extraction only on a measured test. |
| [0018](0018-task-storage-file-per-task-with-archive.md) | accepted | One file per open task, monthly JSONL archive for closed tasks; tasks carry kind, area, stack and origin and are joined to the brain at claim and close. |
| [0019](0019-one-record-store-and-evidence-driven-remember-loop.md) | accepted | One record schema for durable knowledge; decisions are queryable but never served; the remember loop takes candidates only from CI, hidden-test, review and verbatim operator evidence. |
| [0020](0020-retrieval-moments-and-token-budgets.md) | accepted | Retrieval at four moments with a token budget each, keyed by the task; retrieval keys, a recall@5 eval and a stop rule for pull; the capability index is removed. |
| [0021](0021-proof-methodology.md) | accepted | Claims ladder; per-record violated signal; retirement by Fisher test; preregistered A/B/C with cost co-primary; metric predictions. |
| [0022](0022-harness-integration-and-delivery-transport.md) | accepted | One hook process per event with a latency budget; a lane ends at auto-merge; transport is gh behind the required Check; plugin and MCP deferred behind triggers. |
| [0023](0023-onboarding-installs-gates-that-run.md) | accepted | `krn adopt` installs gates that run, fills CI gaps without duplicating, and files categorised gate tasks; ratchets wait for a real adopter. |
| [0024](0024-one-tracked-plan-and-three-rule-sources.md) | accepted | One tracked plan every session starts from; rule sources fold to AGENTS.md, the plan and skills in two measured steps. |
| [0025](0025-agent-instruction-surface.md) | proposed; extends 0019 and 0024 | One text per rule (records and briefs cite it), one merge route that checks the PR body, skills from one source with a lane skill of their own, sessions that read their own tree. |
| [0026](0026-standards-simplification.md) | proposed | A rule is stated once, at its check or in AGENTS.md; KRN's own JSON rule stores go; the shipped pack stays one catalog. |
| [0027](0027-ship-state-model.md) | proposed | Ship and its sibling readers branch on one pure GitHub PR state classifier with a verbatim fixture per state, and one gh client owns retries. |
| [0028](0028-lane-lifecycle.md) | proposed | One reader of lane state (`src/lane/state.ts`), then one recorded lifecycle per lane; one parser per protocol line; seven ordered migration steps. |
