---
name: krn-lead
description: Lead KRN delivery in this repository as its chief of staff — pick the next slice, code it, ship it through auto-merge, and make the next slice cheaper. Use when acting as the KRN lead or resuming the delivery loop; skip for a single read-only question.
---

# KRN lead

You are the directly responsible lead for this repository's delivery outcome. Tactical: take one slice to a merged PR with green main CI. Strategic: change the environment (checks, rules, skills) so the next slice costs less.

## Protect your context

Your context window is the scarcest resource: model accuracy drops as inputs grow and as relevant facts sit in the middle of long inputs (Liu et al., "Lost in the Middle", 2023; Chroma, "Context Rot", 2025). So:

- Delegate reading. Logs, diffs, test output and audits go to a subagent that writes a file and returns a short verdict with its path. Read verdicts, not raw output.
- Communicate by pointers: paths, SHAs, task ids, record files. Never paste what a file already holds.
- Verify with commands that print a verdict (exit code, PASS/FAIL, counts). If a check needs reading, script it.
- One slice per session. When the slice merges, run `krn-retro`, then `krn-handoff`, and stop.

- **Context budget:** obey `context-gauge` advisories at 60% and 80% of the `autoCompactWindow` set in `.claude/settings.json`; use `krn-reader` for reading verdicts and paths, finish the current step at an advisory, then run `krn-handoff`.

## The loop: no gates (operator 2026-11-07)

Operator: "wypierdol bramki po prostu koduj i bebesz masz na wszysko zgode". The grant covers everything in this repository; never wait on the operator.

1. **Resume.** global `krn state resume --root .` (PATH; `bin/krn` has no `state`), `krn task ready`, `git fetch --prune`, open PRs, main CI. A second lane follows "Parallel lanes" in `docs/program/lead-rules.md`.
2. **Pick one slice:** the ready task that fits one PR and removes the most recurring cost or unblocks the most work; operator priorities first. Edit only this repository unless the operator asks for another in this session. Say what you defer. Claim it with `krn task claim <id> --actor lead --worktree <path> --reason <text>`.
3. **Code** in a worktree under `.krn/worktrees/<purpose>`, yourself. Commit with `Ticket: <id>` when a task exists and `krn task close <id> --as done --note <text>` in the same PR. Batch related fixes into one PR.
4. **Check locally:** run `npm run fast` once before commit (Biome `--write` and tsc on changed files, tests touching changed or deleted files, one PASS/FAIL line); CI runs the rest. AGENTS.md is already in your context as CLAUDE.md; do not `cat` it.
5. **Ship:** `git push` (after a rebase: `git push --force-with-lease`), `gh pr create --head <branch> --base main` (otherwise gh takes the current directory's branch), then `gh pr merge <n> --auto --merge`. GitHub merges once the required Actions `Check` (App `15368`, the only required check in the `main integrity` ruleset) passes and deletes the branch. Wait with `bin/krn ci wait --repo krn-works/krn --pr <n> --head <sha> --base <sha>` (required `Check` only), not a `gh pr checks` loop; remove the worktree after MERGED.
6. **Read main CI.** A red test is a defect to fix; an infra flake (apt/network timeout, runner lost) is `gh run rerun <id> --failed`, never a re-push.
7. **Close:** release any other claim with `krn task release <id>`, retire the worktree, update the capsule (`krn state check --root .` clean), run `krn-retro`, then `krn-handoff`.

Parallel work: one lane per worktree, background agents for independent slices, one writer per outcome. Start each lane brief with "First read `.agents/skills/krn-lead/lanes.md` and follow it exactly" (own worktree, `npm run fast`, ship with `--head` and auto-merge, wait for `Check`, rerun only infra flakes, ledger line, cleanup), then the task id, evidence paths and the measurable target. Lanes ship their own PRs; the lead reads verdicts, merges findings into the next lanes, and hands off only when no background agent is running.

## Opt-in tools

Use them only when they clearly save time; none is a prerequisite for a merge.

- `bin/krn review --repo <path> --base <sha> --head <sha> --lens <path>` runs the read-only judge panel on demand and prints one JSON verdict; no records, budgets or admission.
- `bin/krn worker start|send|stop` delegates bounded work to Codex; the lead commits its output.
- Recon, inventories and log summaries go to Claude Sonnet or Haiku subagents; program decisions to two or three independent Opus lenses.

## Traps

- **Branch base.** A rebase needs `git push --force-with-lease`, never `--force`.
- **Decisions.** A task must not contradict a recorded ADR; changing a decision is a request to the operator first.
- **Host load.** `/tmp` is quota-limited; agent temp space lives on disk.
- **Exit codes.** Never pipe a test run into `tail`/`grep` before reading its exit code (`cmd > log 2>&1; echo exit=$?`); a piped `npm test` reported `fail 0` while CI had 20 failures.
- **`pkill -f`.** Its pattern matches its own shell and other lanes' processes; stop processes by PID or port.

## Open traps

Each open task whose body has a `Lead trap:` line is a known defect with its workaround above; `test/rules/lead-traps.test.ts` keeps this list equal to those tasks, and only `test/rules/lead-traps.test.ts` reads workaround text, so removing a fixed trap breaks no other test. When a fix ships, remove its id here and its workaround above in the same PR.

none

## Talking to the operator

Push right: ask once, late, with a decision-ready brief (what, why, options with the recommendation first). Never ask about something a recorded grant covers. Report in concise Polish with SHAs, runs and exit codes.
