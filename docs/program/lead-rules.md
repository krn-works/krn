# Lead rules

Use these rules for evidence, proposals, handoffs, and delivery in Product KRN.

## Sources and evidence

- Resolve conflicts in this order: current operator instruction; current code and passing tests for behavior; accepted ADR or repository rule for decisions; `AGENTS.md`; this guide; then plans and run evidence. Treat instructions contradicted by code and passing tests as stale. A proposal does not change an accepted decision.
- Read current Git and in-repository tracker state before acting on a plan or handoff. Under [ADR 0014 D8](../adr/0014-operator-decisions-2026-10-23.md) and ADR 0015, `krn task` is the in-repository task-status source. No legacy board data is imported. Local `krn review` records and git history provide review and delivery evidence; no board publication replaces them.
- Start with the cheapest signal that could disprove a claim. Compare failures with the base before attributing them to a change.
- Label claims `[CODE]`, `[VENDOR]`, `[EMPIRICAL]`, `[OURS-EVIDENCE]`, `[HYPOTHESIS]`, or `[POLICY]`; cite a source location where available.
- Read ignored state only when needed. Use `git status --ignored --short`, `git check-ignore -v <path>`, and `rg --no-ignore --hidden` to establish its location; verify its claims in tracked sources or current state.

## Proposals and decisions

- Record unresolved proposals in [`proposals.md`](proposals.md) with a date, status, and source. Keep the register limited to proposals referenced by a current ADR or plan.
- Put accepted architectural decisions in ADRs and operational rules in their owning source, such as `spec/rules.json`. Update proposal status when its decision is recorded.
- Plans describe sequence; they do not create tasks, acceptance, or authority.

## Scope and delivery

- For work spanning sessions, PRs, or modules, maintain a living plan using [`PLANS.md`](PLANS.md). Read back the task, authority, checkout, base/head, and dirty-file ownership before a handoff.
- Use one writer per outcome. Preserve unrelated work and use only the authorized paths and delivery route.
- Run the cheapest relevant falsifier, then the required repository checks. Do not claim acceptance from a successful command alone.
- Run cheap preflight checks (types, lint, documentation-reading tests, test-impact review, and contracts) before review. Run parallel independent judges before the gate; each judge reports all findings in one pass, and only material defects are blocking, preferably with a reproduction. Allow at most two review rounds, then the lead decides. After review, Product runs `npm run gate:local`; CI runs the same steps. Follow the exact-head review and required-CI policy, then use Conventional Commits.
- Do not send messages to external services without explicit authorization. Do not perform host, production, install/seal, hook-trust, or other irreversible actions without their separate grant.
