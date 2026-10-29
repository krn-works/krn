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
- Run cheap preflight checks before review. Under ADR 0014 D30, the full Product gate is required CI on the exact HEAD (`npm run gate`). After review, the lead runs `krn host-lock run --name gate -- npm run gate:local`: cheap preflight followed by only the source-selected isolation test files (including systemd), requiring zero isolation skips and preserving the `krn/gate-local` publication contract without repeating the full suite locally.
- Label evidence claims as defined in [`lead-rules.md`](lead-rules.md).
