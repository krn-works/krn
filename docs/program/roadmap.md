# Improvement roadmap

The lead's ranked list of measured opportunities across delivery speed, CI, memory and review, ranked by expected saving per unit of effort. Evidence paths under `.krn/runs/` are local lead records.

Maintenance:

- Every `krn-retro` and every handoff adds, reranks or removes at least one row from evidence seen in the slice, or records why not. The handoff's `## Resume` carries `- Roadmap: <ids changed>` or `- Roadmap: unchanged (<reason>)`; `scripts/claude/handoff-requests.ts` refuses a handoff without that line or naming an id with no row here.
- External material the operator shares is triaged into a row (or explicitly rejected) in the same session.
- Ids are positional: renumber when reranking. A row leaves the table when its task closes.

| Rank | Id | Opportunity | Area | Evidence | Expected saving | Task |
|---|---|---|---|---|---|---|
| 1 | R1 | Cut the lead startup bundle below 8 kB | tokens | `.krn/runs/roadmap-refill-3/session-cost.md`: 13% of lead $, median 25.7 kB in the first 6 Bash calls | ~$0.4 per session | t-q7j3zfw |
| 2 | R2 | Cut subagent spend | tokens | `.krn/runs/roadmap-refill-2/tokens.md`: $216 of $462 since 11-07 | up to ~47% of slice dollars | t-akp44kt |
| 3 | R3 | Confirm the #472 read refusal on 20 sessions | tokens | `.krn/runs/roadmap-refill/post-472-n7.md`: 7 sessions, 47% | decides a second step | t-zz33vhy |

Sector plan (t-8hnmfr9), refilled by t-y3chym7: cost is dollars per merged PR (cache reads ~10% of input), not raw tokens. Since 2026-11-07 lead sessions cost median $1.62 and 41 turns per PR; Bash results are 94% of lead tool bytes, half of them file reads; 35% of lead cache reads come from turns over 150k (`.krn/runs/roadmap-refill-2/tokens.md`). KRN-owned startup text is ~2.3k of the ~25k first turn: closed as a track after t-bdhn7mw. The global skill listing (~17 kB per turn, mostly non-KRN skills) is the operator's call. t-qdzy8w7: handoff re-reads fell from 104 of 109 sessions to 1 of 4 (provisional). Delivery and CI time hold no row: PR open-to-merge median 1.6 min, Check median 58 s, 2 of 60 runs failed and none was rerun (`.krn/runs/roadmap-refill-3/ci-friction.md`, refilled by t-kb4mvq8).

Strategy review triage (`.krn/runs/strategy-review/report.md`): accepted as R5, R6 and t-ez3nsc3 (closed: PATH `krn` is the Product CLI); ADR 0014 D17 and the D30 review-tier amendment now say they are superseded. Deferred until R5 data: sampled post-merge Codex review, the Codex worker proof against lead-only slices (D23), and a memory A/B on replayed closed tasks (no `harness` command exists, contrary to the report) (ADR 0002 store stays unbuilt). Operator decisions open: weekly-limit pressure, plan tier, a pilot repository for the worker proof, disabling non-KRN global skills in KRN sessions.

Junk (`.krn/runs/roadmap-refill-2/junk.md`, 1829 tracked files enumerated): t-y3chym7 removed the unread CI catalogue and journey baseline; kept with a reader: `evals/fr40/results` (FR-40 verdict), `evals/woz` (ADR 0014 D20), `scripts/codex/hook-probe.ts` (t-9zd1ev0 live probe). Earlier results: FR-40 GO with packet injection (t-b9zs937); identifier index after compaction (t-7dk0vgk); idleCompaction excluded (#315).
