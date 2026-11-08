# Improvement roadmap

The lead's ranked list of measured opportunities across delivery speed, CI, memory and review, ranked by expected saving per unit of effort. Evidence paths under `.krn/runs/` are local lead records.

Maintenance:

- Every `krn-retro` and every handoff adds, reranks or removes at least one row from evidence seen in the slice, or records why not. The handoff's `## Resume` carries `- Roadmap: <ids changed>` or `- Roadmap: unchanged (<reason>)`; `scripts/claude/handoff-requests.ts` refuses a handoff without that line or naming an id with no row here.
- External material the operator shares is triaged into a row (or explicitly rejected) in the same session.
- Ids are positional: renumber when reranking. A row leaves the table when its task closes.

| Rank | Id | Opportunity | Area | Evidence | Expected saving | Task |
|---|---|---|---|---|---|---|
| 1 | R1 | Re-inject an identifier index after Claude compaction | memory | PA05: summaries keep 16.0% of recurring details, an index 79.1%; needs no FR-40 power | fewer re-reads after compaction; target recall >= 0.70 on >= 15 boundaries | t-7dk0vgk |
| 2 | R2 | Refuse piped test and lint runs in the lead's Bash with a hook | delivery speed | krn-lead Traps: a piped `npm test` reported fail 0 while CI had 20 failures; no Bash hook exists | one recurring false-green class removed; target 4 piped payloads exit 2 | t-rkkbv9d |
| 3 | R3 | Make `npm run fast` fail when git fails | delivery speed | `scripts/fast-check.ts:72-75`: outside a repository or with a corrupt index it prints PASS, exit 0 | one false-green class in the local check removed | t-zk3ekbm |
| 4 | R4 | Trim always-loaded instruction files in adopter projects (Swieta AGENTS.md 35.9 KB, wilq AGENTS.md 13 KB) | memory | `tasks/t-kfydr8a.json`: ~9k tokens in every Claude session and Codex worker; Codex first turn 36k vs 27k for krn (its cited audit files are not on disk) | ~9k tokens per session start (about 25% of a 36k first turn) | t-kfydr8a |
| 5 | R5 | Route `krn task` to a pinned checkout so the tracker never runs an older commit without the claim lock | delivery speed | `tasks/t-z1rn4s0.json`: product-entry points at the lead's working checkout; on an older commit the frontier fails and claims run without the lock | 1 class of silent double-claim removed; small, one-time config change | t-z1rn4s0 |
| 6 | R6 | Run frozen eval checks in the workspace mask so a candidate cannot rewrite scripts to pass | review | waits on the operator: `evals/fr40/validity.json` says do not build FR-40 and offers the convention-task alternative; last open blocker of t-y46gy0w since #366; `tasks/t-9ser2tw.json`: acceptance names a candidate that rewrites a script to `true` and zero executed tests must FAIL | protects every A/B acceptance number (27/27 accepted in `.krn/runs/lead/krn-ab/report-v5.md`) from false passes; 0 known false passes today | t-9ser2tw |
| 7 | R7 | Pin eval sessions to a captured Codex receiver version so FR-40 cannot run on uncaptured stream semantics | review | waits on the same FR-40 decision; #366: the first 0.167.0 captures found three classifier defects written against an uncaptured version; the receiver moved from rust-v0.162.1 to 0.167.0 within weeks | protects FR-40 validity on every Codex bump | `tasks/t-7e8a0xx.json` |

Sector plan (t-8hnmfr9): token cost per slice ranks first, so R1 to R2 are the next slices (worker first call cut to 10,048 tokens by t-q5cfpv0); FR-40 and the PA04 precision floor wait until packet injection is built.

Gaps: review evidence is thin (the two eval rows only; the review engine was retired in #278). CI speed has no row (p50 57 s; t-wm22s14). The t-cz92be6 reports hold all 99 findings and their outcomes. Excluded for no saving: idleCompaction (0 of 31.06M cache-write tokens follow a gap over 1 h, #315). Open P0 task t-b6v615x has no measured saving yet.
