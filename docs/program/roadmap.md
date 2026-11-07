# Improvement roadmap

The lead's ranked list of measured opportunities across delivery speed, CI, memory and review, ranked by expected saving per unit of effort. Evidence paths under `.krn/runs/` are local lead records.

Maintenance:

- Every `krn-retro` and every handoff adds, reranks or removes at least one row from evidence seen in the slice, or records why not. The handoff's `## Resume` carries `- Roadmap: <ids changed>` or `- Roadmap: unchanged (<reason>)`; `scripts/claude/handoff-requests.ts` refuses a handoff without that line or naming an id with no row here.
- External material the operator shares is triaged into a row (or explicitly rejected) in the same session.
- Ids are positional: renumber when reranking. A row leaves the table when its task closes.

| Rank | Id | Opportunity | Area | Evidence | Expected saving | Task |
|---|---|---|---|---|---|---|
| 1 | R1 | Delete or consolidate the heaviest redundant worker tests (hardening/input-bounds overlap, ~10000-file bound tested in 4 places) and the isolation skip-gate tests | CI | `.krn/runs/lead/weakness-hunt/ci-baseline.md`: worker/hardening 137 s and worker/input-bounds 129 s of 1464 s total; `.krn/runs/lead/weakness-hunt/tests-audit.md` follow-ups: ~3.5k isolation test lines | 20-40 s off the slowest shard (~61 s now), 1464 s total CPU per run; not measured after #287, so unverified | t-9jy8dnh |
| 2 | R2 | Finish the CI wall-time split work: re-measure at 10 runs and rebalance shards (median slowest/fastest was 134 s vs 76 s before the weighted plan) | CI | `.krn/runs/lead/weakness-hunt/ci-baseline.md`: baseline median 162 s, 115 s after #262 (n=1); `.krn/runs/lead/weakness-hunt/ledger.md`: 79 s after #287 (Changes 4 s vs 10, slowest test job 61 s vs 70) | 79 s to about 65 s is plausible; mostly confirms the 162 s to 79 s gain (-83 s per PR) holds | t-q625vvc |
| 3 | R3 | Trim always-loaded instruction files in adopter projects (Swieta AGENTS.md 35.9 KB, wilq AGENTS.md 13 KB) | memory | `tasks/t-kfydr8a.json`: ~9k tokens in every Claude session and Codex worker; Codex first turn 36k vs 27k for krn (its cited audit files are not on disk) | ~9k tokens per session start (about 25% of a 36k first turn) | t-kfydr8a |
| 4 | R4 | Make claims live and enforce closure on merge so `claim --next` cannot hand out finished work | delivery speed | `tasks/t-se2s2tt.json`: PRs #133 and #134 merged leaving their tasks open; t-8zvy7c5 re-listed as ready during #135 | 2 observed duplicate-work incidents in one week avoided; each costs a lead pick plus worker slice | t-se2s2tt |
| 5 | R5 | Route `krn task` to a pinned checkout so the tracker never runs an older commit without the claim lock | delivery speed | `tasks/t-z1rn4s0.json`: product-entry points at the lead's working checkout; on an older commit the frontier fails and claims run without the lock | 1 class of silent double-claim removed; small, one-time config change | t-z1rn4s0 |
| 6 | R6 | Run frozen eval checks in the workspace mask so a candidate cannot rewrite scripts to pass | review | `tasks/t-9ser2tw.json`: acceptance names a candidate that rewrites a script to `true` and zero executed tests must FAIL | protects every A/B acceptance number (27/27 accepted in `.krn/runs/lead/krn-ab/report-v5.md`) from false passes; 0 known false passes today | t-9ser2tw |

Gaps: review evidence is thin (R9 only; the review engine was retired in #278). Excluded for no saving: idleCompaction (0 of 31.06M cache-write tokens follow a gap over 1 h, #315). Open P0 task t-b6v615x has no measured saving yet.
