# FR-40 on lanes: preregistration

Frozen before any session of this run exists. Task `t-5983e6g` (slice D0) is the current task; the approved protocol is this file; the D24 amendment in ADR 0014 lifts "FR-40 runs Codex only" for this one run (operator order of 2026-11-10, "Architecture program order", point 3). ADR 0002 requires "a current task, an approved protocol, and a preregistration before results are observed"; this file is the preregistration and is merged before the first session starts. Owner: the lead. Delete or supersede it when D0's verdict is recorded (ADR 0002 status).

## Question

FR-40's only positive result (B-A +21.1 pp, 90% Bonett-Price [+13.0, +28.5], B-S +11.3 pp, token ratio 1.086; `results.md`) was measured through `krn worker start` and `krn eval` on Codex `gpt-6-luna`, which D2 deletes. Does the same packet, prepended to a lane brief on the lead's dispatch path, still raise first-try convention compliance on Claude lanes? Yes: keep the carrier. No: epitaph.

## Carrier

The arm-B packet text of the frozen `material.json` for each unit (the bytes FR-40 measured, from `records.json` dated before the unit's base), prepended to the unit's prompt exactly as `packetBrief` in `src/brain/worker-packet.ts` does: `Repository conventions (brain packet <sha12>):\n<packet text>\n\n<brief>`. The lead's dispatch path (slice D0's code) must produce that prefix byte-identically for the frozen packet; a test comparing its output with the frozen text passes before the first session, and each session records the prefix sha256. Arm A receives the brief alone. Nothing else differs between arms: same base commit, same scratch repository and mask, same repository `AGENTS.md` present at the base, same scorers.

## Design

- Lanes: Claude Code, model `claude-sonnet-5-5`, one non-interactive session per unit and arm (`claude -p`), the same tools, permission mode and settings in every session; the config sha256 is recorded and must be identical across sessions.
- Units: the 133 convention tasks of the frozen `manifest.json` (seven conventions as fixed strata crossed with 19 small coding jobs), scored by the frozen `scorers.ts` over the scratch repository. Manifest, tasks, material and scorers hashes are checked against `manifest.json` before the run; a mismatch invalidates the run.
- Arms: A (no packet) and B (packet carrier). N = 133 paired units, 266 sessions, one replica. Arm S (static standards) is not run: D0 asks whether the carrier works, which is B-A; the B-S question belongs to retrieval and stays at its Codex result. The arm order inside a unit is randomised by the manifest seed `fr40-2026-11-08`; units run interleaved by stratum (scenario-major, template-minor) as in the original run.
- Session cap: 25 minutes and the harness default turn limit; a session that hits a cap counts as a fail for its arm and is reported, not rerun.

## Measures

- Primary: B-A pass-rate gap in pp over the 133 units, with wins (B pass, A fail), losses, exact one-sided McNemar p on the discordant units, and the 90% Bonett-Price interval (`krn eval report`). Compared with the original +21.1 pp and its interval.
- Secondary, reported, not decisive: per-stratum table; B-A without the `commit-title-id` stratum (it carried 19 of the 36 original wins, so a gap that survives only there is a gap about one convention); token ratio B/A (input plus output, all turns); dollars spent.

## Decision rule (fixed now)

The original D20 thresholds, applied unchanged to lanes. Justification: at the original 44 discordant units the standard error of the paired gap is about sqrt(44)/133 = 5 pp, so N = 133 resolves a gap of 15 pp (3 standard errors) and the 90% half-width is about 8 pp; a lower threshold would be inside the noise of one run and a higher one would demand more than the original result, measured on a different model, can be expected to repeat.

- KEEP the carrier (D0 closes on the code) if B-A >= +15 pp, one-sided exact McNemar p < 0.05 and token ratio B/A <= 1.25.
- EPITAPH otherwise: ADR 0002's status records that the packet's result was measured under the worker on Codex, was not reproduced through the lead's carrier on Claude lanes (with the measured B-A and interval), and has no consumer; the carrier code is not shipped. This holds for a gap between 0 and +15 pp as well as for no gap: there is no second run (D24 amendment: once).
- Early stop: after the first 20 units (interleaved, so every stratum is sampled) stop if B-A <= 0 pp and write the epitaph from the 20 units, as the original run's stop rule. Otherwise run all 133.
- No exclusions, no threshold or scorer change, and no change of model after the first session.

## Cost ceiling

Sonnet 5.5 is priced at $2 input, $10 output and $0.20 cache read per million tokens (`src/outcome/slice-cost.ts`). A small coding job in a scratch repository is estimated at about $0.40 a session (about 25 turns, mostly cache reads, about 12k output tokens). The run is 266 sessions, estimated at about $106; the early-stop path is 40 sessions, about $16. Ceiling: $140, counted per session from recorded usage. Reaching the ceiling before all units finish is a failed run (below), not a verdict.

## A failed run

A failed run produces no KEEP and no EPITAPH, and it is not rerun without a new operator decision. The run fails if any of:

- more than 5% of sessions (14 of 266) are invalid: not completed, no usage record, a scorer error, or a lead error such as the wrong config; invalid sessions are rerun once under the frozen config inside the ceiling, and counted against the 5% if they stay invalid;
- the config sha256, manifest hashes, model or carrier prefix drift between sessions;
- arm leakage: arm A shows packet text, or arm B lacks the prefix;
- spend exceeds the $140 ceiling before the verdict is computable;
- the lane model is changed or unavailable mid-run.

Results go under `evals/fr40/results-lanes/`; the verdict is written into this file's sibling `results-lanes.md` with the numbers above, then D0 closes either way.
