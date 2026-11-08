# Improvement roadmap

The lead's ranked list of measured opportunities across delivery speed, CI, memory and review, ranked by expected saving per unit of effort. Evidence paths under `.krn/runs/` are local lead records.

Maintenance:

- Every `krn-retro` and every handoff adds, reranks or removes at least one row from evidence seen in the slice, or records why not. The handoff's `## Resume` carries `- Roadmap: <ids changed>` or `- Roadmap: unchanged (<reason>)`; `scripts/claude/handoff-requests.ts` refuses a handoff without that line or naming an id with no row here.
- External material the operator shares is triaged into a row (or explicitly rejected) in the same session.
- Ids are positional: renumber when reranking. A row leaves the table when its task closes.

| Rank | Id | Opportunity | Area | Evidence | Expected saving | Task |
|---|---|---|---|---|---|---|
| 1 | R1 | Stop workers committing into their own `.krn/worktrees` branch when the brief asks for none | memory | FR-40 agent-state: 4 of 7 remaining arm-B losses (clamp, dedupe, mask, slug) committed outside the scored checkout; task-id losses fixed by t-b9zs937 | up to 4 of 19 agent-state units per run, now that every worker brief carries the packet | t-r2nm8df |
| 2 | R2 | Trim always-loaded instruction files in adopter projects (Swieta AGENTS.md 35.9 KB, wilq AGENTS.md 13 KB) | memory | `tasks/t-kfydr8a.json`: ~9k tokens in every Claude session and Codex worker; Codex first turn 36k vs 27k for krn (its cited audit files are not on disk) | ~9k tokens per session start (about 25% of a 36k first turn) | t-kfydr8a |

Sector plan (t-8hnmfr9): token cost per slice ranks first; every remaining row waits on the operator or leaves KRN-only scope (git failures fail `npm run fast` since t-zk3ekbm) (worker first call cut to 10,048 tokens by t-q5cfpv0; identifier index after compaction shipped by t-7dk0vgk at recall 0.72 against 0.61 for the summary); FR-40 returned GO (evals/fr40/results.md) and packet injection shipped (t-b9zs937), so its remaining agent-state loss (t-r2nm8df) ranks first; the PA04 precision floor waits until it is built.

Gaps: review evidence is thin (R3 shipped as frozen eval checks in the mask (t-9ser2tw); R4 shipped as the captured Codex version pin (t-7e8a0xx); the review engine was retired in #278). CI speed has no row (p50 57 s; t-wm22s14). The t-cz92be6 reports hold all 99 findings and their outcomes. Operator news triage 2026-11-08: worker retry limits fold into t-pepp256; perturbed eval variants (MaxxBench) wait with FR-40. Excluded for no saving: idleCompaction (0 of 31.06M cache-write tokens follow a gap over 1 h, #315). Open P0 task t-b6v615x has no measured saving yet.
