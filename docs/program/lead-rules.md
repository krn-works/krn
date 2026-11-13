# Lead rules

Use these rules for evidence, proposals, handoffs, and delivery in Product KRN.

## Sources and evidence

- Resolve conflicts in this order: current operator instruction; current code and passing tests for behavior; accepted ADR or repository rule for decisions; `AGENTS.md`; this guide; then plans and run evidence. Treat instructions contradicted by code and passing tests as stale. A proposal does not change an accepted decision.
- Read current Git and in-repository tracker state before acting on a plan or handoff. Under [ADR 0014 D8](../adr/0014-operator-decisions-2026-10-23.md) and ADR 0015, `krn task` is the in-repository task-status source. No legacy board data is imported. Git history and PRs provide delivery evidence; no board publication replaces them.
- Start with the cheapest signal that could disprove a claim. Compare failures with the base before attributing them to a change.
- Label claims `[CODE]`, `[VENDOR]`, `[EMPIRICAL]`, `[OURS-EVIDENCE]`, `[HYPOTHESIS]`, or `[POLICY]`; cite a source location where available.
- Read ignored state only when needed. Use `git status --ignored --short`, `git check-ignore -v <path>`, and `rg --no-ignore --hidden` to establish its location; verify its claims in tracked sources or current state.

## Proposals and decisions

- Record unresolved proposals in [`proposals.md`](proposals.md) with a date, status, and source. Keep the register limited to proposals referenced by a current ADR or plan.
- Put accepted architectural decisions in ADRs and operational rules in their owning source, such as `spec/rules.json`. Update proposal status when its decision is recorded.
- Plans describe sequence; they do not create tasks, acceptance, or authority.

## Scope and delivery

- For work spanning sessions, PRs, or modules, maintain a living plan using [`PLAN.md`](PLAN.md#working-plans). Read it back before a handoff.
- Use one writer per outcome. Preserve unrelated work and use only the authorized paths and delivery route.
- Run the cheapest relevant falsifier, then the required repository checks. Do not claim acceptance from a successful command alone.
- Delivery is the no-gates loop: code in a worktree, run `npm run fast` once before commit (Biome `--write`, tsc and related tests on changed files, one verdict; CI runs the rest), push, `gh pr create --head <branch>`, then `gh pr merge --auto --squash`. The only gate is required CI on the exact HEAD: the aggregate GitHub Actions `Check` (App `15368`, `.github/workflows/ci.yml`). Codex workers and `npm run gate` are opt-in tools the lead picks when they save time, never prerequisites. Use Conventional Commits.
- Do not send messages to external services without explicit authorization. Do not perform host, production, install/seal, hook-trust, or other irreversible actions without their separate grant.
- A client push or API error is not remote state: read the exact remote ref (`git ls-remote origin <ref>`, the PR `headRefOid`) before any retry, rebase or rewrite.
- A brief for a validator or schema states the full key set from the producer's code, each field's type, format and bounds, and the success semantics at once, with fixtures captured verbatim from the real producer; refusal-only observers are not red at base, so the proof asserts an accepted record too.
- A test that is red only in CI is reproduced in the runner shape before a fix round: the tree bind-mounted at `/home/runner/work/krn/krn` in a user namespace (`unshare -rm`) with `CI=true`.
- A claim about cost or throughput cites a `krn ledger` window (`--window <from> <to>` or `--last <n>`, run from the main checkout; a linked worktree exits 64) with its PR count; dollars per PR from one slice or one day is not evidence. `krn state retro --task <id>` prints the window of the task's span.
- Run hygiene, cleanup and deliver resumption with absolute paths from the main checkout, never from inside a worktree they remove; a successful merge exits 0.
- The Bash tool runs each command inside `eval ... ||`, so `set -e` does not stop it: chain state-changing steps with `&&` or explicit `|| exit`.
- When the auto-mode classifier denies a granted step, never work around it: put the exact `! <command>` line in the handoff for the operator and continue with work that needs no such step.
- Above about 100k context, do not start a run longer than about 30 minutes as a session subagent: run it as a detached process writing results to a file under `.krn/runs/`, so a handoff neither waits on it nor kills it.
- A user-level `skillOverrides` entry disables any project skill with the same name; when a repository skill does not load, check `~/.claude/settings.json` overrides first.

## Parallel lanes

- Run at most two lead lanes at once, the host cap of two deliveries. A lane is one lead session that owns one outcome: its own claimed task, its own worktree under `.krn/worktrees/`, and its own capsule and handoff under `.krn/runs/delivery-loop/<outcome>/`. One writer per outcome still holds; a lane never writes another lane's outcome, branch, PR, or capsule.
- Before claiming, list open claims in `.krn/task-claims` and open PRs, and pick a task whose `--allow` paths do not overlap another lane's open PR. Overlapping work waits for that merge.
- After the other lane merges, rebase only on a conflict, push with `--force-with-lease`, and let auto-merge wait for the new `Check`.
- Retry a merge that stops on a main-checkout `index.lock` held by the other lane; the refusal is transient.

A plain PR with a `Ticket:` trailer (or none) merges on the `Check` alone.
