# 21. Proof methodology: what KRN may claim, and how each claim is measured at its own traffic

Date: 2026-11-15

## Status

Accepted. Amends [ADR 0002](0002-brain-v2.md) section "Automatic trial and retirement": automatic retirement is frozen until the rule below is implemented. Restates what the D23 comparison ([ADR 0014](0014-operator-decisions-2026-10-23.md) D23, `evals/d23`) showed. Amends `docs/program/fable-plan-brief.md` with a third prediction source. Implements north-star item 5 and the "Prove" verb.

## Context

- **The specification effect is an oracle upper bound** (judge-J5 F1, verified in judge-J10 section 1).
  - "PB 62.5% vs P 10.7%" used requirements generated from the hidden tests. `evals/d23/requirements.ts` tells the generator to give "every literal a test depends on verbatim".
  - In the same run, K−PB was +8.9 pp with p = 0.127, and the run stopped after an interim grade was read.
  - The arm that ships, clauses from the brief only, has never been measured.
- **Per-record effect is broken as built** (judge-J5 F2, F3).
  - `withheld` covers every held-out candidate, not only the records the packet would have served. That is selection bias.
  - Every served record gets the same run outcome.
  - The holdout is keyed by task id, so reruns correlate: `r-r-4` was withheld 11 times in 45 lanes.
  - `rework` is 0 in 45 of 45 rows.
  - `retire.ts:14-17` compares rates with no test. At 71% lane-ok, three withheld runs all succeed with probability 0.36, so retirement is close to random.
- **Per-rule effect on lane outcome cannot be reached at this traffic.** It needs about 1,700 eligible tasks per record (judge-J5 F4). A per-record binary signal is reachable: did the record's own check fail on the final diff (judge-J2 D-M5, judge-J3 D5).
- **A/B/C on correctness has little power as it stands** (judge-J5 F5).
  - Paired SD is 0.44. Detecting +15 pp needs 68 units, and +9 pp needs 188.
  - The current discriminating rows sit at 100%.
  - `scripts/outside-acceptance.ts` has no A or B arm.
  - External base rates predict a small effect: Gloaguen about +4%, harness variation ±2 to 5%.
- **Compliance is mostly at ceiling.** FR-40 moved 2 of 7 strata, so a probe replay of every record measures the probe (judge-J10 section 3).
- **The prediction scorecard cannot teach a planner.** `predictions.txt` holds 1 hit, 0 misses, 24 unmeasured and 886 unpredicted. The two allowed claim forms (lane proof fields, outside rows) cannot express most claims.

## Decision

1. **Claims ladder.** A record, a moment or the product is described only by the highest rung it has reached:
   - `unmeasured`
   - `compliance measured` (delta, CI, n, date)
   - `correctness measured` (hidden tests)

   "Improves correctness" is never written for anything below the third rung. D23 is cited as "oracle specification, upper bound".
2. **Measure the arm that ships.** Run P against P plus `clauseSection(brief)` on the 56 screened run1 units, 2 reps, with paired unit-clustered SE (`evals/d23/analysis.ts`). The result decides whether clauses stay the centre of task start.
3. **Exposure rows, `krn.exposure/v1`.**
   - Fields: `at`, `channel`, `task`, `attempt`, `record`, `arm` (`served | withheld`), `tokens`, `bytes`, and a per-record `violated`.
   - `violated` is the record's own `enforcement.run` on the final diff. It is null for records without a check.
   - `rework` is dropped.
   - `withheld` is exactly (records the packet would serve without holdout) ∩ (held out). This is intent-to-treat on eligibility.
   - The holdout is keyed by (task, record) and deduplicated across attempts.
4. **Retirement by measurement.**
   - `krn standards retire --write` is frozen.
   - It reopens with this rule: a record retires when served-versus-withheld violation rates show no benefit under Fisher's exact test (one-sided p ≥ 0.1 for benefit) with at least 10 withheld and at least 30 served scoped diffs.
   - Separately, a record whose scope matched no diff in 60 days is flagged for `review_by`.
