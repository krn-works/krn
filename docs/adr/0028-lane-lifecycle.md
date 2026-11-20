# 28. Lane lifecycle: one reader of lane state, then one record; one parser per protocol line

Date: 2026-11-19

## Status

Proposed; migration steps 2 to 5 amended by [ADR 0029](0029-lane-manifest-and-task-writer.md). Step 1 lands with this ADR. t-91n0383 (one owner for lane state) carries the rest, and the ADR 0022 amendment it requires adopts or supersedes this one; the Stop hook readers (src/hook/stop.ts), a `STORES` entry for the ship record in scripts/boundaries.ts and the matrix test are still open there.

## Context

From 2026-11-01 to 2026-11-19, 104 `fix` commits touched `src/hook/stop.ts`, `src/cli/lane.ts`, `src/cli/lane-run.ts`, `src/cli/lane-run/*` or `src/task/claims.ts`. Each one was classified from its subject and, where the subject was ambiguous, its body:

| Root cause | Fixes | PRs |
|---|---:|---|
| **Lane state inferred differently.** Two readers decide claimed, running, shipped, merged or retired from different evidence. | 33 | #1475 #1467 #1457 #1381 #1349 #1342 #1330 #1313 #1258 #1256 #1246 #1232 #1204 #1199 #1169 #1146 #1140 #1127 #1107 #1055 #1013 #988 #860 #854 #839 #831 #772 #706 #661 #660 #659 #612 and `74248445` (t-y3q6sey) |
| **Protocol text parsed differently.** A line one process writes is read by another with its own regular expression. | 8 | #1087 #1051 #1044 #869 #723 #720 #698 #697 |
| **Receiver or environment shape.** Toolchain, sandbox, host load, gh, an outside repository, the transcript format. | 30 | #1517 #1469 #1458 #1449 #1445 #1444 #1438 #1428 #1429 #1398 #1352 #1287 #1213 #1054 #1050 #992 #885 #753 #745 #716 #713 #708 #704 #703 #699 #696 #695 #614 #608 #582 |
| **Other.** Test-first and standards arms, drain policy, briefs, ship guards. Six of these concern where the task record lives (#727 #710 #665 #628 #511, `8ae9e50f`). | 33 | the rest |

The first two rows are one defect class: **no owner for a fact that crosses processes**. Together they cover 41 of the 104 fixes (39%). #869 is counted as protocol, but it also decided lane state.

### Where lane state is decided (base `1cfd0601`)

| Decision point | Question | Evidence read | Output |
|---|---|---|---|
| `src/hook/stop.ts:1370` `shippedMerge` | did this session's lane merge? | the `verdict: merged <sha>` line in the last message (regex tolerates `>`, `*`, `` ` ``, `-`), then `onBase` | allow Stop |
| `src/hook/stop.ts:1414` `onBase` | is a sha merged? | `origin/<base>` **or local `<base>`**, plus **one `git fetch`** on a miss | boolean |
| `src/hook/stop.ts:1464` `recordedShip` | did this session's lane merge? | ship record files parsed inline (L1502), matched by worktree name, claimed branch or `KRN_TASK`; tip only for a kept worktree; `laneMergeVerdict` **without `at` or `committedAt`** (L1517) | allow Stop |
| `src/hook/stop.ts:1689` `mergedLaneBranch` | did a removed worktree's branch merge? | GitHub `pulls?state=closed&head=` `merged_at` | allow Stop |
| `src/hook/stop.ts:1747` `laneWorktreeIn` | which worktree is this subagent's? | last edited path in the transcript, else a **raw claim file** (L1763) | path |
| `src/hook/stop.ts:1818` `laneRecords` | which lanes did this session start? | task ids regex-scanned from the transcript; **raw claim files** (L1834); ship records parsed again (L1848) | branches and worktrees |
| `src/hook/stop.ts:1948` `claimedWorktree`, `:1779` `ownerCheckout`, `:1437` `laneTreeOf` | where should Stop judge? | path shape `.krn/worktrees/<name>`, `existsSync`, claims | path |
| `src/hook/stop.ts:1595` `readOnlySession` | is this a lane at all? | transcript tool calls (`krn lane start`, `git commit`, …) | skip Stop |
| `src/hook/scope.ts:137` `worker` | is this a lane, and which task? | `KRN_SESSION_CLASS`, `KRN_TASK`, task id in the branch or directory name | scope |
| `src/cli/lane.ts:110` `checkLaneBudget` (+ `mergedShipBranches` L219, `laneState` L169) | does this lane fill the budget? | `.git` file, ship record (third inline parser), worktree tip, `committedAt`, `origin/<base>` only, `git status` | count or skip |
| `src/cli/lane.ts:157` `failedAttempt` | is this worktree a failed attempt? | task id name, no ship record, task open, claim `none` | skip |
| `src/cli/lane.ts:303` `pruneMergedLanes` | may this lane be removed? | ship records (fourth parser), worktree **or branch** tip, `committedAt`, `origin/<base>`, record mtime, `/proc` cwds | remove |
| `src/cli/lane.ts:504` `claimsFrom`, `:541` `dropLane` | which claims belong to this worktree? | **raw claim files with their own zod schema** | release |
| `src/cli/lane.ts:648` `startLane` | may the slug start? | worktree exists, branch exists, then `forgetShip` | refuse or start |
| `src/cli/lane-status.ts:51` `laneState` | live, merged, orphaned, pr-open, closed, empty? | live ship pid, ship record, worktree tip, **no `committedAt`**, `origin/<base>` only, commits ahead, newest PR | state |
| `src/task/claims.ts:572` `claimLiveness` | is a claim live? | worktree path, registered worktree, branch ref, task file in the worktree, task closed on `origin/<base>`; **never the ship record** | live or expired |
| `src/cli/lane-run/prepare.ts:165` | reuse or start? | **worktree exists**, parked file `.krn/tmp/lane-run-<lane>.parked` (L169), red file, base conflicts | resume, reclaim or start |
| `src/cli/lane-run/prepare.ts:387` `reclaimLane`, `src/cli/lane-run/drain.ts:102` | take the claim again? | task closed in the worktree, claim actor and worktree | claim |
| `src/cli/lane-run/verdict.ts:347` | did ship merge? | last ship output line starting `verdict: `, then `/^verdict: merged\b/` | exit 0 or 74 |
| `src/ci/ship.ts:289` / `:297` | which task, and record the ship | `KRN_TASK`, else `(t-xxxxxxx)` at the end of the title; writes the ship record | ship record |

Eighteen decision points read nine evidence sources: ship record, claim file, worktree directory, branch ref, `origin/<base>` (fetched or not), GitHub PR state, transcript text, process cwds, and lane-run's parked and red files. The ship record has one writer (`src/ci/ship.ts:297`) and **five parsers** (lane.ts ×3, stop.ts ×2). The claim file has one owner (`src/task/claims.ts`) and **three raw readers** outside it.

### Protocol lines

| Line | Writers | Readers and their rule |
|---|---|---|
| `verdict: merged <sha>` | `src/ci/ship.ts:377,427,857` (and other `verdict:` kinds) | `src/hook/stop.ts:1372` (any line, tolerates `>*\`-` and spaces); `src/cli/lane-run/verdict.ts:347` (last line that starts with `verdict: `); `scripts/outside-acceptance.ts:202` (`\bverdict: merged`, anywhere) |
| `BLOCKER: <reason>` | the agent, as told by `src/cli/lane-brief.ts:50-58` and `src/cli/lane-run/brief.ts` | `src/brain/proof-line.ts:110` (Stop: `^\s*\**BLOCKER:`); `evals/replay/session-result.ts:132` (lane run: trimmed `^\**BLOCKER:`); `scripts/outside-acceptance.ts:231` (`\bBLOCKER:`, anywhere) |
| `Ticket:` / `Refs:` | `src/cli/pr-body.ts:151`, `src/task/pending.ts:278`, `src/cli/lane-run/prepare.ts:347`, briefs | git trailer block only: `src/task/branch-tickets.ts:57` (the CI task check), `src/brain/exposures.ts:602`, `src/cli/lane-finish.ts:55`. Any body line, comma list: `src/cli/lane-run/delivery.ts:19`. One exact id per line: `src/ci/task-merge.ts:18`, `src/hook/unpushed-delete.ts:133`. `src/successor/intent-to-task.ts:229` |
| `Weakens-tests: <reason>` | `src/cli/lane-finish.ts:138`, the PR body | `src/hook/stop.ts:338`, `scripts/weak-tests.mjs:12` (two copies of one regex) |
| `Delivery: none` | lead briefs | `src/hook/stop.ts:1678` |
| `proof: clauses n/m, …` | `src/brain/proof-line.ts` | `src/brain/exposures.ts:421` |
| `(t-xxxxxxx)` at the end of a title | commit and PR titles | `src/ci/ship.ts:289`, `src/ci/task-merge.ts:17`, `src/hook/scope.ts` `taskId` |

### Confirmed inconsistencies

Each scenario below was probed on real git repositories with the real functions at `1cfd0601`, using the `callers()` harness of `test/cli/lane-merge-verdict.test.ts`.

| Scenario | lane status | budget | prune | Stop (`recordedShip`) |
|---|---|---|---|---|
| **S1.** The PR squash-merged on GitHub, no ship record (ship stopped waiting, auto-merge finished later), worktree kept | `merged` | counted **live** | **kept forever** (walks ship records only) | not shipped |
| **S2.** A ship record without `head` (written before #1256, or `rev-parse` failed at ship), worktree at the shipped tip | `empty` | free (merged) | **removed** | **not shipped** |
| **S3.** The main checkout has not fetched the merge | `unknown` (gh offline) or via the PR | counted live (unless run inside `lane start`, which fetches first) | kept | **shipped** (it fetches) |

- S2: prune deletes a worktree whose session Stop still refuses as unshipped.
  - Cause: `laneMergeVerdict` gets `at` and `committedAt` from budget and prune (`src/cli/lane.ts:231,340`), but not from status (`src/cli/lane-status.ts:62`) or Stop (`src/hook/stop.ts:1517`).
- S3: the merged-on-base rule differs.
  - Stop (`src/hook/stop.ts:1414`) checks `origin/<base>` or local `<base>`, and fetches on a miss.
  - Status, budget and prune (`src/cli/lane.ts:201`) check `origin/<base>` only.
- Protocol readers disagree (pure probe):
  - `> BLOCKER: x`, `- BLOCKER: x` and `see the BLOCKER: line` count as blockers for the outside acceptance runner, but not for Stop or lane run.
  - A `Ticket:` line in a paragraph above `Co-Authored-By` is a ticket for lane run (`delivery.ts:19`). It is not a ticket for git's trailer parser, which the CI task check (`branch-tickets.ts:57`) uses.
  - In `Ticket: t-a, t-b`, lane run reads `t-b`, but `task-merge.ts:18` does not.

## Decision

### Lane state: design it twice

- **A. Minimal: `laneMerged(main, base, branch): boolean`.**
  - Smallest interface.
  - Status still needs pr-open and closed; Stop still needs session matching; prune still needs to know where the tip lives. Each caller rebuilds the missing part, which is today's defect.
  - Fails the deletion test: it moves no inference out of its callers.
- **B. Evidence snapshot: `readEvidence(main, branch)` returns record, tip, `committedAt`, worktree and branch; callers apply `laneMergeVerdict` themselves.**
  - Flexible.
  - It is today's design, with the parser shared and nothing else. Callers still choose inputs and the fetch policy, so S2 and S3 stay possible.
- **C. Lane state owner.**
  - Phase 1 is a read-only reader: `readLane(main, base, branch, pr?)` returns `{ verdict, record, worktree, tip }`. It owns:
    - the record parser;
    - where the tip lives (the worktree, else the branch ref, else gone);
    - the ownership inputs (`head`, `at`, `committedAt`);
    - the merged-on-base rule.
  - Phase 2 adds one recorded lifecycle per lane, `.krn/lanes/<branch>.json` with transitions `claimed → started → shipped(pr, head) → merged(sha) → retired`. It is written by `lane start`, `pr ship`, prune and drop. `readLane` reads the record first and falls back to evidence only for lanes that have no record.
  - Callers keep only their own policy: what counts against the budget, when a removal is safe, how to word a status.

**Chosen: C.** Deletion test: delete `src/lane/state.ts` and the record parsing, tip resolution and ownership inputs reappear in status, budget, prune and Stop. That is four callers, and today they differ in exactly those places. The seam is real: git probes in production and fixture repositories in tests.

C's phase 1 is the first step because it lands without a new writer and directly fixes S2 for three of the four readers. S1 and S3 need phase 2: a recorded `merged` transition from ship, or from the first reader that sees the PR merged, removes the need to fetch or ask GitHub at every read.

### Protocol lines: design it twice

- **A. A generic registry, `parseLine(kind, text)` and `formatLine(kind, value)`, driven by a table.**
  - One entry point.
  - A table cannot express trailer-block semantics, comma lists or "last such line", so special cases leak back into options.
- **B. One module, `src/repo/protocol-lines.ts`, with a typed `format` and `parse` pair per kind.** The kinds are verdict, blocker, ticket, weakens-tests, delivery, proof and title task id.
  - Tolerance is declared once. Agent-written lines (blocker, verdict quoted back by an agent, `Delivery`) accept the same leading `>`, `*`, `` ` ``, `-` everywhere. Machine-written lines (ship stdout) are strict.
  - `parseTickets(message)` follows git's trailer block, falls back to any `Ticket:` or `Refs:` line, and returns `{ key, ids[] }` for each comma list.
- **C. No parser: ship writes JSON (`.krn/runs/ship/*.json` already exists), and readers read files instead of lines.**
  - Right for the ship verdict once lane state is recorded.
  - Wrong for `BLOCKER`, `Ticket` and `Weakens-tests`, which are written by an agent or a person into text that git and GitHub keep.

**Chosen: B for text that people and agents write, and C for the verdict.** Once Stop asks `readLane`, `shippedMerge` and its verdict regex are no longer needed. Lane run then reads ship's exit code and the ship record instead of its last line.

## Migration, in order

1. **(this ADR's PR)** Add `src/lane/state.ts` with `readLane`, `readShipRecord` and `shipRecords`; it is read-only.
   - The lane budget, `pruneMergedLanes` and `krn lane status` ask it.
   - The inline ship-record parsers and `isMergedOn`, `shipRecord`, `mergedShipBranches` and `commitTime` are deleted from `src/cli/lane.ts`.
   - S2 now agrees across status, budget and prune (`test/cli/lane-merge-verdict.test.ts`).
2. Stop asks `readLane`.
   - `recordedShip` and the ship-record half of `laneRecords` call it.
   - The merged-on-base rule becomes one rule with a single fetch on a miss, and status, budget, prune and Stop all use it.
   - Delete the ship-record parsing at `src/hook/stop.ts:1492,1848`.
   - Add `hook → lane` to `scripts/boundaries.ts`.
3. `src/lane/state.ts` reads claims through `src/task/claims.ts` (`inspectClaim`), exported as `lanesOfSession(main, taskIds)`. Delete the raw claim reads at `src/hook/stop.ts:1763,1834` and `src/cli/lane.ts:504`.
4. Recorded lifecycle `.krn/lanes/<branch>.json`.
   - Writers: `startLane` (claimed and started), `src/ci/ship.ts` (shipped with PR and head, then merged), prune and drop (retired).
   - `readLane` prefers the record. S1 and S3 then read `merged` without GitHub or a fetch.
   - `forgetShip` becomes a `retired` transition.
5. Lane run's parked and red files (`src/cli/lane-run/delivery.ts:172`, `prepare.ts:93`) and its reuse decision (`prepare.ts:165`) become lifecycle fields and phases.
   - `src/cli/lane-run/verdict.ts:347` reads the recorded `merged` instead of the last verdict line.
   - Stop's `shippedMerge` is deleted (proof: no ship-record or worktree probing left in `stop.ts` or `lane.ts`).
6. Add `src/repo/protocol-lines.ts` (no task yet), with a round trip per kind.
   - Readers move to it in this order: `BLOCKER` (3 readers), `Ticket`/`Refs` (8), `Weakens-tests` (2), `Delivery`, the proof line, and the title task id.
   - `scripts/outside-acceptance.ts` and `scripts/weak-tests.mjs` import it.
7. Once no lane predates the record (one prune grace period), delete the evidence fallback from `readLane`, and with it the remaining `existsSync` and branch-ref probing.

## Consequences

- Each step is one PR with behaviour pinned by agreement tests. Each test asserts that status, budget, prune and Stop give the same verdict for one scenario.
- Until step 2, Stop still disagrees in S2. Until step 4, S1 and S3 still disagree. This ADR names them so that a fix in the meantime goes into `src/lane/state.ts`, not into a caller.
- `.krn/runs/ship/*.json` stays the ship writer's format. The lifecycle record adds to it and does not replace it.
