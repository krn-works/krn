# Standards enforcement map

Which repository rules a mechanical check enforces, and which rest on judgment. A rule that can be checked by a command gets that check; a rule listed under judgment is reviewed by the lead and the retro, never assumed enforced. Every `s-ci-*` record in `.agents/standards.json` names a check that exists and runs in CI.

## Gaps with a check under way

| Rule (source) | Gap | Task |
| --- | --- | --- |
| PR body sections and trailer (`src/ci/ship.ts`) | ship and CI accept a body without `## Why`, `## Verified`, `Ticket:`/`Refs:` | t-k7xx0kq |
| r-trailer, r-commit-title-id, r-conventional-commits | only the PR title is checked; branch commits are not | t-hfz0brs |
| r-biome-clean; lanes.md no `--no-verify`/`HUSKY=0`/`core.hooksPath`; lead-rules force push | no git hook, no Bash guard for skipped hooks or force push without lease | t-h5ssdnk |
| r-piped-checks | the guard covers only `pkill`/`pgrep -f` | t-kj7an2b |
| r-agent-state, r-state-paths; lanes.md `/tmp` scratch and `plan.md` | only lane sessions are blocked from the main checkout | t-d4h4pcs |
| KRN-14 r-regression-layer; r-role-names on identifiers | a fix PR needs no test; the token guard reads paths only | t-qhgdby6 |
| terminal closeout; KRN-07 exact-HEAD Check; squash-only | ruleset and pruning live outside the diff | t-qfr38g1 |
| KRN-12 r-receiver-tests | a capture is not proven verbatim; `pending:` never expires | t-dymfm46 |
| KRN-13 above the handoff threshold | the gauge only advises | t-4kr78d9 |
| lead role at run time | session-role test reads text only | t-pmhbw1d |
| KRN-11 r-tracker-owner, r-one-writer | tracker writes outside Scope are reported, not refused | t-dgrn7rf, t-2w5b94c |

## Judgment only

These rules have no sound mechanical check; the lead applies them and `delivery-retro` turns a breach into a check when one becomes possible: r-verify-premise-before-cause, r-deep-modules, r-bounded-context (beyond the threshold refusal), lead-rules on unattended decisions, external messages, cleanup by absolute path, classifier denials, acceptance from a command, red only in CI and validator briefs; repository-workflow on explicit writer transfer, backups deleted in the same step, technique-pinning lint and flaky retries; lanes.md turn ceiling, ten-line final reply and no reliance on `set -e`.
