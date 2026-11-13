---
name: delivery-lead
description: Lead delivery in this repository: pick one slice, code it in its own worktree, ship it through auto-merge on the required check, and brief parallel lanes. Use when resuming the delivery loop or starting a slice; skip for a single read-only question.
compatibility: Requires the krn CLI on PATH and git; works in any repository stack, reading commands from `krn repo contract`.
---

# Delivery lead

Merge one slice at a time with the base branch green, and leave the next slice cheaper. Every command, path and gate below comes from the repository contract, never from memory: run `krn repo contract` first and read `base`, `test`, `related`, `fast`, `guard` and `tracker` from its JSON. `krn.json` holds the operator's edits; a field there wins over detection.

## Protect your context

- Delegate reading: logs, diffs and test output go to a subagent that returns a short verdict and a path.
- Pass pointers (paths, SHAs, task ids), not file contents.
- Verify with commands that print a verdict (exit code, counts), never by reading output.

## The loop

1. **Resume.** `git fetch --prune`, list open pull requests, read the tracker when the contract says `tracker` is `krn` (`krn task list`, `krn task show <id>`).
2. **Pick one slice** that fits one pull request. Say what you defer. `krn lane start <slug> --task <id> --actor lead` fetches the contract base, creates the worktree, claims the task.
3. **Code in that worktree.** Commit as `type(scope): outcome (<task-id>)` with a `Ticket: <id>` trailer when the change completes the task, `Refs: <id>` when it does not. Close a finished task with `krn task close <id> --as done --note <text>` in the same pull request.
4. **Check locally.** Run the contract `fast` command, or `test` when `fast` is absent. `related` with `{files}` replaced by the changed test files runs only the touched tests.
5. **Ship.** From the repository root: `krn pr body --task <id> --verified '<command: verdict>' --out <file>`, then `krn pr ship --worktree <worktree> --title '<title>' --body-file <file>`. It pushes, opens the pull request against the contract `base`, enables auto-merge, waits through the merge, removes the worktree and ends with a `verdict:` line. Exit 74 is a red check (`krn ci logs --repo <owner/repo> --run <id>`), 76 a conflict (rebase, rerun with `--force`), 75 a timeout.
6. **Read the base branch CI.** A red test is a defect; an infrastructure flake is rerun, never re-pushed.

## Parallel lanes

One lane per worktree, one writer per outcome. Write the lane brief to a file and send `krn lane brief --task <id> --file <brief>` as the agent prompt. The brief names the task id, the evidence paths and a measurable target; the lane ships its own pull request and reports a verdict.

## Talking to the operator

Ask once, late, with a decision-ready brief: what, why, options with the recommendation first. Never ask about something a recorded grant covers.
