# FR-40 on lanes: results

Verdict: **KEEP the carrier** under the preregistered rule (`preregistration-lanes.md`, D24 amendment),
2026-11-10. The claim covers the seven recorded conventions on `claude-sonnet-5-5` lanes only.

Reproduce: `node evals/fr40/lanes.ts report --root evals/fr40/results-lanes --units 133`
(prints `results-lanes/report-133.txt`; `--units 20` gives the early-stop stage in `report-20.txt`).
Every session's `session.json`, `score.json`, raw `claude.json` and `repo.patch` is under
`results-lanes/fr40/runs/<runId>/`; `results-lanes/spend.jsonl` is the per-session dollar ledger.

| arm | material | passes | rate |
| --- | --- | --- | --- |
| A | none | 100/133 | 75.2% |
| B | brain packet carrier | 130/133 | 97.7% |

| comparison | wins | losses | difference | p (one-sided exact McNemar) | 90% Bonett-Price |
| --- | --- | --- | --- | --- | --- |
| B-A (lanes) | 33 | 3 | +22.6 pp | < 0.0001 | [+15.4, +29.0] pp |
| B-A (original, Codex worker) | 36 | 8 | +21.1 pp | < 0.0001 | [+13.0, +28.5] pp |
| B-A without commit-title-id (lanes) | 33 | 3 | +26.3 pp | < 0.0001 | [+18.1, +33.7] pp |

Token ratio B/A 0.944 (input, output, cache creation and cache reads, all turns; threshold 1.25).
Rule: KEEP needs B-A >= +15 pp, p < 0.05 and ratio <= 1.25; all three hold.

| stratum | units | A | B |
| --- | --- | --- | --- |
| commit-title-id | 19 | 19 | 19 |
| trailer | 19 | 5 | 19 |
| agent-state | 19 | 1 | 19 |
| tracker-untouched | 19 | 18 | 19 |
| core-imports | 19 | 19 | 19 |
| role-names | 19 | 19 | 19 |
| biome-clean | 19 | 19 | 16 |

## Reading

- The gap is not about commit-title-id here: Claude arm A follows the task-id title 19/19 (the base
  commit's repository `CLAUDE.md` is loaded by the lane), where Codex arm A followed it 0/19. The wins
  come from trailer (+14) and agent-state (+18); B loses three biome-clean units.
- The lower bound of the interval (+15.4 pp) clears the +15 pp threshold only narrowly; the point
  estimate is the decision, as preregistered.

## Conduct

- Early-stop stage first: 20 units, B-A +20.0 pp (4 wins, 0 losses), so the run continued to 133.
- 266 sessions, 0 invalid, 0 caps, 0 scorer errors; config sha256 `3e687506...` and model
  `claude-sonnet-5-5` in every session; arm B carried a prefix in every session (133 distinct prefix
  sha256), arm A none.
- Spend $9.85 against the $140 ceiling (estimate $106; sessions were cheap, about $0.04).
- Harness: Claude Code `claude -p --output-format json`, tools Bash/Read/Edit/Write/Glob/Grep,
  `bypassPermissions`, `--setting-sources user` over an empty per-session `CLAUDE_CONFIG_DIR`
  (credentials symlinked), `CLAUDE_CODE_SESSION_ATTENDED=0`, git global config disabled, each session
  in a throwaway scratch clone under `/mnt/storage/tmp`. Runner: `evals/fr40/lanes.ts`, six sessions
  in parallel, interleaved by stratum as in the original run.
