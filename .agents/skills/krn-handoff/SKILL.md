---
name: krn-handoff
description: End a KRN lead session — update the capsule, write a one-page pointer handoff, and start the next slice in a fresh background session. Use when the slice merged, when it waits on the operator, or when the lead context grows large.
---

# KRN handoff

A fresh session with a short, precise handoff outperforms a long session that carries every earlier detail; the handoff file, the capsule and the tracker are the memory, not the conversation.

1. **Capsule.** Update `.krn/runs/delivery-loop/<outcome>/state.md` and run `krn state check --root .` until it reports clean.
2. **Handoff.** Write `handoff.md` beside the capsule: at most one page, pointers only, never content already held by an ADR, task, commit, PR or record. Redact secrets. Include:
   - the priority list, with the next slice and why it comes next;
   - in-flight PRs and runs with SHAs;
   - open operator decisions;
   - `## Operator requests`: one bullet per open operator request that outlives this session, each carrying its task id, `memory:<slug>` (an auto-memory file) or a `closed: <reason>` prefix; `- none` when nothing is open. A request recorded only in a handoff or transcript is lost to the next session, so create the task or memory entry first;
   - grants in force (pointers);
   - the retro's top three;
   - suggested skills for the next session (`krn-lead` plus task-specific ones).

   Run `node scripts/claude/handoff-requests.ts <handoff path>` from the repository root until it prints PASS.
3. **Transfer the writer, then start the next session.** Record in the capsule field "Current workflow owner and sole writer" that the next session is the writer, finish every write of this session (capsule, handoff, tracker), and only then, as this session's last action, start the next one from the repository root:
   `claude --bg -n "<slice purpose>" "Use the krn-lead skill. Read <handoff path>, then deliver <task id>."`
   After this command the current session writes nothing. If the next slice needs an operator decision, do not start a session; ask the operator with a decision-ready brief.
4. **Report.** Tell the operator in Polish:
   - what merged (SHAs, runs);
   - which session started (its name);
   - what waits on them.
