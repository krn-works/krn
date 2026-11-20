# 27. Ship reads one GitHub PR state model

Date: 2026-11-19

## Status

Proposed. The first step (the pure classifier `src/ci/github-state.ts` and its fixtures) is in; ship, verify, the open-red limit and the lane receiver are not rewired yet. Tracked by t-91n0383 (typed ship verdict) and t-hf1z9se (checks by name, App id and every required context); the ADR 0022 amendment that t-91n0383 requires adopts or supersedes this model.

## Context

`src/ci/ship.ts` took 45 fix commits from 2026-11-05 to 11-19, 40 distinct by task (`node scripts/fix-churn.mjs --report`: `hot file 40 src/ci/ship.ts`; `src/adopt/verify.ts` 9, the deleted `src/ci/wait.ts` 6). They fall in three classes:

- **GitHub state met for the first time (20):** #1517, #1514, #1455, #1407, #1376, #1360, #1354, #1295, #1271, #1236, #1188, #1171, #1160, #1053, #900, #812, #737, #691, #688, #666.
- **gh transport (5):** #1182, #1189, #1197, #807, #586.
- **Local pre-push and lane steps (20):** #1448, #1438, #1429, #1422, #1351, #1330, #1286, #1256, #1220, #1199, #1137, #1013, #814, #798, #772, #738, #704, #694, #681, #611.

Root cause of the first two classes: ship has no model of the PR, check and merge states. Each caller reads raw gh output (`gh pr view` rollup, check-runs rows, `gh run list`, merge stderr) and adds one branch per surprise, and four readers (ship, the open-red limit, the lane receiver, task close evidence) each keep their own selection and their own meaning of red. The third class is a different defect (ship is also the pre-push pipeline) and is out of scope here.

### gh calls of ship (main at 1cfd0601)

| Call | Where | Idempotent | Retry today |
|---|---|---|---|
| `repo view --json nameWithOwner` | ship.ts:241 | read | wrapper: 3 tries before the push |
| `api repos/R/branches/B`, `api repos/R/rules/branches/B` | ship.ts:254-258 | read | 3 tries; any failure silently judges `Check` (ship.ts:260) |
| `pr list --head BR --state merged --json number,headRefOid,mergeCommit` | ship.ts:355-368 | read | 3 tries |
| `pr view N --json state,headRefOid,mergeable,autoMergeRequest,mergeCommit,statusCheckRollup` | ship.ts:324-333 | read | 3 tries before, 300 s after the push; `.catch(() => undefined)` on the merged paths |
| `pr list --head BR --state merged --json <taskMergeFields>`, `pr list --base B --state merged --search` | ship.ts:401-449 | read | 3 tries |
| `pr list --head BR --state open --json number` | ship.ts:649-665 | read | 300 s |
| `pr create` | ship.ts:673-686 | **no** | wrapper never retries; caller looks for the PR before each new create, 30 s steps to 300 s (ship.ts:687-699) |
| `pr edit N --title --body-file` | ship.ts:705-715 | yes | 300 s |
| `pr merge N --squash --match-head-commit H` | ship.ts:776-785 | pinned by head | 300 s on unanswered; stderr `head branch was modified` exits 77, `Merge already in progress` waits, anything else is rethrown with no ship exit code (ship.ts:803) |
| `run list --commit H --json status` | ship.ts:809-824 | read | 300 s; asked only after the 300 s start bound |
| `api repos/R/commits/H/check-runs?filter=all&per_page=100 --jq CHECK_FACT_FILTER` | ship.ts:825-833 | read | 300 s; one page only |

The retry policy is one wrapper (ship.ts:201-222) whose budget flips on a mutable `afterPush` flag (ship.ts:200, 648), a second loop for `pr create`, and `answeredFailure` (ship.ts:62-63), which treats any HTTP status, 5xx included, as final.

## Decision

