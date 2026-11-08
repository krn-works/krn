# FR-40 results

Verdict: **GO (packets and retrieval)** under the frozen ADR 0014 D20 thresholds
(`manifest.json` analysis block), 2026-11-08. The claim covers the seven recorded
conventions only (fixed strata; generalisation to other conventions is out of claim).

Reproduce: `krn eval report --experiment evals/fr40 --root evals/fr40/results`
(prints `results/report.txt`; `--json` gives `results/report.json`). Every run's
`session.json` and `score.json` is under `results/fr40/runs/<runId>/`.

| arm | material | passes | rate |
| --- | --- | --- | --- |
| A | none | 93/133 | 69.9% |
| B | brain packet | 121/133 | 91.0% |
| S | static standards | 106/133 | 79.7% |

| comparison | wins | losses | difference | p (one-sided exact McNemar) | 90% Bonett-Price |
| --- | --- | --- | --- | --- | --- |
| B-A | 36 | 8 | +21.1 pp | < 0.0001 | [+13.0, +28.5] pp |
| B-S | 26 | 11 | +11.3 pp | 0.0100 | [+3.7, +18.6] pp |

Token ratio B/A 1.086 (threshold 1.25). GO packets needs B-A >= +15 pp, p < 0.05 and
the ratio; GO retrieval also needs B-S >= +10 pp. Both hold.

| stratum | A | B | S |
| --- | --- | --- | --- |
| commit-title-id | 0 | 19 | 2 |
| trailer | 18 | 19 | 17 |
| agent-state | 9 | 12 | 17 |
| tracker-untouched | 13 | 17 | 14 |
| core-imports | 19 | 18 | 19 |
| role-names | 15 | 19 | 18 |
| biome-clean | 19 | 17 | 19 |

## Reading

- The task-id commit title carries 19 of B's 36 wins over A: no arm without the
  packet follows it, and S, which holds the KRN-11 text, follows it twice. Without
  that stratum B-A is 17 wins to 8 losses.
- B loses to S on agent-state (12 vs 17): the packet does not always select the
  `.krn/` record for a "write your plan to a notes file" task. This is the first
  retrieval defect to fix before injection.
- core-imports and biome-clean are at ceiling in every arm; they do not separate arms.

## Conduct

- Harness: Codex 0.167.0, `gpt-6-luna`, mask on, AGENTS.md present at the task base in
  every arm; config sha256 `1611c2e5…` in all 399 sessions, every session `completed`
  with complete usage, 0 scorer errors.
- Runner: `evals/fr40/run.ts`. Runs interleave strata (scenario-major, template-minor)
  so the 20-unit STOP check sampled every convention; the arm order inside a task is
  the frozen plan's. At 20 units B-A was +25.0 pp (verdict CONTINUE), so the
  campaign ran all 133 units.
- Fixed before the campaign, on the first real sessions: Codex `workspace-write`
  made `.git` read-only (no commit possible), so sessions run `danger-full-access`
  inside the mask; npm and a copy of the dependencies are available in the slot;
  tracker-untouched setup files are committed in the slot and scored from that
  commit (`krn eval score --base`).
- Three sessions started under the previous config during the campaign
  (lead error); the runner moved them to `invalid/` (outside this record) and reran
  them under the frozen config.
- The planned mock-provider dry run was replaced by real sessions: the session
  config is fixed and has no provider override, and the real receiver is stronger
  evidence (KRN-12).
- `scripts/boundaries.ts` (imported by the core-imports scorer, not hashed by the
  manifest: t-16dkc64) had sha256 `a28802e1…8266867` while scoring.
