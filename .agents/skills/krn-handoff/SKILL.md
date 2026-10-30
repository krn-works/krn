---
name: krn-handoff
description: End a KRN lead session — update the capsule, write a one-page pointer handoff, and transfer work to a fresh session in the active harness. Use when the slice merged, when it waits on the operator, or when the lead context grows large.
---

# KRN handoff

A fresh session with a short, precise handoff outperforms a long session that carries every earlier detail; the handoff file, the capsule and the tracker are the memory, not the conversation.

1. **Capsule.** Update `.krn/runs/delivery-loop/<outcome>/state.md` and run `krn state check --root .` until it reports clean.
2. **Handoff.** Write `handoff.md` beside the capsule: at most one page, pointers only, never content already held by an ADR, task, commit, PR or record. Redact secrets. Include:
   - the priority list, with the next slice and why it comes next;
   - in-flight PRs and runs with SHAs;
   - open operator decisions;
   - grants in force (pointers);
   - the retro's top three;
   - suggested skills for the next session (`krn-lead` plus task-specific ones).
3. **Choose the live route.** Select the active harness from runtime context, never from executable presence. Start only an operator-authorized task; if it needs an operator decision, pause and ask with a decision-ready brief.
   - **Claude Code:** preserve the existing `claude --bg -n "<slice purpose>" "Use the krn-lead skill. Read <handoff path>, then deliver <task id>."` route.
   - **Native Codex:** when the connected app server exposes `mcp__codex_tui__create_thread`, create a fresh thread with a descriptive title and a prompt containing only handoff/task pointers, omit the model, and verify the repository cwd is inherited and the result has a fresh `threadId`. Never fork old history.
   - **Unavailable or unknown:** report an unsupported harness or route; do not silently launch Claude or invent a background flag.
4. **Transfer the writer.** Record in the capsule field "Current workflow owner and sole writer" that the successor is the writer, finish every durable write (capsule, handoff, tracker), and only then launch. After confirmed success the current session stops writing. If launch fails or its outcome is unknown, retain the current owner and reconcile the native thread state before retrying.
5. **Resume.** Report a verified same-server command using the observed endpoint and returned `threadId`: `codex --remote <observed endpoint> resume <returned threadId>`, or the supported `codex agents --remote <observed endpoint>` selector. Take `thread.id` from the native result; never infer it from `sessionId`. Never hardcode this host's endpoint globally, expose tokens, claim automatic UI switching, or describe `codex exec --json` as attachment to a live daemon.
6. **Report.** Documentation is not runtime proof; the runtime owner still must demonstrate a real advisory, fresh thread and cwd, active-session attachment, and completed follow-up recovering the goal, owner, constraints, authority and next step. Tell the operator in Polish:
   - what merged (SHAs, runs);
   - which session started (its name);
   - what waits on them.