One module owns the PR state: `classify(answers, expected) -> PrState` in `src/ci/github-state.ts`, pure over what gh printed. The answers are the text of `gh pr view --json state,headRefOid,mergeable,mergeCommit`, of the head's check-runs (`CHECK_FACT_FILTER`) and, when read, of `gh run list --json status`; parsing them is inside the one call, so a malformed or null answer (#1188, #807) is the module's concern, not each caller's. `expected` is what the caller pushed: the head, the head a branch update replaced, the required context and whether a merge was requested. The state is one of a closed set (`PR_STATES`), and every state has a fixture under `test/fixtures/github-state/` that is a verbatim capture under `test/fixtures/gh/` with its varied fields and rows declared; the test fails when a fixture differs from its capture anywhere else.

### State table

| State | Detected from | Ship today | Exit | Added by |
|---|---|---|---|---|
| `merged` | view MERGED at the expected head | ship.ts:902-910 | 0 | #1128, #666 |
| `head-moved` (merged) | view MERGED at another head | ship.ts:904-908 | 77 | #1360 |
| `closed` | view CLOSED | ship.ts:912-917 | 79 | #415, #1128 |
| `updating` | view still at the head ship's rebase push replaced | ship.ts:918-926 | wait; 69 at 300 s | #1160 |
| `head-moved` | view at another head; merge stderr `Head branch was modified` | ship.ts:928-932, 787-796 | 77 | #415, #1160 |
| `conflict` | view `mergeable` CONFLICTING | ship.ts:933-937 | 76 | #415, #812 |
| `no-check` | no row of the required context and App, nothing of the head running | ship.ts:983-991 | 69 at 300 s | #415, #737, #688, #691, #1188 |
| `queued` | no required row, but a required-App row or a listed run of the head is not completed | ship.ts:809-824, 986 | wait; 75 at 1800 s | #1236, #1295, #1514, #1517 |
| `running` | newest required row not completed, or completed with no conclusion | ship.ts:940-943, 992 | wait; 75 at 1800 s | #1128 |
| `superseded` | newest required row completed, a newer row of its Actions run unfinished | required-check.ts:67-81; ship.ts:942 | wait | #1455 |
| `red` | newest required row concluded, not SUCCESS (CANCELLED gets its own line) | ship.ts:944-960 | 74 | #1128, #1171, #1354, #1514, #1517 |
| `green` | newest required row SUCCESS | ship.ts:961-973, merge or rebase in ship.ts:722-806 | merge, or rebase and wait for a fresh Check | #1160, #1407, #1053, #900 |
| `merging` | green and a merge requested, or merge stderr `Merge already in progress` | ship.ts:797-802, 975-982 | wait; 80 at 600 s | #1271 |

Timers (300 s start, 1800 s gate, 600 s merge) stay with the caller; the state never reads a clock.

### Interfaces compared

