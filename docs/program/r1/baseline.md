> **Historical measurement snapshot (2026-10-10).** Current status and later evidence are in [audit](../audit-2026-10-20.md) and [roadmap](../roadmap-2026-10-20.md).

# R1 measured baseline

Evidence below is from the tracked copies in `docs/program/r1/evidence/R1-00/` unless stated otherwise. File SHA-256 values and capture timestamps are listed at the end. Measurements are bounded to the recorded captures (2026-10-10).

## Toolchain

[OURS-EVIDENCE] `docs/program/r1/evidence/R1-00/baseline-readback.txt` recorded Node v24.21.0, pnpm 12.10.1, Codex CLI 0.160.0, bubblewrap 0.12.0, Paperclip 2026.1001.0, and GitHub CLI 2.101.0. The supplied user bus check returned `ok`. Captured live `main` SHA: `22f4100a76886cd93e78c4ab0de9b359f4391032`.

## Clean-main gate

[OURS-EVIDENCE] Host gate on clean `main` SHA `22f4100a76886cd93e78c4ab0de9b359f4391032`: exit 0, 161.32 seconds, 126 tests passed, 0 failed, 0 skipped, and `Isolation-dependent tests skipped: 0`. Sources: `docs/program/r1/evidence/R1-00/current-main-host-gate.json`, `docs/program/r1/evidence/R1-00/gate-summary.txt`, and the bounded transcript excerpt `docs/program/r1/evidence/R1-00/gate-transcript-excerpt.txt`. On the same clean SHA `22f4100`, rules exited 0; the recorded gate exit 0 also covers rules because its script runs the recorded `&&` chain. Source: `docs/program/r1/evidence/R1-00/rules-check-22f4100.txt`. The JSON references the full log at `/mnt/storage/coding/krn/active/krn/.krn/runs/r1/LON-214/current-main-host-gate.log`, which remains in ignored run state; the summary and excerpt are tracked.

## Branch protection

[OURS-EVIDENCE] Both rulesets and classic branch protection readbacks returned HTTP 403 with “Upgrade to GitHub Pro or make this repository public to enable this feature.” Branch protection is unavailable on the current plan for this private repository. Merge-gate enforcement currently relies on the lead's pipeline, not GitHub. Source: `docs/program/r1/evidence/R1-00/protection-readback.json`.

## Live candidates for R1-12

[OURS-EVIDENCE] `docs/program/r1/evidence/R1-00/live-candidates.json` records four issues with one `krn-contract` block and matching local clone origin(s):

| Issue | Target repo | Recorded checks |
|---|---|---|
| LON-205 | `krn-works/krn` | `gate` |
| LON-206 | `krn-works/krn` | `gate` |
| LON-209 | `krn-works/krn` | `typecheck`, `lint`, `rules` |
| LON-202 | `krn-works/krn-codex-skills` | `lessons-tests`, `instruction-ownership`, `validate-remaining`, `skills-check` |

[CODE] The current `krn.checks.json` registers only `typecheck`, `lint`, and `rules`; thus `gate` is not resolvable through the registered verdict checks. Its SHA-256 and timestamp are included in the evidence index.

## Codex features relevant to R1-04

[OURS-EVIDENCE] Captured `codex features list` includes `apps`, `browser_use`, `code_mode_host`, and `computer_use` as stable and true. Captured help includes an `agents` command for browsing sessions, an `apply` command, and agent model/working-directory options. The capture does not establish `/goal`, subagent creation, or `shell_environment_policy`; see “Not measured.” Source: `docs/program/r1/evidence/R1-00/baseline-readback.txt`.

## Backend qualification

[OURS-EVIDENCE] The qualified wrapper is lead tooling for supervised use, within the measured boundaries below. Direct and real-agent observers returned exit 0. This qualification does not cover krn's own CodexHost/flow panel path in `src/hosts/codex.ts`; productization is tracked in R1-04/R1-10. Dedicated workspace: `.krn/worktrees/r1-confine-qual` at `22f4100` (the recorded main SHA prefix). The tracked `confine.sh`, `observer.py`, and `qualify.sh` are captured source copies for review; they are not runnable from `docs/program/r1/evidence/R1-00/` because their path checks bind to `.krn/` locations by design. Qualification used their ignored run-state copies.

| Boundary | Observed result |
|---|---|
| Task workspace writes | Allowed (`insideWrite: true`) |
| Main checkout, other worktree, outside sentinel writes | Denied |
| Credential/config paths listed by observer | Hidden |
| Environment secrets | Direct observer: none; agent turn: `GH_PAGER` present |
| Temporary directory | Private |
| Model API network | Open (known limit) |
| Host CLI `auth.json` | Readable (accepted model credential; known limit) |

[OURS-EVIDENCE] The Codex 0.160.0 binary contains the literal `GH_PAGER`, while the host environment has no `GH_PAGER`; the observed agent-turn value is therefore identified as a variable injected by the Codex binary into its shell, not a credential. The v1 runtime-probe process count was invalid because its match included the lead's own shell. The v2 probe uses a unique argv0 marker and observed one process during the run; `RuntimeMaxSec=20` terminated it after 21 seconds with exit 143, and zero matching processes remained afterwards. The earlier `RuntimeMaxSec=540` attempt did not fire before its outer 600-second timeout; the v2 probe supplies the runtime-limit evidence. Sources: `docs/program/r1/evidence/R1-00/runtime-and-env-probe.txt`, `docs/program/r1/evidence/R1-00/qual-direct.out`, `docs/program/r1/evidence/R1-00/qual-agent-summary.txt`, `docs/program/r1/evidence/R1-00/qual-hashes.txt`, `docs/program/r1/evidence/R1-00/qualification-capsule-excerpt.md`, `docs/program/r1/evidence/R1-00/confine.sh`, `docs/program/r1/evidence/R1-00/observer.py`, `docs/program/r1/evidence/R1-00/qualify.sh`, and `docs/program/r1/evidence/R1-00/confine-README.md`.

