# A/B/C confirmatory run: preregistration

Frozen before any confirmatory row is run (ADR 0021 points 7 and 8). The unit list is the set `eligible()` in `evals/replay/screen.ts` returns over `evals/units` at the freeze commit K, the commit that merges this file; a unit is never reused after the run and there is no interim grading.

## Design

arms: A, B, C
reps: 3
n-units: 70
model: sonnet (fallback opus, as `evals/replay/arm-c.ts` sets it)
contrasts: C-A, C-B
alpha: 0.05
mde-pp: 15
power: 0.8
sessions: 630

- Arms: A plain clone; B in-force records as a static CLAUDE.md, token-matched; C KRN (`evals/replay/arms.ts`).
- Primary: pass rate per unit (mean over its 3 reps), paired difference C minus control per unit, standard error clustered on the unit (`pairedDifference` in `evals/d23/analysis.ts`), normal approximation, two-sided.
- Multiplicity: Holm step-down over the two contrasts C-A and C-B. A contrast is "shown" only when its Holm-adjusted p is below alpha and C is the better arm; anything else is "not shown", which is a published result.
- MDE: 15 percentage points at power 0.8 with 70 units; a smaller effect is outside what this run can detect.
- Co-primary cost: paired log ratio of per-unit geometric-mean session cost, C over control, with its clustered SE, and USD per resolved task per arm (total USD over passing rows divided by passes). C injects no more tokens than B.
- Budget: about 630 sessions at about 0.60 USD each, about 375 USD notional, the operator grant of 2026-11-17 ("budżet S8 klepnięty, jedź pełny przebieg"), which supersedes the 115 USD figure of the ADR.
- Report: `node evals/replay/run.ts --prereg evals/replay/abc.prereg.md --report [--rows <file>]`.

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
