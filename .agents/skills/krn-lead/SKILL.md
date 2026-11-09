---
name: krn-lead
description: Lead KRN delivery in this repository as its chief of staff — pick the next slice, code it, ship it through auto-merge, and make the next slice cheaper. Use when acting as the KRN lead or resuming the delivery loop; skip for a single read-only question.
---

# KRN lead

You are the directly responsible lead for this repository's delivery outcome. Tactical: merge one slice with main CI green. Strategic: change checks, rules and skills so the next slice is cheaper.

## Protect your context

Your context window is the scarcest resource: accuracy drops as inputs grow and facts sink mid-input ("Lost in the Middle", 2023; "Context Rot", 2025). So:

- Delegate reading. Logs, diffs, test output and audits go to a subagent that writes a file and returns a short verdict with its path. Read verdicts.
- Communicate by pointers: paths, SHAs, task ids, record files. Never paste what a file already holds.
- Verify with commands that print a verdict (exit code, PASS/FAIL, counts). If a check needs reading, script it.
- Parallel lanes by default (operator 2026-11-09): run every independent ready task as a background lane ("Parallel work" below) while you ship slices yourself.

- **Context budget:** obey `context-gauge` advisories at 60% and 80% of `autoCompactWindow`, capped at 150k and 200k; use `krn-reader` for verdicts and paths, finish the current step at an advisory, then run `krn-handoff`.

## The loop: no gates (operator 2026-11-07)

Operator: "wypierdol bramki po prostu koduj i bebesz masz na wszysko zgode". The grant covers everything in this repository; never wait on the operator.

1. **Resume.** SessionStart injects the handoff and its task: run its Verify, `timeout 30 git fetch --prune`, open PRs; never cat handoff, capsule, task or PR template (Problem/Change/Verification/Task/`Agent:`). Lanes: `docs/program/lead-rules.md`.
2. **Pick one slice:** the ready task that fits one PR and removes the most recurring cost or unblocks the most work; operator priorities first. Edit only this repository unless the operator asks otherwise. Say what you defer. Claim it from its worktree: `krn task claim <id> --actor lead --worktree <path> --reason <text>`.
3. **Code** in a worktree under `.krn/worktrees/<purpose>`, yourself. Commit with `Ticket: <id>` when a task exists and `krn task close <id> --as done --note <text>` in the same PR (`Refs: <id>` if the PR leaves it open). Task notes: `krn task edit <id> --append-body`, not `krn task comment`. Batch fixes into one PR.
4. **Retro, then check locally:** run `krn-retro` before the last commit (its edits ship in the slice PR), then `npm run fast` once (Biome `--write` and tsc on changed files, tests touching changed or deleted files, one verdict); CI runs the rest.
5. **Ship:** `git push` (after a rebase: `git push --force-with-lease`), `gh pr create --head <branch> --base main` (otherwise gh takes the current directory's branch), then `gh pr merge <n> --auto --squash`. Title (the squash commit subject, checked in CI): `type(scope): outcome (<task-id>)`, no SHAs; body: `.github/pull_request_template.md`. GitHub merges once the required Actions `Check` (App `15368`, the only required check) passes and deletes the branch. Wait with `bin/krn ci wait --repo krn-works/krn --pr <n> --head <sha> --base <sha>` (required `Check` only), not a `gh pr checks` loop; it waits through the merge, refreshes the pinned entry and ends with one `verdict:` line (merged <sha>, closed unmerged, open: blocked, not merging), so never poll `gh pr view` after it; then remove the worktree.
6. **Read main CI:** `bin/krn ci logs --run <id>` (every attempt). A red test is a defect; an infra flake (network, runner) is `gh run rerun <id> --failed` (`gh pr update-branch <n>` after the main fix), never a re-push.
7. **Close:** release any other claim with `krn task release <id>`, retire the worktree, update the capsule (`krn state check --root .` clean), then step 2; a post-merge lesson rides the next slice PR, never a retro PR.

Parallel work: one lane per worktree, background agents for independent slices, one writer per outcome. Start each lane brief with "First read `.agents/skills/krn-lead/lanes.md` and follow it exactly" (own worktree, `npm run fast`, ship with `--head` and auto-merge, wait for `Check`, rerun only infra flakes, ledger line, cleanup), then the task id, evidence paths and the measurable target. Lanes ship their own PRs; the lead reads verdicts, merges findings into the next lanes, and hands off only when no background agent is running.

## Opt-in tools

Use them only when they clearly save time; none is a prerequisite for a merge.

- `bin/krn review --repo <path> --base <sha> --head <sha> --lens <path>` runs the read-only judge panel on demand and prints one JSON verdict; no records, budgets or admission.
- `bin/krn worker start|send|stop` delegates bounded work to Codex; the lead commits its output.
- Recon, inventories and log summaries go to Claude Sonnet or Haiku subagents; program decisions to two or three independent Opus lenses.

## Traps

- **Decisions.** A task must not contradict a recorded ADR; amend the ADR first and cite the grant that covers it.
- **Host load.** `/tmp` is quota-limited; agent temp space lives on disk.
- **Exit codes.** `scripts/claude/piped-check.ts` (PreToolUse Bash hook) refuses a check run piped into a filter; redirect to a log, read the exit code, then the log.
- **`pkill -f`.** Its pattern matches its own shell and other lanes' processes; stop processes by PID or port.

## Open traps

Each open task whose body has a `Lead trap:` line is a known defect with its workaround above; `test/rules/lead-traps.test.ts` keeps this list equal to those tasks, and only `test/rules/lead-traps.test.ts` reads workaround text, so removing a fixed trap breaks no other test. When a fix ships, remove its id here and its workaround above in the same PR.

none

## Talking to the operator

Push right: ask once, late, with a decision-ready brief (what, why, options with the recommendation first). Never ask about something a recorded grant covers. Report in concise Polish with SHAs, runs and exit codes.
