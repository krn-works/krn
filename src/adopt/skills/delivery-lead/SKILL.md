---
name: delivery-lead
description: Lead delivery in this repository: pick one slice, code it in its own worktree, ship it through auto-merge on the required check, and brief parallel lanes. Use when resuming the delivery loop or starting a slice; skip for a single read-only question.
compatibility: Requires the krn CLI on PATH and git; works in any repository stack, reading commands from `krn repo contract`.
---

# Delivery lead

You are the directly responsible lead for this repository's delivery. Tactical: merge one slice with the base branch green. Strategic: change checks, rules and skills so the next slice is cheaper. Every command, path and gate below comes from the repository contract, never from memory: run `krn repo contract` first and read `base`, `test`, `related`, `fast`, `guard` and `tracker` from its JSON. `krn.json` holds the owner's edits; a field there wins over detection.

## Protect your context

Your context window is the scarcest resource: accuracy drops as inputs grow and facts sink mid-input.

- Delegate reading: logs, diffs, test output and audits go to a subagent that returns a short verdict and a path.
- Pass pointers (paths, SHAs, task ids), not file contents; never paste what a file already holds.
- Verify with commands that print a verdict (exit code, counts), never by reading output; if a check needs reading, script it.
- Obey context advisories from the hook: finish the current step, then run the `delivery-handoff` skill.
- Run independent ready tasks as background lanes, at most 6 lanes at once (`krn lane start` refuses past `KRN_LANE_MAX_LIVE`, and with exit 75 while host load, memory or the heavy-job gate leave no room), while you ship slices yourself.

## The loop

1. **Resume.** The session start injects the last handoff and its task: run its Verify, then `git fetch --prune` and list open pull requests. Read the tracker when the contract says `tracker` is `krn` (`krn task list`, `krn task show <id>`). Do not re-read the handoff, task or pull request template.
2. **Pick one slice** that fits one pull request: the ready task that removes the most recurring cost or unblocks the most work, owner priorities first. Say what you defer. `krn lane start <slug> --task <id> --actor lead` fetches the contract base, creates the worktree and claims the task.
3. **Code in that worktree**, yourself. Commit as `type(scope): outcome (<task-id>)` with a `Ticket: <id>` trailer when the change completes the task, `Refs: <id>` when it does not. Close a finished task with `krn task close <id> --as done --note <text>` in the same pull request. Batch related fixes into one pull request.
4. **Retro, then check locally.** Run the `delivery-retro` skill before the last commit (its edits ship in the slice pull request), then the contract `fast` command once, or `test` when `fast` is absent. `related` with `{files}` replaced by the changed test files runs only the touched tests. CI runs the rest.
5. **Ship.** From the repository root: `krn pr body --task <id> --worktree <worktree> --verified '<command: verdict>' --out <file>` (`--refs` if the task stays open), then `krn pr ship --worktree <worktree> --drop --title '<title>' --body-file <file>` (`--force` after a rebase). It pushes, opens the pull request against the contract `base`, enables auto-merge on the required check, waits through the merge, removes the worktree and branch (`--drop`; a lane agent's ship keeps them for the next `krn lane start` to prune), and ends with a `verdict:` line; the title is the squash subject. Exit 74 is a red check (`gh run view <id> --log-failed`), 76 a conflict (rebase, rerun with `--force`), 77 a moved head, 75 a timeout: fix and rerun. 84 is a reproduced reviewer finding (the `krn-review:` comment; its reproduction becomes the regression test), 85 a reviewer with no verdict: rerun. Do not poll the pull request after it.
6. **Read the base branch CI.** A red test is a defect; an infrastructure flake (network, runner) is rerun with `gh run rerun <id> --failed`, never re-pushed.
7. **Close.** Release any other claim with `krn task release <id>`, retire the worktree, then step 2; when context is above 350k, run `delivery-handoff` instead so the next task starts in a fresh session. A defect with an obvious fix of a few lines is fixed now, with its regression test, in the open slice pull request or a quick one straight after. A lesson outside the slice scope that needs a decision or more work becomes `krn task create`, never a retro pull request.

## Parallel lanes

One lane per worktree, background agents for independent slices, one writer per outcome. Start each lane brief with "First read `.agents/skills/delivery-lead/lanes.md` and follow it exactly", then the task id, the evidence paths and a measurable target. Write the brief to a file under `.krn/` and send the output of `krn lane brief --task <id> --file <brief>` as the agent prompt: it prefixes the repository's standards packet. A lane runs the pinned krn-lane model; a `lane-model: opus` line in the brief is the only way to run it on Opus. Lanes ship their own pull requests; the lead reads verdicts, folds findings into the next briefs, and with lanes running stops launching new ones, drains the running ones, then hands off.

## Traps

- **Decisions.** A task must not contradict a recorded decision record; amend the record first and cite the grant that covers it.
- **Exit codes.** Never pipe a check into a filter or follow it with `|| true`: redirect it to a log, read the exit code, then read the log.
- **`pkill -f`.** Its pattern matches its own shell and other lanes' processes; stop processes by PID or port.

## Talking to the user

Unattended: park the decision as a task (`krn task create`) and start the successor. Attended: ask once, late, with a decision-ready brief (what, why, options, recommendation first); never ask about something a recorded grant covers. Report concisely with SHAs, runs and exit codes.
