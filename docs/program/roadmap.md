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
| R40 | The lead starts each session with KRN's own capability index instead of answering from recall | Memory (goal 2) | 2026-11-14: the lead called a sandbox placeholder foreign and missed an existing `krn hook stop` and lane budget cap in one session | Fewer wrong lead claims and redone recon per session | t-zp0qer4 |
| R41 | The brain packet keeps only what its ablation shows helps | Memory (goal 2) | FR-40 GO +21.1 pp B-A (`evals/fr40/results.md`); no per-part ablation yet | Smaller packet, same pass rate | t-3kegrb2 |
| R42 | FR-40 arm C measures the conventions packet against the instruction file alone | Memory (goal 2) | FR-40 compared packet with no packet, not with the instruction file | Proves the packet adds beyond AGENTS.md | t-1y29yhq |
| R43 | Worker hooks live in `src/` behind `krn hook`, one gate for KRN, adopted repos and eval arm K | Portability (goal 1) | `src/cli/hook.ts` spawns `scripts/claude/worker-stop.ts`; first lane stopped at 13 turns (`.krn/runs/overnight/lanes-1114/`) | One gate implementation; unblocks t-f26er7t, t-8qs4azg | t-nfjxshj |
| R44 | Each worker hook earns its place in a D23 ablation | Standards (goal 2) | Hooks were added by incident, never measured | Drop hooks that do not move the hidden-test pass rate | t-jtpbrm3 |
| R45 | The lane verdict turn count matches the session transcript | Measurement | t-cencnmk printed `turns 1` with 22 assistant messages in its transcript | Trustworthy lane cost tables | t-xvqckym |
| R46 | adopt installs worker guards for tracker writes, stash and main-checkout writes | Portability (goal 1) | Two pilots (TS t-djnrw3t, Python t-811vn27 5/5 hidden PASS) ran with KRN-only guards | Outside repos get the same protection as KRN | t-8qs4azg |
| R47 | A red test blocks Stop in a D23 replay clone and red-baseline units are excluded | Measurement | DEC:71-72; blocked by R43 | Clean D23 arms before t-p70b19s | t-f26er7t |
| R48 | The D23 confirmatory run compares a frozen K with PB | Measurement | Waits on R43-R47 (memory:quota-before-big-runs) | The product claim K beats plain harness, measured | t-p70b19s |
| R49 | A worker proves a failing reproduction test before its fix | Standards (goal 2) | Pilot hidden tests were lead-written; workers prove nothing before the fix | Fewer false-green lanes | t-czn62h3 |
| R50 | krn adopt --verify reports the required check and auto-merge state | Portability (goal 1) | Python pilot needed t-j5ztpwy and t-8j7cc85 fixes found only at first ship | Adoption defects found before the first lane | t-atagtp3 |

Earlier notes (sector plan, strategy-review triage, junk scan) live in git history before t-72wjf0z.