## Board mapping

[OURS-EVIDENCE] Paperclip issue `LON-214` maps to `R1-00` by the `R1-task: R1-00` description line, per charter decision 6; an issue assignee is not required. The mapping readback records status `todo`. Sources: `docs/program/r1/evidence/R1-00/paperclip-LON-214-mapping-readback.json` and `docs/program/r1/evidence/R1-00/paperclip-LON-214-readback.json`.

## Not measured

- Protection configuration cannot be enabled for this private repository on the current plan; merge-gate enforcement currently relies on the lead's pipeline.
- Whether `/goal`, subagent creation, or `shell_environment_policy` is available; captured help/features do not establish these.
- Any backend network restriction beyond the recorded open model API access.

## Delivery and acceptance

Per `docs/program/r1/tasks/R1-00.md` Validation, delivery through this LON-214 PR, its merge and the board readback happen after merge and are recorded in Paperclip and the lifecycle capsule; this report cannot contain evidence of its own merge.

## Evidence index

All timestamps are filesystem modification times (`+02:00`), 2026-10-10. SHA values are SHA-256. JSON evidence is Biome-formatted; parsed content equals the capture (deep-equal verified); other files are byte-identical.

| Source | SHA-256 | Timestamp |
|---|---|---|
| `docs/program/r1/evidence/R1-00/baseline-readback.txt` | `6d82ba7292fb68b6e0aaa597f63330e5100cdf3df4c0b7ed1eea2369be8b655d` | 15:25:02.209 |
| `docs/program/r1/evidence/R1-00/confine-README.md` | `c59ffcc0b15edf08832b0927d0c204196b8d2088121dad4b2e3cac4ee4ce0949` | 15:32:25.325 |
| `docs/program/r1/evidence/R1-00/confine.sh` | `1703a734478a6d5390fe99a3dad2dc723d3f98b602df948d1f9eef298f149cd7` | 15:32:25.325 |
| `docs/program/r1/evidence/R1-00/current-main-host-gate.json` | `92fe5e621d22e8b9371e08589814305200d089a6f0b6eb5057fe9765fa313640` | 15:25:02.209 |
| `docs/program/r1/evidence/R1-00/gate-summary.txt` | `07da5fee00845a6d11b5f7c4ac02b2b0702a42fe8dd48ef9d2964d566efd1620` | 15:25:02.216 |
| `docs/program/r1/evidence/R1-00/gate-transcript-excerpt.txt` | `bd9a3abf42b3d93a6a992c319a2c021130aa7fa08a77d3457e9653a37637f3b0` | 16:22:07.302 |
| `docs/program/r1/evidence/R1-00/live-candidates.json` | `468467c119c55537948660745f25bcc024f4af5d51411f3f179b88aa9ae03196` | 15:35:05.205 |
| `docs/program/r1/evidence/R1-00/observer.py` | `c1e58c1d615378845fa565d52f06860f7066c6b49a3dedf2f39095d91ee5538e` | 15:32:25.325 |
| `docs/program/r1/evidence/R1-00/paperclip-LON-214-mapping-readback.json` | `416a6483a19fd6bd98a80a20ccbbd767f62843fdd78689961839430dc2e08805` | 16:15:50.031 |
| `docs/program/r1/evidence/R1-00/paperclip-LON-214-readback.json` | `6e8e4a89bc9f393fbb02b272139568e3d34b8489507dd90824a0b8f5530877a6` | 15:35:05.205 |
| `docs/program/r1/evidence/R1-00/protection-readback.json` | `8ff0665062de415a7885f1085674020cbea8419594beb8ef868b2a92ea8844cd` | 15:25:02.209 |
| `docs/program/r1/evidence/R1-00/qual-agent-summary.txt` | `e9ff3fa441c9163f1b5a0751c063f5039ccb85c33489d3b6df8987829a448dc1` | 15:25:02.268 |
| `docs/program/r1/evidence/R1-00/qual-direct.out` | `f8913e2b6bec036353b52f2b21f03a59b1acdfe0f9db3c904bd0a229df99e10a` | 15:25:02.209 |
| `docs/program/r1/evidence/R1-00/qual-hashes.txt` | `91786c1c06ace79cb5fb8f8cc94962c3fc011cc43d19d8284d379d7aa6aafb5f` | 15:25:02.209 |
| `docs/program/r1/evidence/R1-00/qualification-capsule-excerpt.md` | `d451a951b2f2d69be5fcaf31071f1e5cf763372f996eef27aa6ca5237b05cb01` | 15:25:02.279 |
| `docs/program/r1/evidence/R1-00/qualify.sh` | `d1ecbbbb921069d66e7dfb7c845751a1d56e8257ee4f5cd0b90e57a7c879ec72` | 15:32:25.325 |
| `docs/program/r1/evidence/R1-00/rules-check-22f4100.txt` | `babd5d02bb842c49d66a60aadeeec4cd3fd7a0a85c0d044c7c13f7cb29f835cd` | 16:26:43.967 |
| `docs/program/r1/evidence/R1-00/runtime-and-env-probe.txt` | `1783f089190eb47658781e817af7b37d6f50e77202b3affd264df11309033c0c` | 16:12:30.458 |
