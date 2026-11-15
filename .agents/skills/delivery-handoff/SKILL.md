---
name: delivery-handoff
description: End a lead session: write a one-page pointer handoff and start the next slice in a fresh session. Use when the slice merged, when it waits on the user, or when the context grows large.
compatibility: Requires the krn CLI on PATH and git; works in any repository stack, reading commands from `krn repo contract`.
---

# Delivery handoff

A fresh session with a short handoff beats a long session carrying every earlier detail: the handoff file, the tracker and the repository are the memory, not the conversation.

1. **Check the state.** Nothing in flight is left implicit: run the contract `fast` command on the merged base, list open pull requests and running lanes, and release claims you will not finish with `krn task release <id>`.
2. **Write the handoff** to `.krn/runs/<owner>/handoff.md`, one page, pointers only, secrets redacted. Start with a `## Resume` section: the task id to deliver next, the base SHA, one Verify command that prints a verdict, and the first action. Then include:
   - the priority list, with the next slice and why it comes next;
   - in-flight pull requests and runs with SHAs (merged ones are in `git log`);
   - open decisions for the user;
   - a `## Requests` section with one single-line bullet per request the user made this session; an open one carries its task id, a settled one starts with `closed: <reason>`, and `- none` when there is none. A request recorded only in a handoff or transcript is lost, so create the task first with `krn task create`;
   - grants in force, as pointers;
   - the retro's top three;
   - the skills the next session needs (`delivery-lead` plus task-specific ones).
3. **Transfer the writer, then start the next session.** Finish every write of this session (handoff, tracker, branches) first, and only then, as this session's last action, start a fresh session in the same harness from the repository root with the prompt `Use the delivery-lead skill. Run the handoff Verify; deliver <task id>.`. The new session reads the handoff and closes its predecessor once it is idle. If the next slice needs a decision from the user, attended: ask and start no session; unattended: park the decision as a task (`krn task create`) and start the successor.
4. **Report.** Tell the user what merged (SHAs, runs), which session started, and what waits on them.
