# Fable plan brief

The template for asking Fable to plan breakthroughs. A planner that never sees which predictions held cannot learn what yields real gains, so every request carries the scorecard and every slice states a prediction.

## Attach to the request

- The latest scorecard: `krn ledger --predictions` (one row per plan: hit, miss, unmeasured, unpredicted).
- The failure logs of the last plan's lanes: `.krn/runs/lanes/` verdicts and `.krn/runs/outside/summary.txt` (paths, not contents).
- The proof counts per lane: `.krn/brain/exposures.jsonl`.

## Required of each slice

Each slice becomes one task (`krn task create`) with `Source:` naming the plan, `Why:`, `Outcome:`, `Files:`, `Proof:` and one `Predicted:` line, a measurable claim on a named source:

- `Predicted: proof <field> <op> N` on the task's own lane run, field one of `clauses`, `clauses-total`, `red-first`, `precedent`, `stop-refusals` (the proof line `krn lane run` prints).
- `Predicted: outside <field> <op> N in <op> K rows` over the outside rows, field one of `adopt`, `drain`, `sessions`, `usd`, `hidden` (pass counts 1, fail 0, none is skipped), for example `outside drain == 0 in >= 3 rows`. Only rows whose hook commit is at or after the task's merge (its `Ticket:` commit on main) count; with none, the claim is unmeasured.

`<op>` is one of `>=`, `<=`, `==`, `>`, `<`. A prediction names what would show the slice bit outside KRN's own tests; a slice that passes KRN tests but moves no outside row is a miss. The line is optional for tasks: a task without one is `unpredicted`, never invalid.
