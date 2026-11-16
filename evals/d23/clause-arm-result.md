# Clause arm result: P against P plus clauses from the brief

Preregistration: `evals/d23/clause-arm-preregistration.md` (sha256 40c183c8cb172821c70c840fec15ed184f93e621710d323de4c6dbf11f2b6550 at commit 4d04534, before any PC session). Observations: `evals/d23/clause-arm-observations.json`. Reproduce: `node evals/d23/analysis.ts --arms P,PC`.

| arm | units | mean correct | runs | scope-clean | refusals | $/correct |
|--|--|--|--|--|--|--|
| P | 56 | 8.0% | 111 | 71/111 | 3/111 | 10.01 |
| PC | 56 | 8.9% | 112 | 81/112 | 4/112 | 10.55 |

PC - P: +0.9 pp over 56 units, SE 2.4 pp, 95% CI [-3.8, +5.6], p = 0.708.

Reading under the preregistered rule: the 90% CI lies inside (-10, +10) pp, so clauses from the brief alone are equivalent to no clauses within 10 pp on hidden-test correctness. The prediction (PC - P under +10 pp) holds; the falsifier (at or above +20 pp) did not occur. Clauses from the brief are not a correctness lever on these units.

Restated D23 line: "PB 62.5% vs P 10.7%" is an oracle upper bound (requirements derived from the hidden tests); the brief-only clause arm adds +0.9 pp (CI [-3.8, +5.6]) over P.

Run facts: Claude Code sessions, model claude-opus-5-5, effort medium, budget 6 USD, timeout 1500 s; P run 1 is the D23 v2 run1 sessions regraded with the same grader as the new runs (P run 2, PC runs 1 and 2). One P run has no finished result and is excluded. `own_exit` in the run records is not part of the metric: a bug in `replay.sh` (the arm kind was overwritten before the harness-file restore) skipped that restore for every arm and was fixed mid-run; correctness is graded by `evals/d23/runs.ts` from the saved patch and file list only.
