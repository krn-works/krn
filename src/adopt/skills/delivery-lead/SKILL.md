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
5. **Ship.** From the repository root: `krn pr body --task <id> --worktree <worktree> --verified '<command: verdict>' --out <file>` (`--refs` if the task stays open), then `krn pr ship --worktree <worktree> --drop --title '<title>' --body-file <file>` (`--force` after a rebase). It pushes, opens the pull request against the contract `base`, enables auto-merge on the required check, waits through the merge, removes the worktree and branch (`--drop`; a lane agent's ship keeps them for the next `krn lane start` to prune), and ends with a `verdict:` line; the title is the squash subject. Exit 74 is a red check (`gh run view <id> --log-failed`), 76 a conflict (rebase, rerun with `--force`), 77 a moved head, 75 a timeout: fix and rerun. A `krn-review:` PR comment is advisory: a reproduced finding is a defect for a follow-up fix with its reproduction as the regression test, never a reason to hold the merge. Do not poll the pull request after it.
6. **Read the base branch CI.** A red test is a defect; an infrastructure flake (network, runner) is rerun with `gh run rerun <id> --failed`, never re-pushed.
7. **Close.** Release any other claim with `krn task release <id>`, retire the worktree, then step 2; when context is above 350k, run `delivery-handoff` instead so the next task starts in a fresh session. A defect with an obvious fix of a few lines is fixed now, with its regression test, in the open slice pull request or a quick one straight after. A lesson outside the slice scope that needs a decision or more work becomes `krn task create`, never a retro pull request.

## Parallel lanes

A lane is a subagent of the lead session that owns one outcome: its own claimed task, worktree and pull request; it never writes another lane's outcome, branch or pull request. One lane per worktree, background agents for independent slices, one writer per outcome. Start each lane brief with "First read `.agents/skills/delivery-lead/lanes.md` and follow it exactly", then the task id, the evidence paths and a measurable target. Write the brief to a file under `.krn/` and send the output of `krn lane brief --task <id> --file <brief>` as the agent prompt: it prefixes the repository's standards packet. A lane runs the pinned krn-lane model; a `lane-model: opus` line in the brief is the only way to run it on Opus. Lanes ship their own pull requests; the lead reads verdicts, folds findings into the next briefs, and with lanes running stops launching new ones, drains the running ones, then hands off. Before claiming, list open claims and open pull requests and pick a task whose paths do not overlap another lane's open pull request; overlapping work waits for that merge, then rebases only on a conflict and pushes with `--force-with-lease`. A merge stopped by an `index.lock` held by another lane is transient: retry.

## Traps

- **Decisions.** A task must not contradict a recorded decision record; amend the record first and cite the grant that covers it.
- **Exit codes.** Never pipe a check into a filter or follow it with `|| true`: redirect it to a log, read the exit code, then read the log.
- **`pkill -f`.** Its pattern matches its own shell and other lanes' processes; stop processes by PID or port.
- **Sources.** Conflicts resolve in this order: the current user instruction; current code and passing tests; an accepted decision record or repository rule; `AGENTS.md`; this skill; plans and run evidence. An instruction contradicted by code and passing tests is stale. A proposal changes no accepted decision; record an unresolved one as `krn task create`; a plan orders slices and creates no task, acceptance or authority.
- **Evidence.** Start with the cheapest signal that could disprove a claim and compare a failure with the base before blaming the change. Rerun a lane's cited command before accepting it; a successful command alone is not acceptance.
- **Remote state.** A client push or API error is not remote state: read the exact remote ref (`git ls-remote origin <ref>`, the pull request `headRefOid`) before any retry, rebase or rewrite.
- **Red only in CI.** Reproduce it in the runner shape before a fix round: the tree bind-mounted at `/home/runner/work/<repo>/<repo>` in a user namespace (`unshare -rm`) with `CI=true`.
- **Validator briefs.** A brief for a validator or schema states the full key set from the producer's code, each field's type, format and bounds and the success semantics at once, with fixtures captured verbatim from the real producer; refusal-only observers are not red at base, so the proof also asserts an accepted record.
- **Cost claims.** Cite a `krn ledger` window (`--window <from> <to>` or `--last <n>`, from the main checkout; a linked worktree exits 64) with its pull request count; dollars per pull request from one slice or one day is not evidence.
- **Shell.** The Bash tool runs each command inside `eval ... ||`, so `set -e` does not stop it: chain state-changing steps with `&&` or an explicit `|| exit`. Run cleanup with absolute paths from the main checkout, never from inside a worktree it removes.
- **Classifier denial.** When the auto-mode classifier denies a granted step, never work around it: put the exact `! <command>` line in the handoff and continue with work that needs no such step.
- **Long runs.** Above about 100k context, run anything longer than about 30 minutes as a detached process writing under `.krn/runs/`, not as a session subagent, so a handoff neither waits on it nor kills it.
- **Skill overrides.** A user-level `skillOverrides` entry disables a project skill of the same name; when a skill does not load, check `~/.claude/settings.json` first.
- **Grants.** Send no message to an external service, and take no host, production, install, hook-trust or other irreversible action, without its own grant.
- **Lessons.** Put a lesson where the executor reads it: a mechanical check first, `AGENTS.md` second; memory holds only user preferences and decisions. Turn a regression into expected behavior, not a lint that pins technique. Fix a flaky test; a single recorded retry is allowed only for untouched files while a fix is pending. Use private temp directories, condition waits with deadlines and no wall-clock assertions. A backup is made, verified and deleted in the same step. Delete outdated docs: Git history is the archive.
- **Terminal pull request.** Retire each owned branch and worktree at merge (`krn pr ship --drop` does it), or keep one with a named owner, consumer and removal trigger; never delete another owner's ref or worktree. A risky change gets an independent review from `krn pr ship`: a tier 2 diff is read by the `review` command of `krn.json` in fresh context beside the `Check`, and a finding it reproduces blocks the merge.

## Role

A session is the lead only when the user or its brief names that role or invokes `delivery-lead`. Any other session works and commits in the checkout it started in: no worktree, branch or task, no claim, and it skips the lead skills.

## Open traps

none

## Talking to the user

Unattended: park the decision as a task (`krn task create`) and start the successor. Attended: ask once, late, with a decision-ready brief (what, why, options, recommendation first); never ask about something a recorded grant covers. Report concisely with SHAs, runs and exit codes.
