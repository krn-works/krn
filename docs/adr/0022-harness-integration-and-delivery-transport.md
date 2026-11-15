# 22. Harness integration and delivery transport: one hook process per event, gh for transport, evidence layer kept

Date: 2026-11-15

## Status

Accepted. Amends [ADR 0015](0015-repository-task-tracker.md) section "Routing": the entry pin stays until the plugin trigger below fires. Consistent with [ADR 0016](0016-pull-request-is-the-delivery-record.md): the pull request stays the delivery record, and this ADR removes transport code around it. KRN-07 is unchanged. Plugin and MCP distribution (J6 D2, D3) and moving the session relay out (J6) are deferred behind named triggers.

## Context

- Hook cost (judge-J6 F1, reproduced in judge-J10 section 1):
  - A Bash call starts about 8 Node processes.
  - `context-gauge` is registered three times in the project and once more on the host.
  - Module import alone costs 150 to 700 ms.
  - Adopted-repository hooks pay a second Node start through `spawnSync` (judge-J1 F6).
  - p50 is 111 ms for bash-guards, 150 ms for piped-check and 461 ms for context-restart.
  - The "2.5 to 3 h a week" figure is an upper bound: hooks on the same event run in parallel and the machine was at load 37.
- False Stop refusals (judge-J9 F1, corrected in judge-J10 section 1):
  - 126 "no commit on this branch yet" refusals hit lanes in two days.
  - 83% came after `verdict: merged`.
  - Three patches to the Stop logic already landed (#854, #869, #1013).
  - The cause is that ship deletes the branch and worktree. A Stop that refuses falsely teaches agents to ignore it.
- Transport duplicates `gh` (judge-J6 F4, delivery.md):
  - `src/ci` plus `src/deliver` is 1,832 lines.
  - 42 of its 76 commits (55%) are fixes, against 26% repo-wide.
  - `ship.ts` documents 15 exit codes for `gh pr create`, `gh pr merge --auto --squash` and `gh pr checks --watch`.
  - Native subagents do most lane work. Headless `krn lane run` ran about 16 times and serves the outside rows.
- KRN-07 (judge-J10 section 2): App `15368` is GitHub Actions itself. The required `Check` runs on any push that triggers workflows and is enforced by branch protection, so auto-merge waits for it whoever pushes. `app-token.ts` mints a separate delivery-App token. Whether a push made with plain `gh` triggers the workflow is settled by one test PR.
- Successor is in daily use: 552 `successor-launch` calls in transcripts. The launch log is broken, with 1 row (judge-J10 section 1). J6's and J9's "barely used" finding is rejected.
- There are zero real adopted repositories. A plugin now would add version drift between the plugin and `krn.json` with no consumer (judge-J10 section 3; judge-J6 R6).

## Decision

1. **One dispatcher per hook event.**
   - `.claude/settings.json` holds one `krn hook <event>` entry per event: SessionStart, UserPromptSubmit, PreToolUse, PostToolUse, Stop, SubagentStop.
   - The dispatcher routes in process, with lazy `import()` and no `spawnSync`. It writes one timing line per run to `.krn/hook-timings.jsonl`.
   - KRN's own settings and adopted repositories use the same entry. The `scripts/claude/*` shims go.
2. **Latency budget, as tests over the timing log.**
   - Per-tool-call events: p50 ≤ 60 ms, p95 ≤ 150 ms.
   - SessionStart: p95 ≤ 500 ms.
   - Stop without the judge: p95 ≤ 400 ms.
   - Advisory hooks fail open. Stop and scope fail closed.
3. **Hook diet.**

   | Hook | Disposition |
   |---|---|
   | `context-gauge` | once, on PostToolUse; the host copy is removed |
   | `subagent-hook-errors` | leaves the per-tool path; the dispatcher's own error line replaces it |
   | `cc-clearing-watch` | becomes a timer |
   | capability index | deleted (ADR 0020) |
   | `lead-file-read` | becomes a line in the krn-lead skill |
   | `stop-failure.ts` | deleted |
   | bash-guards, scope, edit-standards, memory-budget, subagent-model, stop | kept as routes |

4. **A lane ends at "auto-merge enabled".**
   - Ship no longer deletes the lane's worktree or branch.
   - The lead removes merged worktrees at the next lane start, with `git worktree prune` plus deleting branches merged into `origin/main`.
   - Stop gets no fourth patch.
5. **Transport is `gh`.**
   - First, one test PR is pushed and merged with plain `gh pr create` and `gh pr merge --auto --squash`.
   - If the required `Check` runs and gates the merge, `krn pr ship` becomes a thin verb: run the task's Proof commands, apply the title rule, then those two `gh` calls, then print `verdict:`.
   - Deleted in that case: `src/deliver/*`, and `src/ci/{wait,logs,gh-reply,git-lock,rebase-generated}.ts`.
   - `app-token.ts` and `scripts/app-bin/gh` stay only if the test PR shows the App identity is needed to start workflows.
   - `krn ci wait|logs` are removed from skills in favour of `gh pr checks --watch` and `gh run view --log-failed`.
6. **Lanes use native isolation.**
   - `krn lane start` becomes `krn task claim` plus the harness's worktree isolation (`isolation: worktree` on `krn-lane`).
   - `krn lane brief` stays; it is the task-start packet.
   - Headless `krn lane run` stays only as the session driver of the replay harness (ADR 0021). It uses `claude -p --worktree --max-budget-usd` in place of its own worktree, preflight and git code.
   - `lane-canary` and `lane-lock` are deleted.
7. **Evidence layer kept:** Stop proof, the proof line, the `krn ledger`, the repo contract and the `Ticket:` check in CI.
8. **Session relay stays in the repository as workshop code** (ADR 0017).
   - The launch log is fixed to record every launch, and the `hc` host path is removed until t-f3sdx0f.
   - No `krn handoff` command is built now.
9. **Codex parity comes from one table.** `.codex/hooks.json` is generated from the same event table as `.claude/settings.json`. `krn_capsule.py` is replaced by `krn hook session`, or moved into the repository with a test.
10. **Deferred, with triggers.**
    - A Claude Code plugin is built when at least 2 real operator repositories run KRN hooks through `krn adopt`, or when ADR 0021 shows C > A. It then replaces the entry pin, `product-release.sh` and the hook-entry writer.
    - An MCP query tool waits for ADR 0020's stop rule.

## Expected effect

- Hook processes per Bash call fall from about 8 to 2 (one Pre, one Post). Measure: count of `command` entries per event in `.claude/settings.json`, which becomes 1.
- Tool-call hook p50 falls from 111–150 ms to at most 60 ms, and p95 to at most 150 ms. Measure: `krn doctor --hooks` over `.krn/hook-timings.jsonl`, cross-checked with transcript `durationMs`.
- Stop refusals on lanes whose PR merged fall from about 60 a day to under 2 a week. The refusals before any merge (19 in the sample) still occur. Measure: transcript scan `grep -c "no commit on this branch yet"`, split by a preceding `verdict: merged`.
- Median open-to-merge stays at or under 2 min and the merged rate at or above 99%. Measure: `krn ledger --limit 50`.
- Fix commits in `src/ci`, `src/deliver` and `src/cli/lane*` fall from 73 in 30 days to under 10. Measure: `git log --since=30.days --oneline --grep='^fix' -- src/ci src/deliver src/cli/lane* | wc -l`.
- `successor-launch` calls are logged: rows added to `.krn/successors/launches.jsonl` per week equal transcript calls, within ±10%.
- The required `Check` gates every merge: 0 merges to main without a successful `Check` on the head. Measure: `gh pr list --state merged --limit 50 --json statusCheckRollup`.

## Consequences

- Deleted, about 2,900 lines of `src`, conditional on the test PR for the first two rows:
  - `src/deliver` (536);
  - most of `src/ci` except `ship.ts` (thin), `commit-title.ts` and `app-token.ts` (about 800);
  - `src/cli/lane-run/{worktree,preflight,git}.ts`, lane start's worktree code, `lane-canary.ts`, `lane-lock.ts` (about 900);
  - `src/hook/subagent-hook-errors.ts`, `src/hook/lead-file-read.ts`, the `spawnSync` path in `src/cli/hook.ts`;
  - `src/successor/host-hc.ts`;
  - `src/context/cc-clearing-watch.ts` hook wiring.
- Deleted scripts:
  - 20 or more `scripts/claude/*` shims;
  - `scripts/claude/stop-failure.ts`, `scripts/claude/ci-poll.ts` (folded into the bash-guards route), `scripts/lane-canary.ts`;
  - `scripts/claude/spend-window.py`, since `src/outcome/window.ts` equals it to the cent (ADR 0016).
- `krn-lead/SKILL.md`, `lanes.md` and the delivery-* skill copies change their ship and CI lines.
- `.krn/product-release` and `entry-pin.ts` stay until point 10's trigger.

## Falsified if

- The plain-`gh` test PR merges without the required `Check` running, or the `Check` does not start. Then the App-token path stays and only wait/logs/gh-reply/git-lock are cut.
- After the dispatcher, tool-call p95 has not fallen by at least 50%. Then Node start, not process count, dominates, and the response is a persistent hook daemon.
- Ledger rows show more `unknown` cells, or median open-to-merge rises above 3 min over 50 PRs. Then the removed transport carried evidence, and the missing piece returns as a ledger adapter, not as transport.
- Merged-lane refusals stay above 30 a week. Then F1 was misdiagnosed, and Stop keys on the merged PR for the claim.
- A dispatcher import error disables a fail-closed hook in a real session, even once. Then routes get per-route isolation (`try`/`import` per route with a failing test).
