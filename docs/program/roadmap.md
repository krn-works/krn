# Improvement roadmap

The lead's ranked list of measured opportunities across delivery speed, CI, memory and review, ranked by expected saving per unit of effort. Evidence paths under `.krn/runs/` are local lead records.

Maintenance:

- Every `krn-retro` and every handoff adds, reranks or removes at least one row from evidence seen in the slice, or records why not. The handoff's `## Resume` carries `- Roadmap: <ids changed>` or `- Roadmap: unchanged (<reason>)`; `scripts/claude/handoff-requests.ts` refuses a handoff without that line or naming an id with no row here.
- External material the operator shares is triaged into a row (or explicitly rejected) in the same session.
- Ids are positional: renumber when reranking. A row leaves the table when its task closes.

| Rank | Id | Opportunity | Area | Evidence | Expected saving | Task |
|---|---|---|---|---|---|---|
| 1 | R1 | Cut the cause of relay sessions that merge nothing | Token cost | `.krn/runs/roadmap-refill/token-per-slice.md` §7: 37 relay sessions over 20 turns merged nothing, 329M cache_read (21% of lead total) | up to ~20% of lead cache_read | t-f6q8gcp |
| 2 | R2 | Stop lead file reads through Bash cat, sed and grep | Token cost | `.krn/runs/roadmap-refill/token-per-slice.md` §6: 7.1 MB, 54% of 13.2 MB lead Bash results, re-read every later turn | about half of lead tool-result context | t-q5rxt23 |
| 3 | R3 | Delete scripts with no caller and a dangling link | Junk | `.krn/runs/roadmap-refill/junk-inventory.md`: 2 scripts and a 1,859-line fixture read only by their own tests | smaller test and lint surface | t-amfcywj |

Sector plan (t-8hnmfr9): token cost per slice ranks first; t-389d2je measured 216 lead sessions since 2026-11-01 (median 4.64M input tokens per merged PR including cache reads, 98% of them cache reads) and ranked its token rows from it; t-9k7eha3 capped the gauge advisories at 150k and 200k of the 400k window (rerun `.krn/runs/roadmap-refill/token-scan.py` on later sessions to confirm turns over 150k fall). Delivery time and CI wall time hold no row: over the last 60 PRs open-to-merge took median 1.1 min (p90 2.0) and the last 30 main runs median 0.9 min, all green (`.krn/runs/roadmap-refill/delivery.txt`). Earlier results: worker first call cut to 10,048 tokens by t-q5cfpv0; identifier index after compaction shipped by t-7dk0vgk at recall 0.72 against 0.61 for the summary; FR-40 returned GO (evals/fr40/results.md), packet injection shipped (t-b9zs937) and workers stay in the scored checkout (t-r2nm8df); the PA04 precision floor waits until it is built.

Gaps: review evidence is thin (R3 shipped as frozen eval checks in the mask (t-9ser2tw); R4 shipped as the captured Codex version pin (t-7e8a0xx); the review engine was retired in #278). CI speed: t-ed32603 ran independent worker fixture setups concurrently (acceptance-checks 14.2 -> 6.1 s, dependency-guard 12.0 -> 5.0 s, acceptance-checks-observers 9.5 -> 5.9 s locally) and test/rules/test-hygiene.test.mjs refuses new sequential setups; t-wm22s14 measures the window; the sh systemctl stub (t-3p3xp7z) cut hardening-git by 1.3 s locally, and the remaining worker cost is the two node starts of the app-server fixture per test, which the tests exercise. The t-cz92be6 reports hold all 99 findings and their outcomes. Operator news triage 2026-11-08: worker retry limits fold into t-pepp256; perturbed eval variants (MaxxBench) wait with FR-40. Excluded for no saving: idleCompaction (0 of 31.06M cache-write tokens follow a gap over 1 h, #315). Codex context hooks were accepted live (t-b6v615x); restart dedupe, the fork source and the owner capsule bound shipped with a live probe (`scripts/codex/hook-probe.ts`, t-9zd1ev0).
