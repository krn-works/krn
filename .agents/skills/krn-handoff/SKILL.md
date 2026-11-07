---
name: krn-handoff
description: End a KRN lead session — update the capsule, write a one-page pointer handoff, and start the next slice in a fresh session (a Herdr tab, else a background session). Use when the slice merged, when it waits on the operator, or when the lead context grows large.
---

# KRN handoff

A fresh session with a short, precise handoff outperforms a long session that carries every earlier detail; the handoff file, the capsule and the tracker are the memory, not the conversation.

1. **Capsule.** Update `.krn/runs/delivery-loop/<outcome>/state.md` and run `krn state check --root .` until it reports clean.
2. **Handoff.** Write `handoff.md` beside the capsule: at most one page, pointers only, never content already held by an ADR, task, commit, PR or record. Redact secrets. Include:
   - the priority list, with the next slice and why it comes next;
   - in-flight PRs and runs with SHAs;
   - open operator decisions;
   - `## Operator requests`: one unindented single-line bullet per operator request this session received or carried. An open request carries its task id or `memory:<slug>` (an auto-memory file); a request settled in this session starts with `closed: <reason>`; a lone `- none` when there is no request at all. The handoff holds exactly one such section, which ends at the next level-one or level-two heading. The section holds nothing else: no indented lines, code, nested lists or subheadings, and the phrase "operator requests" appears nowhere else in the handoff. A request recorded only in a handoff or transcript is lost to the next session, so create the task or memory entry first. The check also fails on every open task whose body quotes or reports the operator (verbatim, "Operator ... asked/said") and that the section does not name: carry it or close the task;
   - grants in force (pointers);
   - the retro's top three;
   - suggested skills for the next session (`krn-lead` plus task-specific ones).

   A UserPromptSubmit hook records every operator prompt in `.krn/operator/inbox.jsonl`; the same check fails while a directive-like prompt since the last handoff has no disposition. List them with `node scripts/claude/operator-inbox.ts open`, clear each with `dispose <hash> --task <id> | --memory <slug> | --answered <reason>`. Before telling the operator something was "not recorded", run `operator-inbox.ts search <words>`.

   Run `node scripts/claude/handoff-requests.ts <handoff path>` from the repository root until it prints PASS.
3. **Transfer the writer, then start the next session.** Record in the capsule field "Current workflow owner and sole writer" that the next session is the writer, finish every write of this session (capsule, handoff, tracker), and only then, as this session's last action, start the next one from the repository root:
   `node scripts/claude/successor-launch.ts --name "<slice purpose>" --prompt "Use the krn-lead skill. Read <handoff path>, then deliver <task id>."`
   The launcher detects the harness the lead is running in from the runtime environment (Codex: `CODEX_THREAD_ID`; Claude Code: `CLAUDECODE`) and starts the successor in that same harness: Claude with `--permission-mode bypassPermissions -n`, Codex with the prompt only (the tab label carries the name; Codex has no background mode, so it requires Herdr and never falls back to Claude). An unknown or ambiguous environment stops with exit 2 and a message; set `KRN_SUCCESSOR_AGENT` only to override deliberately. Retirement of the predecessor tab applies to Claude leads only.
   After this command the current session writes nothing. The launcher renames this tab "handed off → <name>" and tells the successor to run `node scripts/claude/successor-launch.ts --retire` first; that closes this tab once its agent is idle or done, plus every other idle "handed off → …" tab of the same Herdr workspace, never other workspaces or working agents. If the next slice needs an operator decision, do not start a session; ask the operator with a decision-ready brief.
4. **Report.** Tell the operator in Polish:
   - what merged (SHAs, runs);
   - which session started (its name);
   - what waits on them.