5. **Probe replay** (paired, FR-40 style, about 1.50 USD per record) runs only for prose records that pass the retrieval eval of ADR 0020 and have no check. A record that cannot be scored stays `unmeasured`.
6. **One replay harness, with arms as configuration.** `evals/d23`, `evals/fr40/lanes.ts` and `scripts/outside-acceptance.ts` merge into one runner with three arms:
   - A: plain clone.
   - B: the same in-force records rendered to a static CLAUDE.md, token-matched.
   - C: KRN.

   The results format is (unit, arm, rep, pass, cost, harness sha).
7. **A/B/C, preregistered as a large-effect detector with cost co-primary.**
   - Units: at least 70, drawn from public fix commits dated after June 2026. Bodies are written from the issue text only. A unit is excluded when a hidden test asserts an identifier the body does not state.
   - Screening: a separate screening run. The confirmatory run starts only if arm A passes at most 85% of units.
   - Design: 3 reps per unit and arm, unit-clustered paired SE, Holm correction over C−A and C−B, MDE 15 pp at power 0.8.
   - Co-primary: paired log-cost ratio and USD per resolved task, with C at no more injected tokens than B.
   - Allowed outcome: "not shown" is a published result.
   - Budget: about 630 sessions and 115 USD, in off-peak quota windows.
   - Debt columns ride along as descriptive: lint delta and diff size against the upstream fix.
8. **Freeze before running.** Every eval has a preregistration file, a fixed K commit and a fixed n. There is no interim grading without a written alpha-spending boundary. The runner guard of #756 extends to every eval. Units are never reused after a confirmatory run.
9. **Predictions get a third source.** `Predicted: metric <name> <op> N`, where `<name>` is a row in `spec/metrics.json` mapping to a command that prints one number. `krn ledger --predictions` runs it at the task's merge commit and at HEAD. Every ADR's "Expected effect" command is registered there.

## Expected effect

- The brief-only clause arm is measured: PC − P is reported with a CI. Prediction: under +10 pp. Measure: `node evals/d23/analysis.ts --arms P,PC`.
- Random retirements are 0 over 30 days. Measure: `git log --since=30.days -p -- standards/records.json | grep -c '"status": "retired"'` against rows meeting the Fisher rule.
- Within 4 weeks of point 3, at least 10 command-enforced records have at least 30 served scoped diffs with `violated` recorded. Measure: `krn standards effect --json | node -e` count.
- Scorecard: of the slices in `docs/program/plan.md`, at least 80% score hit or miss (not unmeasured) within 7 days of merge. Today 1 of 911 rows scored. Measure: `krn ledger --predictions`.
- A/B/C: screening reports A's pass rate. If A ≤ 85%, the confirmatory run reports C−A and C−B with CIs and USD per resolved task. Measure: `node evals/replay/run.ts --prereg evals/replay/abc.prereg.md --report`.

## Consequences

- North-star wording changes, in the tracked copy in `plan.md`: the D23 line reads "oracle upper bound; the brief-only arm is under measurement".
- `src/brain/retire.ts` logic is replaced. The `rework` field leaves `exposures.ts`. `src/evals/stats.ts` is deleted (ADR 0017).
- Three harnesses become one. `scripts/outside-acceptance.ts` (1,228 lines), `outside-testgrade.ts` and `evals/d23/harness.ts` fold into `evals/replay/`. Headless `krn lane run` survives only as this runner's session driver (ADR 0022).
- The two outcome measurements keep separate jobs: `src/outcome` reports cost and time per PR; `src/brain/exposures.ts` is the only per-record effect source. `rework-blame.ts` is deleted if nothing reads it after `rework` is dropped.

## Falsified if

- PC − P is at or above +20 pp. Then F1 of J5 is wrong for this product, clauses are a pillar on real evidence, and the task-start budget may grow.
- After 8 weeks no record reaches 30 served and 10 withheld scoped diffs. Then per-record proof is not reachable here, and KRN falls back to per-moment ablation: a whole moment off for a holdout share of sessions.
- Records that pass a probe replay show transfer correlation ρ < 0.3 with compliance on merged PRs over 30 days. Then probe replay is dropped.
- Fewer than 50 post-cutoff discriminating units are found in 2 slices. Then the A/B/C run is cut to cost-only, with correctness reported as descriptive.
- After a "not shown" result the same units are rerun with a tuned K. Then the result is void and the units are burned.
