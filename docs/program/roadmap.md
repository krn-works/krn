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
| R57 | Fresh eval units come from pilot repositories with hidden tests | Measurement | `evals/d23/preregistration.md`: power 0.217 at n=33, 188 units for 0.8 | Makes the K vs PB claim decidable | t-tgf314k |
| R48 | The D23 confirmatory run compares a frozen K with PB | Measurement | Waits on R47 and R57 (power, `evals/d23/preregistration.md`) (memory:quota-before-big-runs) | The product claim K beats plain harness, measured | t-p70b19s |
| R49 | A worker proves a failing reproduction test before its fix | Standards (goal 2) | Pilot hidden tests were lead-written; workers prove nothing before the fix | Fewer false-green lanes | t-czn62h3 |
| R55 | The roadmap is generated from open tasks | Memory (goal 2) | roadmap.md is the most-churned file (95 commits in 14 days) | Hand edits of the roadmap drop to zero | t-n9m37wy |
| R58 | Each standard has a tier: floor blocks Stop, reflex needs a recorded waiver, finish reports | Standards (goal 2) | Trending triage 2026-11-14: Nutlope/hallmark tiers, pbakaus/impeccable LLM-free detector with exit 2; .agents/standards.json has enforcement but no tier | Adopted repositories block only on what matters and record every exception | t-36g8bmh |
| R59 | krn adopt --verify reports adoption files that drifted from what adopt writes | Portability (goal 1) | Trending triage 2026-11-14: NVIDIA/auto-ontology read-back publish; nothing proves an adopted repository still holds its adoption set | Silent drift of inherited standards found by one command | t-hkxkffg |
| R41 | The brain packet keeps only what its ablation shows helps | Memory (goal 2) | FR-40 GO +21.1 pp B-A (`evals/fr40/results.md`); no per-part ablation yet | Smaller packet, same pass rate | t-3kegrb2 |
| R42 | FR-40 arm C measures the conventions packet against the instruction file alone | Memory (goal 2) | FR-40 compared packet with no packet, not with the instruction file | Proves the packet adds beyond AGENTS.md | t-1y29yhq |
| R44 | Each worker hook earns its place in a D23 ablation | Standards (goal 2) | Hooks were added by incident, never measured | Drop hooks that do not move the hidden-test pass rate | t-jtpbrm3 |
| R60 | A rule test fails on a path or command named in instruction files that does not exist | Memory (goal 2) | Trending triage 2026-11-14: google/elephant-goldfish-model drift report; t-31exd5c stale text | Agents stop following dead references | t-6vkmy4w |
| R61 | Review findings follow a schema a validator checks and a fresh-context verifier confirms | Standards (goal 2) | Trending triage 2026-11-14: cloudflare/security-audit-skill findings.json and verifier, elephant-goldfish fresh-context review | Review claims become checkable instead of self-assessed | t-pj744qg |

Earlier notes (sector plan, strategy-review triage, junk scan) live in git history before t-72wjf0z.
