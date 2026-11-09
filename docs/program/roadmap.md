# Improvement roadmap

The lead's ranked list of measured opportunities across delivery speed, CI, memory and review, ranked by expected saving per unit of effort. Evidence paths under `.krn/runs/` are local lead records.

Maintenance:

- Every `krn-retro` and every handoff adds, reranks or removes at least one row from evidence seen in the slice, or records why not. The handoff's `## Resume` carries `- Roadmap: <ids changed>` or `- Roadmap: unchanged (<reason>)`; `scripts/claude/handoff-requests.ts` refuses a handoff without that line or naming an id with no row here.
- External material the operator shares is triaged into a row (or explicitly rejected) in the same session.
- Ids are positional: renumber when reranking. A row leaves the table when its task closes.

| Rank | Id | Opportunity | Area | Evidence | Expected saving | Task |
|---|---|---|---|---|---|---|
| 1 | R1 | Trim always-loaded instruction files in adopter projects (Swieta done 8.2 KB at b93106a; wilq 7.2 KB waits on owner review in krn-works/wilq-seo#265) | memory | `tasks/t-kfydr8a.json`: Codex first turn Swieta 24708 -> 22199, wilq 26797 -> 25552 tokens | ~9k tokens per session start (about 25% of a 36k first turn) | t-kfydr8a |

Sector plan (t-8hnmfr9): token cost per slice ranks first; every remaining row waits on the operator or leaves KRN-only scope (git failures fail `npm run fast` since t-zk3ekbm) (worker first call cut to 10,048 tokens by t-q5cfpv0; identifier index after compaction shipped by t-7dk0vgk at recall 0.72 against 0.61 for the summary); FR-40 returned GO (evals/fr40/results.md), packet injection shipped (t-b9zs937) and workers stay in the scored checkout (t-r2nm8df); the PA04 precision floor waits until it is built.

Gaps: review evidence is thin (R3 shipped as frozen eval checks in the mask (t-9ser2tw); R4 shipped as the captured Codex version pin (t-7e8a0xx); the review engine was retired in #278). CI speed: t-ed32603 ran independent worker fixture setups concurrently (acceptance-checks 14.2 -> 6.1 s, dependency-guard 12.0 -> 5.0 s, acceptance-checks-observers 9.5 -> 5.9 s locally) and test/rules/test-hygiene.test.mjs refuses new sequential setups; t-wm22s14 measures the window; the sh systemctl stub (t-3p3xp7z) cut hardening-git by 1.3 s locally, and the remaining worker cost is the two node starts of the app-server fixture per test, which the tests exercise. The t-cz92be6 reports hold all 99 findings and their outcomes. Operator news triage 2026-11-08: worker retry limits fold into t-pepp256; perturbed eval variants (MaxxBench) wait with FR-40. Excluded for no saving: idleCompaction (0 of 31.06M cache-write tokens follow a gap over 1 h, #315). Open P0 task t-b6v615x has no measured saving yet.
