# R1 measured baseline

Evidence below is from `.krn/runs/r1/R1-00/` unless stated otherwise. File SHA-256 values and capture timestamps are listed at the end. Measurements are bounded to the recorded captures (2026-10-10).

## Toolchain

[OURS-EVIDENCE] `baseline-readback.txt` recorded Node v24.21.0, pnpm 12.10.1, Codex CLI 0.160.0, bubblewrap 0.12.0, Paperclip 2026.1001.0, and GitHub CLI 2.101.0. The supplied user bus check returned `ok`. Captured live `main` SHA: `22f4100a76886cd93e78c4ab0de9b359f4391032`.

## Clean-main gate

[OURS-EVIDENCE] Host gate on clean `main` SHA `22f4100a76886cd93e78c4ab0de9b359f4391032`: exit 0, 161.32 seconds, 126 tests passed, 0 failed, 0 skipped, and `Isolation-dependent tests skipped: 0`. Source: `current-main-host-gate.json`, `gate-summary.txt`; the JSON points to the gate log under `.krn/runs/r1/LON-214/`.

## Branch protection

[OURS-EVIDENCE] Both rulesets and classic branch protection readbacks returned HTTP 403 with the message that the plan does not enable this feature for this private repository. Therefore protection configuration was not observable in this capture; 403 does not establish that protection is absent.

[POLICY — recommendation, not a measured fact] D-R1-1 recommendation: configure a ruleset requiring `gate` and disallow force-pushes.

## Live candidates for R1-12

[OURS-EVIDENCE] `live-candidates.json` records four issues with one `krn-contract` block and matching local clone origin(s):

| Issue | Target repo | Recorded checks |
|---|---|---|
| LON-205 | `krn-works/krn` | `gate` |
| LON-206 | `krn-works/krn` | `gate` |
| LON-209 | `krn-works/krn` | `typecheck`, `lint`, `rules` |
| LON-202 | `krn-works/krn-codex-skills` | `lessons-tests`, `instruction-ownership`, `validate-remaining`, `skills-check` |

[CODE] The current `krn.checks.json` registers only `typecheck`, `lint`, and `rules`; thus `gate` is not resolvable through the registered verdict checks. Its SHA-256 and timestamp are included in the evidence index.

## Codex features relevant to R1-04

[OURS-EVIDENCE] Captured `codex features list` includes `apps`, `browser_use`, `code_mode_host`, and `computer_use` as stable and true. Captured help includes an `agents` command for browsing sessions, an `apply` command, and agent model/working-directory options. The capture does not establish `/goal`, subagent creation, or `shell_environment_policy`; see “Not measured.”

## Backend qualification

[OURS-EVIDENCE] Command: the qualified wrapper `confine.sh <workspace> <run-dir> -- <Codex 0.160.0 binary> exec -m gpt-6-luna`, with the real-agent turn run using stdin from `/dev/null`. Direct and real-agent observers returned exit 0. Dedicated workspace: `.krn/worktrees/r1-confine-qual` at `22f4100` (the recorded main SHA prefix).

| Boundary | Observed result |
|---|---|
| Task workspace writes | Allowed (`insideWrite: true`) |
| Main checkout, other worktree, outside sentinel writes | Denied |
| Credential/config paths listed by observer | Hidden |
| Environment secrets | Direct observer: none; agent turn: `GH_PAGER` present |
| Temporary directory | Private |
| Model API network | Open (known limit) |
| Host CLI `auth.json` | Readable (accepted model credential; known limit) |

[OURS-EVIDENCE] Agent-turn `GH_PAGER` was identified in the capsule as a pager variable injected by Codex shell, not a credential. The first attempt hung on stdin; outer timeout exited 143, while `RuntimeMaxSec=540` did not fire before the outer timeout of 600 seconds. Qualification sources: `qual-direct.out`, `qual-agent-summary.txt`, `qual-hashes.txt`, and `qualification-capsule-excerpt.md`.

## Not measured

- Actual ruleset/classic protection settings, due to both API calls returning HTTP 403.
- Whether `/goal`, subagent creation, or `shell_environment_policy` is available; captured help/features do not establish these.
- Whether `RuntimeMaxSec` fires without the outer timeout; this attempt ended at the outer timeout first.
- Any backend network restriction beyond the recorded open model API access.

## Evidence index

All timestamps are filesystem modification times (`+02:00`), 2026-10-10. SHA values are SHA-256.

| Source | SHA-256 | Timestamp |
|---|---|---|
| `baseline-readback.txt` | `6d82ba7292fb68b6e0aaa597f63330e5100cdf3df4c0b7ed1eea2369be8b655d` | 15:25:02.209 |
| `gate-summary.txt` | `07da5fee00845a6d11b5f7c4ac02b2b0702a42fe8dd48ef9d2964d566efd1620` | 15:25:02.216 |
| `current-main-host-gate.json` | `92fe5e621d22e8b9371e08589814305200d089a6f0b6eb5057fe9765fa313640` | 15:25:02.209 |
| `protection-readback.json` | `8ff0665062de415a7885f1085674020cbea8419594beb8ef868b2a92ea8844cd` | 15:25:02.209 |
| `live-candidates.json` | `18d1d22ca4204d43933e53fd95d8cd18d95f88ce936756648c8d24a9025f7e82` | 15:25:02.209 |
| `qual-direct.out` | `f8913e2b6bec036353b52f2b21f03a59b1acdfe0f9db3c904bd0a229df99e10a` | 15:25:02.209 |
| `qual-agent-summary.txt` | `e9ff3fa441c9163f1b5a0751c063f5039ccb85c33489d3b6df8987829a448dc1` | 15:25:02.268 |
| `qual-hashes.txt` | `91786c1c06ace79cb5fb8f8cc94962c3fc011cc43d19d8284d379d7aa6aafb5f` | 15:25:02.209 |
| `qualification-capsule-excerpt.md` | `d451a951b2f2d69be5fcaf31071f1e5cf763372f996eef27aa6ca5237b05cb01` | 15:25:02.279 |
| `krn.checks.json` (worktree) | `adde656c219fe7e73caac624bdd1178b62585c86982bcb2ae0bbc4863641b603` | 15:25:02.190 |
