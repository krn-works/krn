# First ten tasks per adopter: preregistration

Frozen before any adopter cohort is read (ADR 0021 point 4, Fisher rule). `node evals/adoption/first-ten.ts --report` reads this file; changing a threshold after a cohort exists voids that cohort.

## Design

tasks-per-adopter: 10
min-adopters: 3
treatment: C
control: B
alpha: 0.05
fail-p: 0.1
min-benefit-pp: 10
max-cost-ratio: 1.25

- Cohort: per adopter, the first ten consecutive tasks after adoption (seq 1..10, no gaps), each replayed twice from the same pre-task SHA: arm C (KRN) and arm B (the static control: the in-force records as a static CLAUDE.md, `evals/replay/arms.ts`). Rows are the replay `Row` of `evals/replay/rows.ts` plus `adopter`, `seq` and `sha`.
- Qualifying adopter: all ten seq values present, each with one graded C row and one graded B row on the same sha. Any other adopter is reported and excluded; all rows must share one harness.
- Quality: pooled over qualifying adopters, failures of C against failures of B, one-sided Fisher exact p of a benefit (`fisherBenefitP`, the rule of ADR 0021 point 4).
- Cost: total USD of C over total USD of B across the same rows; any unknown cost makes the cost unestablished.
- INSUFFICIENT: fewer than `min-adopters` qualifying adopters, mixed harness, unknown cost, or a result between the PASS and FAIL conditions.
- PASS: p below `alpha`, pass-rate gain of at least `min-benefit-pp` points, and cost ratio at most `max-cost-ratio`.
- FAIL: p at or above `fail-p` (no benefit shown), or cost ratio above `max-cost-ratio`.
- Report: `node evals/adoption/first-ten.ts --report [--rows <file>] [--prereg <file>]`; stdout is exactly the verdict word, the evidence goes to stderr; exit 0 PASS, 1 FAIL, 65 INSUFFICIENT.
