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
| R56 | The ledger counts lanes started with the Agent tool as lanes | Measurement | `krn ledger` (t-496nx1h #757) counts the 2026-11-14 Agent-tool lanes #749-#757 as lead | A true lane/lead split for the rework baseline | t-kzbza45 |
| R57 | Fresh eval units come from pilot repositories with hidden tests | Measurement | `evals/d23/preregistration.md`: power 0.217 at n=33, 188 units for 0.8 | Makes the K vs PB claim decidable | t-tgf314k |
| R52 | The lane run is a pipeline of named stages in their own modules | Delivery speed | `src/cli/lane-run.ts` 1,263 lines, 37 commits in 14 days, in most ledger frame PRs | Lane-area lanes run in parallel; lane-run.ts touched at most 5 of the next 20 PRs | t-79e2gr4 |
| R47 | A red test blocks Stop in a D23 replay clone and red-baseline units are excluded | Measurement | DEC:71-72 | Clean D23 arms before t-p70b19s | t-f26er7t |
| R48 | The D23 confirmatory run compares a frozen K with PB | Measurement | Waits on R47 and R57 (power, `evals/d23/preregistration.md`) (memory:quota-before-big-runs) | The product claim K beats plain harness, measured | t-p70b19s |
| R50 | krn adopt --verify reports the required check and auto-merge state | Portability (goal 1) | Python pilot needed t-j5ztpwy and t-8j7cc85 fixes found only at first ship | Adoption defects found before the first lane | t-atagtp3 |
| R49 | A worker proves a failing reproduction test before its fix | Standards (goal 2) | Pilot hidden tests were lead-written; workers prove nothing before the fix | Fewer false-green lanes | t-czn62h3 |
| R54 | Session start prints STATE LOSS when an open claim has no capsule or handoff | Memory (goal 2) | Knowledge lost between sessions (operator 2026-11-14) | Orphan claims surface at session start | t-8r8y9a3 |
| R55 | The roadmap is generated from open tasks | Memory (goal 2) | roadmap.md is the most-churned file (95 commits in 14 days) | Hand edits of the roadmap drop to zero | t-n9m37wy |
| R41 | The brain packet keeps only what its ablation shows helps | Memory (goal 2) | FR-40 GO +21.1 pp B-A (`evals/fr40/results.md`); no per-part ablation yet | Smaller packet, same pass rate | t-3kegrb2 |
| R42 | FR-40 arm C measures the conventions packet against the instruction file alone | Memory (goal 2) | FR-40 compared packet with no packet, not with the instruction file | Proves the packet adds beyond AGENTS.md | t-1y29yhq |
| R44 | Each worker hook earns its place in a D23 ablation | Standards (goal 2) | Hooks were added by incident, never measured | Drop hooks that do not move the hidden-test pass rate | t-jtpbrm3 |

Earlier notes (sector plan, strategy-review triage, junk scan) live in git history before t-72wjf0z.
