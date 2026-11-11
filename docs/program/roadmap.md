# Improvement roadmap

The lead's ranked list of measured opportunities across delivery speed, CI, memory and review, ranked by expected saving per unit of effort. Evidence paths under `.krn/runs/` are local lead records.

Maintenance:

- Every `krn-retro` and every handoff adds, reranks or removes at least one row from evidence seen in the slice, or records why not. The handoff's `## Resume` carries `- Roadmap: <ids changed>` or `- Roadmap: unchanged (<reason>)`; `scripts/claude/handoff-requests.ts` refuses a handoff without that line or naming an id with no row here.
- A rerank cites a window, not dollars per PR (ADR 0014 D23 measures amendment): `krn state retro --task <id>` prints the window of the task's span measured from the main checkout; for a span of many tasks run `krn ledger --window <from> <to>` or `--last <n>` from the main checkout, and put the PR count and the window in the row's Evidence.
- The proactive refill scan runs `krn-radar` and triages each pattern into a row or a rejection.
- External material the operator shares is triaged into a row (or explicitly rejected) in the same session.
- Ids are stable: a new row takes an id above every id used before (R10 onward; positional ids reached R9), and an id is never renumbered or reused. Table order is the rank; rerank by moving rows.
- A row leaves the table after its task closes: lanes close tasks without touching this file, and the lead runs `node scripts/claude/roadmap-prune.ts` in its next slice, so parallel lanes never rebase the table onto each other.

| Id | Opportunity | Area | Evidence | Expected saving | Task |
|---|---|---|---|---|---|
| R25 | Launchers mark their sessions | tokens | program §4 B2 | wave order | t-bs1ytt2 |
| R3 | Confirm the #472 read refusal on 20 sessions | tokens | `.krn/runs/roadmap-refill/post-472-n7.md`: 7 sessions, 47% | decides a second step | t-zz33vhy |

Sector plan (t-8hnmfr9), refilled by t-y3chym7: cost is dollars per merged PR (cache reads ~10% of input), not raw tokens. Since 2026-11-07 lead sessions cost median $1.62 and 41 turns per PR; Bash results are 94% of lead tool bytes, half of them file reads; 35% of lead cache reads come from turns over 150k (`.krn/runs/roadmap-refill-2/tokens.md`). Subagent spend (t-akp44kt): after the krn-lane 90-turn cap (#496) subagents fell from $2.03 to $0.28 per PR and agents over 100 turns from 15 to 0 on 15 PRs (`.krn/runs/subagent-spend/agent-scan.py`). KRN-owned startup text is ~2.3k of the ~25k first turn: closed as a track after t-bdhn7mw. The global skill listing (~17 kB per turn, mostly non-KRN skills) is the operator's call. t-qdzy8w7: handoff re-reads fell from 104 of 109 sessions to 1 of 4 (provisional). Delivery and CI time hold no row: PR open-to-merge median 1.6 min, Check median 58 s, 2 of 60 runs failed and none was rerun (`.krn/runs/roadmap-refill-3/ci-friction.md`, refilled by t-kb4mvq8).

Strategy review triage (`.krn/runs/strategy-review/report.md`): accepted as two rows (since closed) and t-ez3nsc3 (closed: PATH `krn` is the Product CLI); ADR 0014 D17 and the D30 review-tier amendment now say they are superseded. Deferred until R5 data: sampled post-merge Codex review, the Codex worker proof against lead-only slices (D23), and a memory A/B on replayed closed tasks (no `harness` command exists, contrary to the report) (ADR 0002 store stays unbuilt). Operator decisions open: weekly-limit pressure, plan tier, a pilot repository for the worker proof, disabling non-KRN global skills in KRN sessions.

Junk (`.krn/runs/roadmap-refill-2/junk.md`, 1829 tracked files enumerated): t-y3chym7 removed the unread CI catalogue and journey baseline; kept with a reader: `evals/fr40/results` (FR-40 verdict), `evals/woz` (ADR 0014 D20), `scripts/codex/hook-probe.ts` (t-9zd1ev0 live probe). Earlier results: FR-40 GO with packet injection (t-b9zs937); identifier index after compaction (t-7dk0vgk); idleCompaction excluded (#315).
