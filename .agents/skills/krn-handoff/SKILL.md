---
name: krn-handoff
description: End a KRN lead session — update the capsule, write a one-page pointer handoff, and start the next slice in a fresh session (a Herdr tab, else a background session). Use when the slice merged, when it waits on the operator, or when the lead context grows large.
---

# KRN handoff

A fresh session with a short handoff beats a long session carrying every earlier detail; the handoff file, the capsule and the tracker are the memory, not the conversation.

1. **Capsule.** Never hand-edit `.krn/runs/delivery-loop/<outcome>/state.md`: write fields with `krn state set <field> <value> [<field> <value>...]` (field = unambiguous label word, e.g. `next`, `evidence`; `--capsule <id>` when several capsules) and acceptance entries with `krn state accept <criterion> todo|pass|drop:<why>` (commas and semicolons are stripped). Then run `krn state check --root .` until it reports clean.
2. **Handoff.** Generate `handoff.md` beside the capsule with `krn state handoff [--task <id>] [--sha <text>] [--verify <cmd>] [--roadmap <text>] [--request <text>]... [--priority <text>]...`. It writes `## Resume` (task, SHAs, Verify, Roadmap; defaults: task from the next action, HEAD, the state check, roadmap unchanged) and `## Merged` (first-parent commits since the previous Resume SHA); `--request` and `--priority` replace those sections. SessionStart injects Resume and the operator requests verbatim. Edit other sections directly: one page, pointers only, secrets redacted. Pass `--roadmap '<task ids>'` when a task changed. Include:
   - the priority list, with the next slice and why it comes next;
   - in-flight PRs and runs with SHAs (merged ones are generated);
   - open operator decisions;
   - `## Operator requests`: one unindented single-line bullet per operator request this session received or carried. An open request carries its task id or `memory:<slug>` (an auto-memory file); a request settled in this session starts with `closed: <reason>`; a lone `- none` when there is no request at all. The handoff holds exactly one such section, which ends at the next level-one or level-two heading. The section holds nothing else: no indented lines, code, nested lists or subheadings, and the phrase "operator requests" appears nowhere else in the handoff. A request recorded only in a handoff or transcript is lost to the next session, so create the task or memory entry first. The check also fails on every open task whose body quotes or reports the operator (verbatim, "Operator ... asked/said") and that the section does not name: carry it or close the task;
   - grants in force (pointers);
   - the retro's top three;
   - suggested skills for the next session (`krn-lead` plus task-specific ones).

   A UserPromptSubmit hook records every operator prompt in `.krn/operator/inbox.jsonl`; the same check fails while a directive-like prompt since the last handoff has no disposition. List them with `node scripts/claude/operator-inbox.ts open`, clear each with `dispose <hash> --task <id> | --memory <slug> | --answered <reason>`. Before telling the operator something was "not recorded", run `operator-inbox.ts search <words>`.

   Run `node scripts/claude/handoff-requests.ts <handoff path>` from the repository root until it prints PASS.
3. **Transfer the writer, then start the next session.** Record in the capsule field "Current workflow owner and sole writer" that the next session is the writer, finish every write of this session (capsule, handoff, tracker), and only then, as this session's last action, start the next one from the repository root:
   `node scripts/claude/successor-launch.ts --name "<slice purpose>" --model claude-opus-5-5 --effort medium --prompt "Use the krn-lead skill. Run the handoff Verify; deliver <task id>."`
   The launcher detects the harness the lead is running in from the runtime environment (`CODEX_THREAD_ID`, `CLAUDECODE`) and starts the successor in it; Codex needs Herdr and never falls back to Claude. An unknown or ambiguous environment exits 2; set `KRN_SUCCESSOR_AGENT` only to override deliberately. Tab retirement applies to Claude leads only.
   Exit 0 means Herdr showed the successor's agent in the new pane within 60 s; only then is this tab renamed "handed off → <name>", and this session writes nothing more. A non-zero exit naming a pane means no successor started and the tab keeps its name: read that pane, fix the cause, launch again. The successor first runs `node scripts/claude/successor-launch.ts --retire`; that closes this tab once idle or done, plus other idle "handed off → …" tabs of this Herdr workspace only. If the next slice needs an operator decision, do not start a session; ask the operator with a decision-ready brief.
4. **Report.** Tell the operator in Polish:
   - what merged (SHAs, runs);
   - which session started (its name, plus the launcher's startup-dialog line verbatim if it printed one; never relaunch);
   - what waits on them.
