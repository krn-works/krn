# Lead rules

Use these rules for evidence, proposals, handoffs, and delivery in Product KRN.

## Sources and evidence

- Resolve conflicts in this order: current operator instruction, accepted ADR or repository rule, `AGENTS.md`, this guide, then plans and run evidence. A proposal does not change an accepted decision.
- Read current Git and control-plane state before acting on a plan or handoff. Paperclip owns live task status until a project's explicit cutover under ADR 0011.
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
- Follow the repository workflow for PR policy, exact-head independent reviews, required CI, and Conventional Commits.
- Do not send messages to external services without explicit authorization. Do not perform host, production, install/seal, hook-trust, or other irreversible actions without their separate grant.
