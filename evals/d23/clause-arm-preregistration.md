# Clause arm: P against P plus clauses from the brief, preregistered

Committed before any PC session runs and before any PC run is graded. ADR 0021 point 2 asks for the arm that ships: the acceptance clauses `krn lane brief` builds from the task's own words, with no requirements text derived from hidden tests. The earlier "PB 62.5% vs P 10.7%" used requirements generated from the hidden tests (`evals/d23/requirements.ts`) and is an oracle upper bound.

## Design
- Arms: P (plain clone, harness files stripped, task text plus the interface paragraph of `interface-base`) and PC (the same, plus `clauseSection(statedBody(task))` from `evals/d23/clauses.ts`, appended to the prompt). PC carries no requirements text, no hook, no Stop refusal and no skill; it measures only the clause text a brief carries.
- Units: the 56 screened run1 units in `evals/d23/clause-arm-units.txt` (the units the D23 v2 run1 P arm finished). Planned unit count n = 56.
- Repetitions: 2 per unit and arm. P run 1 already exists from D23 v2 (same model, effort, budget and timeout); P run 2 and PC runs 1 and 2 are new. Every P and PC run is graded again with the same `evals/d23/runs.ts` at one commit, so the arms share one grader.
- Primary measure: paired per-unit mean correctness PC - P, standard error clustered on the unit, 95% CI, normal approximation, two-sided (`pairedDifference` in `evals/d23/analysis.ts`). Command: `node evals/d23/analysis.ts --arms P,PC`.
- Secondary, descriptive: scope-clean runs, refusals, cost per correct run.
- No interim grading. Runs that ended on a usage limit or an API error are rerun; a run that still has no result is listed and excluded, never counted as correct.

## Prediction and decision rule
- Prediction (`Predicted: metric clause-arm-delta-pp < 10`): PC - P is under +10 pp.
- Falsified if PC - P is at or above +20 pp (ADR 0021 "Falsified if"): then clauses carry real evidence and the task-start budget may grow.
- Reading of the CI [lo, hi] (m = 10 pp): clauses better when lo > 0; clauses worse when hi < 0; equivalent when the 90% CI lies inside (-m, +m); otherwise "not shown". "Not shown" is a published result and triggers no rerun on these units with a tuned arm.

## Power at n = 56
Per-unit SD of the paired difference 0.44 (D23 v2 run1, see `preregistration.md`); se = 0.44 / sqrt(56) = 5.9 pp. The minimum detectable effect at power 0.8 is about 16.5 pp. Equivalence at m = 10 pp is not powered (the 90% CI half-width is 9.7 pp at best and the SD with two runs is likely lower, so a "within 10 pp" claim is possible only if the point estimate is near zero). A true +9 pp most likely returns "not shown"; that outcome is decided here.

## Known limits
- P run 1 ran on 2026-11-12/13 and P run 2 and both PC runs happen on 2026-11-15; the model, effort, budget (6 USD) and timeout (1500 s) are the same, the Claude Code client may differ by a patch version. The run record states the client version.
- The call-site sweep of `krn lane brief` for defect bodies needs the repository clone and is not part of PC: PC is the clauses of the body only.
- The clauses are the task body split as `splitClauses` splits it, so a body of prose sentences becomes sentence clauses. That is what ships.