1. **Pure classifier plus one gh client (chosen).** One function, `classify(answers, expected)`, two types and two constants (`PR_STATES`, `PR_VIEW_FIELDS`); behind them the parsing of gh's answers, the required-check selection, rerun supersession, the one meaning of green and red, and the head, update and merge rules. The test surface is one fixture per state, no fake clock. Every reader can use it: ship per poll, the open-red limit and close evidence once per PR, the lane receiver on the base head. The gh client (next step) owns the one retry policy.
2. **Event-loop state machine.** `watchPr({ gh, clock, pr, head, onGreen }) -> Outcome` owns polling, timers, merge and rebase. It is deeper for ship alone, but the one-shot readers cannot use a loop, so their divergent copies stay; its tests need a fake clock and a fake gh, as `test/ci/ship.test.ts` (1953 lines) does today.
3. **Thin typed adapter.** `githubPr(repo).view / checks / runs / merge` returning parsed results under one retry policy. It ends the transport class (#1182, #1189, #1197, #1188) but leaves the state branches in each caller, so the selection and red definitions keep diverging.

The chosen design takes 1 and adds the client of 3 as its I/O half; the poll loop in ship becomes a switch on `state.kind` with the three timers.

## Latent bugs and inconsistencies (confirmed by probe)

1. `newestCheck` ignores the App id, and the rollup it reads has none: src/ci/ship.ts:99, used by src/cli/lane-open-red.ts:49 and ship's close record (ship.ts:342). A newer foreign-App `Check` FAILURE beside the required SUCCESS: `newestCheck` returns FAILURE, `selectRequiredCheck` SUCCESS, and the open-red limit counts the PR red.
2. `requiredContext` takes the first of several required contexts: src/repo/required-check.ts:148. Classic `Check` and ruleset `ci / Check`, both App 15368: ship judges `Check` alone while verify (src/adopt/verify.ts:86) reports "no single required status check"; GitHub then refuses the merge as in 5.
3. A context required from any source (classic `app_id: null`, ruleset without `integration_id`) is dropped: src/repo/required-check.ts:130-140. A ruleset requiring `ci / Check` from any source makes ship judge `Check`, which never appears on that repository's heads: exit 69.
4. The open-red limit counts a superseded attempt red: src/cli/lane-open-red.ts:49-55. On the #1449 capture during its rerun, ship waits and `redOrMissing` returns true.
5. A merge refused by an answered rule (base-branch policy, required review) exits with no ship code: src/ci/ship.ts:803 rethrows the `CommandFailure`, not the documented 80 "still open and blocked".
6. Three meanings of red: ship, any concluded non-SUCCESS (src/ci/ship.ts:944-948); open-red, six conclusions, NEUTRAL and SKIPPED not red (src/cli/lane-open-red.ts:19-26); lane receiver, FAILURE and TIMED_OUT only, a CANCELLED or STARTUP_FAILURE base is not red (src/cli/lane-run/receiver.ts:87).
7. The lane receiver ignores reruns: src/cli/lane-run/receiver.ts:108-118 drops `id` and `detailsUrl` and never asks `supersededByRerun`, so a base whose failed Check is being rerun reads "the baseline is red".
8. Task close evidence takes the first `Check` of the rollup, not the newest or the required context: src/task/close-evidence.ts:51-52. On the verbatim #1158 rollup it records failure while the head's newest Check is SUCCESS.
9. An HTTP 5xx counts as answered and is never retried: src/ci/ship.ts:62-63. One 502 during the 30-minute wait ends the ship.

Not yet seen live, so no fixture: a draft PR (`gh pr merge` refuses it), a head with more than 100 check runs (ship.ts:829 reads one page), a required merge queue.

## Migration

1. **Classifier and fixtures** (this step): `src/ci/github-state.ts`, `test/ci/github-state.test.ts`, `test/fixtures/github-state/`, five new REST captures in `test/fixtures/gh/provenance.json`. No caller changes.
2. **One gh client.** Reads retry unanswered failures and HTTP 5xx under one capped budget; writes never retry blindly: the caller takes a fresh snapshot and acts on its state (look before create, re-merge only a green head). Failures map to `unanswered`, `head-moved`, `merge-in-progress` or `answered` from verbatim stderr captures. Deletes ship.ts:49-63, 200-222, 648 and the create loop at 687-699. Fixes 9.
3. **Ship's poll loop on the state.** `waitForMerge` (ship.ts:872-999) becomes snapshot, classify, switch with the three timers; an answered merge refusal maps to 80. An equivalence test drives every fixture through ship and asserts the exit in the state table. Deletes `newestCheck`, the `prView` schema, `queued` and `checks`; the close record takes the conclusion from the state. Fixes 5.
4. **One required-gate reader** shared by ship, verify, open-red and the receiver: one context, or the gap verify prints, for several or any-source contexts. Fixes 2 and 3.
5. **Other readers on the state.** The open-red limit, the lane receiver and task close evidence read check-runs per head and branch on `classify`, with one meaning of red. Fixes 1, 4, 6, 7 and 8.
6. **Measure.** `node scripts/architecture/depth.ts` shows src/ci/ship.ts below its 962 non-test lines; `node scripts/fix-churn.mjs --report` no longer lists src/ci/ship.ts 14 days after step 3 merges.

## Consequences

- A new GitHub surprise is one capture, one fixture and at most one new state, not a branch in each reader.
- Until steps 3 to 5 merge, the module has no production caller; its fixtures are the regression record of the 20 state fixes. The depth script flags it shallow (5 exports, 118 lines) until those steps move the selection, supersession and verdict code of ship, the open-red limit and the receiver behind it.
- The fixtures duplicate capture bytes (about 80 kB); the derivation test keeps them honest, and regenerating them is a projection of the captures.
