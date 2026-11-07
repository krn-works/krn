# Multi-step work plans

Use a living plan for work spanning sessions, pull requests, or modules. Keep task plans in ignored repository state under `.krn/runs/<owner>/<outcome>/plan.md`; a plan is working state, not durable policy or task status.

## Required contents

- Outcome and observable result.
- Current task, owner, authority, checkout, base/head, and dirty-file ownership.
- Progress, verified discoveries, decisions, and remaining work.
- Ordered file-level steps, exact checks, expected evidence, and recovery path.
- The next action needed to resume without relying on an unrecorded conversation.

## At each stopping point

Update progress and discoveries before a long command, handoff, commit, or interruption. Read current Git and in-repository tracker state back; do not copy stale status from a previous plan.

## Proof

- Each changed runtime contract needs a focused falsifier. Where applicable, observe it fail by assertion at the base before making it pass.
- Never invent a before-state, acceptance, or clean result. Compare a failure with the base before attributing it to the change.
- Do not weaken or remove an existing test or gate to reach green.
- Delivery is the no-gates loop in `lead-rules.md`: `npm run lint`, `npm run check` and the touched tests locally (`npm run preflight` is the cheap local bundle), then auto-merge on required CI on the exact HEAD, the aggregate GitHub Actions `Check` (App `15368`; ADR 0014 D30). `krn review` and `npm run gate:local` are opt-in.
- Label evidence claims as defined in [`lead-rules.md`](lead-rules.md).
