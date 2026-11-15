# D23 regrade with `git apply --index`

Saved patches only; no model session ran. Population: the 20 dev units of `.krn/runs/d23-comparison/units.txt`, arms K and P (40 arms), 12 of them paired (valid on the merge, both arms produced a patch). The v2 repeated-run comparison (K 41/57 vs PB 35/56) was not regraded here: its grades do not exist under `--index`.

Corrected summary (reproduce: `node evals/d23/regrade.ts --runs <d23-comparison> --out <index regrade dir>`):

    K functional 2/20, P functional 3/20, K scope-clean 10/20, P scope-clean 14/20; paired K 2/12, P 3/12; McNemar p=1.000
    corrected paired K - P: K 2/12, P 3/12, difference -8.3 pp, 95% CI [-24.7 pp, +8.0 pp], McNemar p=1.000

Plain versus `--index` per arm (functional/applied):

| pr | arm | plain functional/applied | --index functional/applied | differs |
|---|---|---|---|---|
| 473 | K | true/true | true/true | false |
| 473 | P | true/true | true/true | false |
| 476 | K | false/true | false/true | false |
| 476 | P | false/true | false/false | true |
| 478 | K | false/true | false/false | true |
| 478 | P | false/true | false/true | false |
| 480 | K | false/true | false/true | false |
| 480 | P | false/true | false/true | false |
| 485 | K | false/true | false/true | false |
| 485 | P | false/true | false/true | false |
| 487 | K | false/true | false/true | false |
| 487 | P | false/true | false/true | false |
| 488 | K | false/true | false/true | false |
| 488 | P | false/true | false/true | false |
| 493 | K | false/true | false/true | false |
| 493 | P | false/true | false/true | false |
| 494 | K | false/true | false/true | false |
| 494 | P | false/true | false/true | false |
| 498 | K | false/true | false/true | false |
| 498 | P | false/true | false/true | false |
| 499 | K | false/true | false/true | false |
| 499 | P | false/true | false/false | true |
| 509 | K | false/true | false/true | false |
| 509 | P | false/true | false/true | false |
| 512 | K | true/true | true/true | false |
| 512 | P | true/true | true/true | false |
| 514 | K | false/true | false/true | false |
| 514 | P | false/true | false/true | false |
| 519 | K | false/true | false/true | false |
| 519 | P | false/true | false/true | false |
| 521 | K | false/true | false/true | false |
| 521 | P | false/true | false/false | true |
| 524 | K | false/true | false/true | false |
| 524 | P | true/true | true/true | false |
| 530 | K | false/true | false/false | true |
| 530 | P | false/true | false/false | true |
| 534 | K | false/true | false/true | false |
| 534 | P | false/true | false/true | false |
| 537 | K | false/true | false/true | false |
| 537 | P | false/true | false/false | true |

arms compared: 40; differing: 7

Reading: functional verdicts differ in 0 arms; `--index` makes 7 patches stop applying (476 P, 478 K, 499 P, 521 P, 530 K, 530 P, 537 P), so it loses units. `grade.ts` keeps plain `git apply`.
