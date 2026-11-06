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
- Run cheap preflight checks (types, lint, documentation-reading tests, test-impact review, and contracts) before review. Run parallel independent judges before the gate; each judge reports all findings in one pass, and only material defects are blocking, preferably with a reproduction. Allow two review attempts by default, then the lead decides; each extra ordinal requires its explicit operator exception. Under the ADR 0014 D30 amendment, the full Product gate is required CI on the exact HEAD (`npm run gate`): the aggregate GitHub Actions `Check` (App `15368`, `.github/workflows/ci.yml`), selected from the authoritative PR base. Independent preflight and review remain mandatory. `npm run gate:local` remains available for optional local diagnostics (source-selected isolation tests with zero isolation skips); delivery does not invoke it or wait for host load. Follow the exact-head review and required-CI policy, then use Conventional Commits.
- Do not send messages to external services without explicit authorization. Do not perform host, production, install/seal, hook-trust, or other irreversible actions without their separate grant.
- A client push or API error is not remote state: read the exact remote ref (`git ls-remote origin <ref>`, the PR `headRefOid`) before any retry, rebase or rewrite.
- A brief for a validator or schema states the full key set from the producer's code, each field's type, format and bounds, and the success semantics at once, with fixtures captured verbatim from the real producer; refusal-only observers are not red at base, so the proof asserts an accepted record too.
- After a FAIL in review attempt two, decide before fixing: a fix produces a head no attempt may review, so record the override on the reviewed head or file the extra-attempt exception first.
- A test that is red only in CI is reproduced in the runner shape before a fix round: the tree bind-mounted at `/home/runner/work/krn/krn` in a user namespace (`unshare -rm`) with `CI=true`.
- Run hygiene, cleanup and deliver resumption with absolute paths from the main checkout, never from inside a worktree they remove; a successful merge exits 0.
- The Bash tool runs each command inside `eval ... ||`, so `set -e` does not stop it: chain state-changing steps with `&&` or explicit `|| exit`.
- Before every review attempt, on the exact head: required `Check` success (the check `spec/ci-admission.json` selects at the PR base), every observer red at the PR base by assertion, the base `packageManager` pnpm present (`mise where pnpm@<version>`), and exactly one distinct `Ticket:` across the PR commits (deliver `--dry-run`).
- After ship, a removed worktree's review records live under `.krn/archive/worktree-runs/<branch>-<UTC>/`; archive lead-only evidence before ship when it must sit beside them.
- When the auto-mode classifier denies a granted step, never work around it: put the exact `! <command>` line in the handoff for the operator and continue with work that needs no such step.
- A user-level `skillOverrides` entry disables any project skill with the same name; when a repository skill does not load, check `~/.claude/settings.json` overrides first.

## Parallel lanes

- Run at most two lead lanes at once, the host cap of two deliveries. A lane is one lead session that owns one outcome: its own claimed task, its own worktree under `.krn/worktrees/`, and its own capsule and handoff under `.krn/runs/delivery-loop/<outcome>/`. One writer per outcome still holds; a lane never writes another lane's outcome, branch, PR, or capsule.
- Before claiming, list open claims in `.krn/task-claims` and open PRs, and pick a task whose `--allow` paths do not overlap another lane's open PR. Overlapping work waits for that merge.
- After the other lane merges, an unchanged head still ships without a new review when GitHub reports it mergeable and the merge did not change the gate policy; ship merges the reviewed head and refuses a conflict. Rebase only on a conflict, and treat the rebased head as new: verify and review again.
- Retry a delivery that stops on "main advanced" or on a main-checkout `index.lock` held by the other lane; both refusals are transient.

Use `npm run preflight` before review and manually review test impact and receiver proof. The local command reuses types, lint, rules, task check, documentation and core-import observers; ship's networked exact-head `scripts/pr-preflight.mjs` remains separate. Create a draft PR before `bin/krn review --pr <number> --repo <path> --base <exact-base-sha> --head <exact-head-sha> --lens <path>` with an absolute `--repo`; the lead skill's "Open traps" lists the workarounds for known delivery defects. Two attempts belong to canonical base repository + PR number + target base ref and survive head/session/worktree/URL/main-SHA changes. Reservation precedes cost, and a crash consumes its ordinal. Prior verification requires the same panel roles; deterministic checks always block. For each additional attempt record a separate explicit operator exception with `--budget-exception <path>`, bound to repository/PR/baseRef/exact ordinal/exact headSha and carrying authority/evidence as [documented](../../README.md). Acceptance override never grants budget. Missing or corrupt established state and unbound legacy evidence fail PR admission; current exact-head evidence must be complete, even if an earlier consumed attempt is incomplete.
