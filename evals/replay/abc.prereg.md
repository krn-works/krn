# A/B/C confirmatory run: preregistration

Frozen before any confirmatory row is run (ADR 0021 points 7 and 8). The unit list is the set `eligible()` in `evals/replay/screen.ts` returns over `evals/units` at the freeze commit K, the commit that merges this file; a unit is never reused after the run and there is no interim grading.

## Design

arms: A, B, C
reps: 3
n-units: 70
model: sonnet (fallback opus, as `evals/replay/arm-c.ts` sets it)
contrasts: C-A, C-B
alpha: 0.05
mde-pp: 16
power: 0.8
sessions: 840
aa-arm: A' (a second copy of A), 3 reps on the same units, outside the contrasts and their Holm family
cost-prices: input 2, output 10, cache-read 0.1, cache-write-5m 2.5, cache-write-1h 4
cost-sensitivity: input 2, output 10, cache-read 2, cache-write-5m 2, cache-write-1h 2

- Arms: A plain clone; B in-force records as a static CLAUDE.md, token-matched; C KRN (`evals/replay/arms.ts`).
- Primary: pass rate per unit (mean over its 3 reps), paired difference C minus control per unit, standard error clustered on the unit (`pairedDifference` in `evals/d23/analysis.ts`), normal approximation, two-sided.
- Multiplicity: Holm step-down over the two contrasts C-A and C-B. A contrast is "shown" only when its Holm-adjusted p is below alpha and C is the better arm; anything else is "not shown", which is a published result.
- MDE: 16 percentage points at power 0.8 with 70 units under the Holm first step (14.7 unadjusted; paired SD 0.44, recomputed in ADR 0021 point 10); a smaller effect, including the expected 0 to +5 pp, is outside what this run can detect.
- Arm C includes Remember: units of one repo run in commit-date order, graded failures of earlier units propose evidence-gated records served only to later units of that repo; at most 3 records per retrieval moment behind a precision gate; Stop runs executable checks only (ADR 0021 point 10).
- Reported beside pass rate: cost per resolved task and regression rate per arm.
- Co-primary cost: paired log ratio of per-unit geometric-mean session cost, C over control, with its clustered SE, and USD per resolved task per arm (total USD over passing rows divided by passes). C injects no more tokens than B.
- Cost is counted by token type (ADR 0021 point 12): each row's tokens are input, output, cache read, and 5-minute and 1-hour cache writes, summed over every model the session names. They are priced by the `cost-prices` vector (Claude Sonnet 5.5 list, USD per million tokens) whatever model the row realized. The cost verdict is repeated at `cost-sensitivity`, which prices every cached token at the input price; a verdict that differs between the two is reported as cache-dependent. The reported `total_cost_usd` is descriptive only. A re-prompted attempt takes its last session's report, because a resumed session reports from its start.
- Budget: about 630 sessions for A, B and C at about 0.60 USD each, about 375 USD notional, the operator grant of 2026-11-17 ("budżet S8 klepnięty, jedź pełny przebieg"), which supersedes the 115 USD figure of the ADR. The A' arm adds about 210 sessions, about 126 USD, under the grant of 2026-11-19; the operator confirms the 840-session total before the freeze.
- Report: `node evals/replay/run.ts --prereg evals/replay/abc.prereg.md --report [--rows <file>]`.

## Noise and integrity

Rules fixed before the freeze (ADR 0021 point 12):

- **Interleaving.** For each unit and rep, A, B, C and A' run back to back in an order drawn from a seeded shuffle of (unit, rep).
- **Three-state verdict.** Each contrast reads better (Holm-adjusted p below alpha, C better), worse (Holm-adjusted p below alpha, C worse) or not shown, with its 95% CI.
- **Intervals, not ranks.** Arms are never ordered by point estimate.
- **A/A arm.** A' is arm A's configuration under its own id.
  - A'−A reports the flip rate (share of unit-reps whose pass differs) and the paired difference with its CI, for pass rate and for cost.
  - A'−A is the run's noise floor and stays outside the Holm family.
  - If A'−A is shown at alpha, the run is flagged miscalibrated and every confirmatory contrast is reported as not shown.
- **Infra errors.**
  - An infra error is an API error status, an auth or network failure, a harness crash, or a stop at the account usage limit.
  - An attempt that ends in one is rerun once in the same window. A second infra error excludes that unit-rep from every arm, so pairing is kept.
  - The report prints exclusions per arm. Past 10% excluded unit-reps the run is inconclusive.
  - A session stopped at its own time or dollar cap is not an infra error; it is graded as it stands.
- **Grader integrity.**
  - Hidden tests enter only after the session ends.
  - A rep is graded from a clean checkout of the base commit plus its diff, outside the agent's write scope.
  - A diff that modifies or deletes an existing test file or CI configuration is unresolved. Adding new test files is allowed.
- **Strata.** Beside the unit-clustered pooled estimate, the report prints each contrast per repo with at least 2 units. A contrast whose sign differs in more than half of those repos is flagged heterogeneous.

## Units

- t-1182p41
- t-11kv38i
- t-14zbrpq
- t-1al6kuk
- t-1aqqnne
- t-1azubpv
- t-1bfdvot
- t-1bh70i6
- t-1br2xiq
- t-1c4dlg5
- t-1c70pao
- t-1d7k0sg
- t-1fxajbu
- t-1h5cuo1
- t-1hd8ehn
- t-1hecgls
- t-1jr2vwd
- t-1jtbgxz
- t-1jzziyy
- t-1k3tx49
- t-1kcngbt
- t-1ks1ygl
- t-1ltp11b
- t-1lw0yyc
- t-1mwsacc
- t-1mx3apz
- t-1p5tq1q
- t-1s9val1
- t-1xtk34n
- t-1ynhv0n
- t-1yoo5cd
- t-1zp9219
- t-20vrr8j
- t-22gi9wd
- t-2457wky
- t-25fu76l
- t-27y3bp0
- t-2b85tih
- t-2bajtah
- t-2c8n9wq
- t-2ec15be
- t-2en60kh
- t-2ey1r0y
- t-2f3cc85
- t-2hofih6
- t-2htshp4
- t-2jrj59l
- t-2k8ih26
- t-2mxlizg
- t-2qlzb3d
- t-2qss8ix
- t-2rhlx6n
- t-2rntorm
- t-3roilh7
- t-4wtymyn
- t-9pv6ifp
- t-dggms9o
- t-efbwahr
- t-f024qw4
- t-fd2ngpy
- t-fd481gz
- t-g6esr1v
- t-g74dknp
- t-h6a7wlt
- t-j5tygrp
- t-m07uv33
- t-mw51e88
- t-obh9z0b
- t-r70tm5c
- t-ubnq9ps
