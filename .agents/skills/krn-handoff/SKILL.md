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
3. **Choose the live route.** Select the active harness from runtime context, never from executable presence. Start only an operator-authorized task; if it needs an operator decision, pause and ask with a decision-ready brief. Every launch prompt must keep the successor read-only, including capsule and thread-ID edits, until it observes an explicit ownership-transfer ACK for its exact returned identity in the capsule.
   - **Claude Code:** preserve the existing `claude --bg -n "<slice purpose>" "Use the krn-lead skill. Read <handoff path>; remain read-only until the capsule ACK names your exact session, then deliver <task id>."` route.
   - **Native Codex:** when the connected app server exposes `mcp__codex_tui__create_thread`, create a fresh thread with a descriptive title and a prompt containing handoff/task pointers and the read-only-until-ACK constraint, omit the model, and verify the repository cwd is inherited and the result has a fresh `threadId`. Never fork old history.
   - **Unavailable or unknown:** report an unsupported harness or route; do not silently launch Claude or invent a background flag.
4. **Transfer the writer.** Keep the current session as the canonical sole writer in the capsule while launch is pending. Record only a pending transfer and finish handoff/tracker preparation before launch; the successor still has no write authority.
   - **Confirmed launch:** verify the exact successor identity and cwd, then finish every other durable write. As the final durable write, atomically update the capsule owner to that exact identity and record the explicit ownership-transfer ACK for it. The current session stops writing at that update, before any supported harness notification. The successor checks both the canonical owner and the ACK against its own identity before its first write.
   - **Definite launch failure:** retain the current owner in the durable capsule and explicitly clear the pending transfer. No successor ownership or ACK is published.
   - **Unknown launch outcome:** retain the current owner and the pending transfer; use only read-only checks to reconcile the native thread state before retrying. Do not retry, transfer ownership or let the successor write until the outcome is known. If ACK delivery or observation is unknown after the atomic transfer, the old session remains stopped and reconciles read-only; it must not reclaim writing or launch another successor.
5. **Resume.** Report a verified same-server command using the observed endpoint and returned `threadId`: `codex --remote <observed endpoint> resume <returned threadId>`, or the supported `codex agents --remote <observed endpoint>` selector. Take `thread.id` from the native result; never infer it from `sessionId`. Never hardcode this host's endpoint globally, expose tokens, claim automatic UI switching, or describe `codex exec --json` as attachment to a live daemon.
6. **Report.** Documentation is not runtime proof; the runtime owner still must demonstrate a real advisory, fresh thread and cwd, active-session attachment, and completed follow-up recovering the goal, owner, constraints, authority and next step. Tell the operator in Polish:
   - what merged (SHAs, runs);
   - which session started (its name);
   - what waits on them.
