# D23 confirmatory run: K against PB, preregistered decision rule

Committed before any confirmatory arm runs. The runner (`node evals/d23/runs.ts --confirmatory --prereg evals/d23/preregistration.md --prereg-sha256 <sha256 of this file>`) refuses to start unless this file is tracked, unchanged from HEAD, and matches the named hash. A change to this file is a new preregistration with a new hash; the old one is reported beside it.

## Design
- Arms: K (one frozen commit) and PB (plain harness, same requirements text). Two runs per unit. Observations come from `evals/d23/analysis.ts`.
- Primary measure: paired per-unit mean correctness K - PB, standard error clustered on the unit, normal approximation, two-sided (`pairedDifference`).
- Units: the 33 D23 units K was not tuned on. Planned unit count n = 33.
- Frozen K: one K commit, recorded in the run output; K is not edited between the first and last arm run.

## Decision rule (95% CI of K - PB = [lo, hi]; equivalence margin m = 10 pp, TOST at alpha 0.05, so the 90% CI [lo90, hi90])
| outcome | rule | what it triggers |
|--|--|--|
| K better | lo > 0 | report K better; no K change is needed to claim it |
| worse | hi < 0 | report K worse; open a task naming the units where K is below PB; no rerun on these units |
| equivalent | lo90 > -m and hi90 < +m | report K equivalent to PB within 10 pp |
| not shown | none of the above | report "not shown" with the CI; the 33 units are spent for K as it stands |

"Not shown" never triggers a K change followed by a rerun on the same units. Any K change after this run is judged only on fresh units (below), with a new preregistration.

## Power at the planned unit count
Per-unit SD of the paired difference: sd = 0.44. Source: D23 v2 run1 (t-cbwqm50), K - PB 56 units, CI [-2.5, 20.4] pp, so se = (20.4 + 2.5) / (2 * 1.96) = 5.84 pp and sd = se * sqrt(56) = 43.7 pp. Rounded to 0.44; two runs per unit lower it slightly, so this is conservative.

Formulas (`evals/d23/preregistration.ts`, tested):
- se = sd / sqrt(n); power(delta) = Phi(delta / se - 1.96) + Phi(-delta / se - 1.96).
- units for power 0.8: n = ((1.96 + 0.8416) * sd / delta)^2.
- equivalence (TOST, true difference 0): equivalent needs |d_hat| < m - 1.645 * se; units for power 0.8: n = ((1.645 + 1.2816) * sd / m)^2.

| quantity | value |
|--|--|
| se at n = 33 | 7.7 pp |
| power, true +9 pp, n = 33 | 0.217 |
| power, true +15 pp, n = 33 | 0.499 |
| power, true +20 pp, n = 33 | 0.743 |
| units for power 0.8 at +9 pp | 188 |
| units for power 0.8 at +15 pp | 68 |
| units for power 0.8 at +20 pp | 38 |
| equivalence power at n = 33, m = 10 pp | 0 (the 90% CI half-width, 12.7 pp, exceeds m) |
| units for equivalence power 0.8, m = 10 pp | 166 |

Reading: the 33-unit run can claim "K better" only for a true effect near +20 pp and cannot claim "equivalent" at all. A true +9 pp most likely returns "not shown" (power 0.217); that outcome is expected and decided here, not tuned away.

## Fresh units (outside the D23 set)
Fresh units are tasks with hidden tests written before any arm runs, kept outside the worktree, on repositories K and PB have not seen:
- krn-works/seo-audit-harness (TypeScript pilot, PRs #78-#82; task t-djnrw3t): 5 units, K arm exists; PB arm to run.
- krn-works/krn-pilot-py (Python pilot; task t-811vn27): 5 units, K arm exists; PB arm to run.
- New pilot tasks authored on these two repositories with hidden tests to reach the unit count the question needs (166 for equivalence at 10 pp, 188 for +9 pp). Until then 10 pilot units alone have power 0.099 at +9 pp and are reported as descriptive.
Fresh units are analysed on their own with the same rule and never pooled with the 33 units after a K change.

## Arm KT
Arm KT (K plus the test-first Stop rule, `KRN_TEST_FIRST=1`) is exploratory, not confirmatory: it carries no hypothesis, no power claim and no part in the confirmatory contrasts above.
