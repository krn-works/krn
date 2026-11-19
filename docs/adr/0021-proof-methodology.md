# 21. Proof methodology: what KRN may claim, and how each claim is measured at its own traffic

Date: 2026-11-15

## Status

Accepted. Amends [ADR 0002](0002-brain-v2.md) section "Automatic trial and retirement": automatic retirement is frozen until the rule below is implemented. Restates what the D23 comparison ([ADR 0014](0014-operator-decisions-2026-10-23.md) D23, `evals/d23`) showed. Amends `docs/program/fable-plan-brief.md` with a third prediction source. Implements north-star item 5 and the "Prove" verb. Amended 2026-11-18 (operator grant, point 10): arm C gains a Remember mechanism, retrieval is capped and gated, Stop runs executable checks only, and the MDE and n are recomputed. The amendment lands before the S8 freeze; no confirmatory row exists yet.

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
   - It reopens with this rule: a record retires when the one-sided 90% Wald upper bound of its benefit (withheld violation rate minus served violation rate, plus z = 1.2816 standard errors) is below a margin of 0.25, with at least 10 withheld and at least 30 served scoped diffs. Implemented in `src/brain/retire.ts` (`RETIRE_Z`, `RETIRE_MARGIN`) by t-76cjaca, which replaced the earlier significance-test rule.
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
   - Isolation (amended after the S7 screen, where a session read the upstream fix with the host's `gh`):
     - Every arm's session carries no GitHub identity: `GH_TOKEN` and `GITHUB_TOKEN` are unset and `GH_CONFIG_DIR` is an empty directory, so `gh pr view -R <upstream>` fails with an auth error.
     - `WebFetch` and `WebSearch` are disallowed.
     - Third-party install and test commands run in bubblewrap with HOME hidden: only the toolchains under it are visible, so no credential file is readable, even while the install has network.
     - Residual risk: a public upstream stays reachable without credentials through curl or `git clone`. That route is detected, not blocked. `node evals/replay/contamination.ts <rows> <scratch>` reads each call's result. It flags a row when a gh, git-remote, curl/wget or web call returned content. A refused `gh` is not contamination, and a repository path in an import or a grep pattern is not a call.
   - Design: 3 reps per unit and arm, unit-clustered paired SE, Holm correction over C−A and C−B, MDE 16 pp at power 0.8 with 70 units (recomputed in point 10; the first draft said 15 pp without the Holm step).
   - Co-primary: paired log-cost ratio and USD per resolved task, with C at no more injected tokens than B. Regression rate (point 10) is reported beside hidden-test pass rate.
   - Allowed outcome: "not shown" is a published result.
   - Budget: about 630 sessions and about 375 USD notional (about 0.60 USD per session, as arm-A rows record), in off-peak quota windows. The operator approved this figure on 2026-11-17, replacing the 115 USD estimate, which assumed 0.18 USD per session.
   - Debt columns ride along as descriptive: lint delta and diff size against the upstream fix.
8. **Freeze before running.** Every eval has a preregistration file, a fixed K commit and a fixed n. There is no interim grading without a written alpha-spending boundary. The runner guard of #756 extends to every eval. Units are never reused after a confirmatory run.
9. **Predictions get a third source.** `Predicted: metric <name> <op> N`, where `<name>` is a row in `spec/metrics.json` mapping to a command that prints one number. `krn ledger --predictions` runs it at the task's merge commit and at HEAD. Every ADR's "Expected effect" command is registered there.

10. **Redesigned proof (amendment, operator grant 2026-11-18).** Evidence: `evals/replay/arm-b.ts:69` fills B to carry at least what C injects, so C−B as built measures only the timing of generic conventions; the literature predicts a C−A effect of 0 to +5 pp, below the MDE of point 7.
   - **Remember arm.** Arm C includes Remember. Units of one repo run in commit-date order. A graded failure of an earlier unit proposes an evidence-gated record (the failing hidden-test or check output is the evidence; no evidence, no record). Proposed records are served to later units of the same repo only. Arm B receives the same records rendered statically, so C−B still isolates retrieval and timing. 48 of 73 screened units sit in 18 repos with at least 2 units; 30 of them are later units that can receive a record. A pilot on non-frozen pilot units precedes the freeze.
   - **Cap and precision gate.** At most 3 records are served per retrieval moment. A record is served only when it passes a retrieval precision gate (scope match plus the recall@5 evidence of ADR 0020 for its moment); a record that fails the gate is withheld, not padded in. Basis: precision decides the sign of retrieval (oracle +8 pp, free retrieval -4 pp, SWE-ContextBench arXiv 2602.08316); curated compact sets of 2 to 3 help while comprehensive sets hurt (SkillsBench arXiv 2602.12670: +4.5 pp on software tasks, comprehensive -2.9 pp); 92 of 98 skills had no effect (arXiv 2603.15401).
   - **Stop runs executable checks only.** No review step. Basis: self-review lowered solve rate by 2.8 to 14.6 pp (arXiv 2611.01181); static context files give no solve gain (arXiv 2602.11988).
   - **Reported beside pass rate.** Cost per resolved task and regression rate (a unit whose rep passes the hidden tests while breaking a test that passed at the base commit) are reported next to hidden-test pass rate for every arm. They are descriptive for regression rate and co-primary for cost.
   - **MDE and n recomputed.** Paired SD 0.44 (point 7 context), power 0.8, two-sided, normal approximation, n = ((z(1-alpha/2) + z(0.8))² · SD²) / delta²; Holm first step uses alpha 0.025 (z 2.2414), unadjusted uses 1.96; z(0.8) = 0.8416.

     | effect delta | n units, unadjusted | n units, Holm |
     | --- | --- | --- |
     | 3 pp | 1689 | 2045 |
     | 5 pp | 608 | 737 |
     | 8 pp | 238 | 288 |
     | 15 pp | 68 | 82 |

     With 70 units the MDE is 14.7 pp unadjusted and 16.2 pp under Holm, so the preregistered MDE is 16 pp. On the 30 later units that can receive a Remember record the MDE is 22.5 pp (24.8 pp under Holm). Expected effect: C−A 0 to +5 pp (SkillsBench +4.5 pp on software tasks; subtask memory +4.7 pp, +2.3 pp on the strongest model, arXiv 2602.21611; oracle retrieval +8 pp, diluted to about 3 pp over all units because only 30 of 73 can receive a record). A 5 pp effect needs 608 to 737 units, which the pool of about 73 post-cutoff units cannot supply. Decision: the run stays a large-effect detector; a "not shown" correctness result is the expected outcome and is published as such; cost per resolved task, regression rate, per-record retirement (point 4) and compliance carry the claims this traffic can support. The budget of point 7 does not change.
   - **Check of the premise, by command.** `seedStandards` (`src/brain/standards.ts:337`) was run on a fresh outside clone: `git clone --depth 1 https://github.com/sindresorhus/is-plain-obj` (commit 666df7c, exit 0), then `bin/krn adopt <clone> --no-canary` (exit 0; without `--no-canary` adopt exits 64 and removes what it wrote because the clone has no test file the canary can break), then the records in `<clone>/.agents/standards.json` were counted by layer and origin. Result: 31 records, 31 universal inherited from the pack, 0 project-own. A fresh outside clone therefore receives only the universal pack at the start; project records appear only when something adds them, which is exactly what the Remember arm does. This confirms that without Remember, C serves B what B already carries.
   - Falsified if: after the pilot, Remember proposes no evidence-gated record from the failed units of repos with at least 2 units, or C with Remember serves later units nothing different from B. Then the Remember arm is dropped and the run reports cost only.

11. **Primary claim (operator decision 2026-11-19, option b of t-kcjr0pf).** With about 73 units the correctness MDE (16 pp under Holm, point 10) sits far above the 0 to +5 pp the literature predicts, and a 10x pool expansion (608 to 737 units) was declined. S8 therefore makes three claims primary: (1) USD per resolved task, C against A and B (paired log-cost ratio, Holm over the two contrasts); (2) regression rate (point 10 definition), C against A; (3) per-record measured effect, each served record's violated/served rate and its pass-rate delta on the units it was served to, from the exposure rows. Hidden-test pass rate (C−A, C−B) stays reported with its CI as a secondary claim; "not shown" on it is the expected and publishable result. The plan's S8 prediction moves from C−A pass rate to cost.

## Expected effect

- The brief-only clause arm is measured: PC − P is reported with a CI. Prediction: under +10 pp. Measure: `node evals/d23/analysis.ts --arms P,PC`.
- Random retirements are 0 over 30 days. Measure: `git log --since=30.days -p -- standards/records.json | grep -c '"status": "retired"'` against rows meeting the bound-below-margin rule.
- Within 4 weeks of point 3, at least 10 command-enforced records have at least 30 served scoped diffs with `violated` recorded. Measure: `krn standards effect --json | node -e` count.
- Scorecard: of the slices in `docs/program/plan.md`, at least 80% score hit or miss (not unmeasured) within 7 days of merge. Today 1 of 911 rows scored. Measure: `krn ledger --predictions`.
- A/B/C: screening reports A's pass rate. If A ≤ 85%, the confirmatory run reports C−A and C−B with CIs, USD per resolved task and regression rate; the expected C−A is 0 to +5 pp, so "not shown" is the expected correctness verdict (point 10). Measure: `node evals/replay/run.ts --prereg evals/replay/abc.prereg.md --report`.

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
