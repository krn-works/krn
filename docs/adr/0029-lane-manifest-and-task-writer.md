# 29. Lane manifest and task writer: one recorded lane, one owner of task record storage

Date: 2026-11-20

## Status

Proposed (t-setr7a5). Amends [ADR 0028](0028-lane-lifecycle.md): its migration steps 2 to 5 are replaced by the order below. Step 1 (`src/lane/state.ts`) stays and becomes the manifest reader; step 6 (protocol lines) and step 7 (delete the evidence fallback) stay as written. Absorbs slices 3 (lane state owner) and 4 (session context) of t-91n0383; that task keeps slices 1, 2 and 5 to 9, and its slices 5 (one retire path) and 6 (settle) write manifest transitions. Consistent with:

- [ADR 0022](0022-harness-integration-and-delivery-transport.md) item 7: the Stop proof, proof line, ledger, contract and `Ticket:` check stay; only how a hook finds its lane changes.
- [ADR 0027](0027-ship-state-model.md): ship keeps the PR state classifier and records its outcome as a manifest transition.
- [ADR 0015](0015-repository-task-tracker.md) and [ADR 0018](0018-task-storage-file-per-task-with-archive.md): claims stay in `.krn/task-claims/` with the hard-link create and the liveness check, owned by `src/task/claims.ts`; record files and the archive keep their format. The manifest names its task; it does not hold the claim.

## Context

The cross-model audit of 2026-11-20 (operator paste) counted 404 `fix(` commits among 1,411 in 14 days. Its top production files were `src/ci/ship.ts` (41), `src/hook/stop.ts` (34) and `src/cli/lane.ts` (31). It named three classes: unhandled GitHub response shapes in ship (ADR 0027 owns that class), host and surface-text coupling in Stop, and non-atomic multi-store lifecycle state in lane and task. Its redesign: one transactional store owner for lane, ship, pid, claim and task state, two-phase `validate -> mutate-with-rollback` transitions, and one `resolveContext(payload, env)`. On the set this ADR changes (`src/hook/stop.ts`, `src/hook/scope.ts`, `src/cli/lane.ts`, `src/cli/lane-run.ts`, `src/cli/lane-run/`, `src/task/`, `src/lane/`), 129 `fix` commits landed from 2026-11-06 to 2026-11-20.

ADR 0028 named the class, no owner for a fact that crosses processes, and built the read side. It gave the fact no writer, so verbs and hooks still guess lane and task state from six stores:

| Store | Today's writers | Guessing readers | End state |
|---|---|---|---|
| `.krn/task-claims/<id>.json` | `src/task/claims.ts` | `lane.ts`, `stop.ts` raw reads, `src/state/loss.ts` | kept, read only through `claims.ts`; the manifest writer claims and releases through it in the same transition (step 4) |
| `.krn/runs/ship/` ship record | `src/ci/ship.ts` | `src/lane/state.ts`, `lane.ts`, `stop.ts` | the `merged` phase replaces its Stop and prune role (step 5); the file stays as ledger input until the ledger reads manifests |
| `.krn/tmp/ship.pid` | `src/ci/ship-live.ts` | drop and prune guards | deleted; `shipping { pid }` (step 5) |
| `.krn/tmp/*.parked` | `src/cli/lane-run/verdict.ts` | `lane-run/prepare.ts` | deleted; `parked` phase (step 6) |
| `refs/krn/pending-tasks` | `src/task/pending.ts` | `pending.ts`, `store.ts`, `unpushed-delete.ts` (by absence) | kept, private to `src/task/storage.ts` (step 2) |
| transcript text and cwd | Claude Code | `stop.ts`, `scope.ts` (71 reads) | lane identity no longer read from them (steps 3 and 4); the read-only test for an unbound worker stays, in `src/harness` |

Task records are written at eleven sites with no owner: `createTask` (`src/task/store.ts:427`), `closeTask` (`:478`), `editTask` (`:582`), `changeDependency` (`:624`), the archive (`src/task/archive.ts:158`), `writeEntries`, `removePendingTasks`, `takePendingTask`, `commitPendingRecords` (`src/task/pending.ts:252,271,299,326`), `carryTaskRecord` (`src/cli/lane.ts:385`) and the pending restore of lane start's rollback (`src/cli/lane.ts:596`).

### Defects

Named by behaviour, because the audit and the reproduction files number them differently. Each reproduction is an untracked file that fails on its assertion on base `bb545b1`; it becomes a tracked lifecycle case in the step that fixes it.

| Defect | Audit | Reproduction |
|---|---|---|
| **Stop zero-commit.** Stop lets a `krn-lane` worker with no commit finish on another lane's merge: a ship record of a task its brief names, or a `verdict: merged` sha that landed after it forked. | D5 | `.krn/tmp/gemini/d3.test.ts` |
| **Scope worktree.** The scope hook lets a `krn-lane` subagent write `tasks/<other>.json` in its worktree, a sibling worktree, or a foreign path without `lane-target`. | D4 | `.krn/tmp/gemini/d4.test.ts` |
| **Drop staged deletion.** `krn lane drop` refuses a lane whose only task change is a staged deletion, calling it "the only copy" (`soleTaskRecords`, `src/cli/lane.ts:443`). | none | `.krn/tmp/gemini/d7.test.ts` |
| **Dep on pending.** `changeDependency` after a pending `editTask` writes `tasks/` while `readTask` reads the pending ref; on a pending-only task it exits 65 "archived". | D8 | `.krn/tmp/gemini/d8.test.ts` |
| **Unpushed-delete pending.** The unpushed-delete hook fails open for a task that lives only in the pending ref or a worktree. | D6 | `.krn/tmp/gemini/d5-unpushed-delete-lane-task.test.ts` |
| **Ship pid clobber.** A second, refused ship overwrites and deletes a live ship's pid file, so drop can race the running ship. | D1 | to write in step 5 |
| **Refused start erases a ship record.** `forgetShip` runs before the budget, capacity and claim checks and outside the rollback. | D7 | to write in step 1 |

Out of scope, each its own task: the Stop loop breaker never trips because the refusal embeds a unique log path (audit D3), and ship's `gh api` calls run without the App scope (audit D2, t-sq7jdqk).

## Decision

### 1. One lane manifest

- **Where.** `.krn/runs/lanes/<laneId>.json` in the main checkout, an ignored path the `r-state-paths` record allows, so it outlives the worktree. A `STORES` entry in `scripts/boundaries.ts` names `src/lane/manifest.ts` its only writer. `krn prune` (`src/cli/prune.ts`), which ages run directories by owner, keeps live manifests and deletes `retired` ones after 7 days.
- **Identity.** `laneId` is `<slug>-<6 random base36>`. A reused branch, slug or task gets a new `laneId`; no reader takes an earlier lane's manifest or ship record for this one. One live (not `retired`) manifest per worktree path.
- **Shape**, parsed once with a zod schema: `{ laneId, slug, branch?, worktree?, base, task?, targets: string[], actor, createdAt, agents: string[], phase }`. `targets` holds the `lane-target:` paths of the task body or `KRN_LANE_TARGET`, read once at start. `phase` is a discriminated union: `reserved`, `started`, `shipping { pid, head, pr? }`, `shipped { pr, head }` (no live ship process), `parked { reason }`, `merged { sha, head }`, `retired { at, reason }`.
- **Transitions**, one exhaustive switch; any other edge throws (exit 70):

| From | To | Writer |
|---|---|---|
| (none) | `reserved` | `krn lane brief --task` |
| (none) or `reserved` | `started` | `krn lane start` (`--lane <laneId>` when reserved) |
| `reserved` | `retired` | the worker's Stop when its start never succeeded; prune after the grace period |
| `started` | `shipping` | `krn pr ship`; refused, with nothing written, while another `shipping` pid is alive |
| `shipping` | `shipping` with `pr` | ship, once the PR is open with auto-merge; ship stays `shipping` while it waits for the merge, so drop keeps its live-ship guard |
| `shipping` | `merged` | ship on its merge verdict |
| `shipping` | `shipped` or `started` | ship on any other exit (74, 75, 76, 77, 84, 85), or any reader that finds `pid` dead: `shipped` when `pr` is set and the PR is open, else `started` |
| `shipped` | `shipping` | any `krn pr ship` rerun (after a fix, or `--force` after a rebase) |
| `shipped` | `started` | a reader whose classifier (ADR 0027) sees the PR closed unmerged |
| `shipped` | `merged` | the first reader that sees the PR merged |
| `started` | `parked` | lane run |
| `parked` | `started` | lane run, lane start reuse |
| any but `retired` | `retired` | drop, prune, settle (t-91n0383 slices 5, 6) |

- **Transactional** means: one writer module; each write reads the manifest, **validates** the transition and every precondition (budget, capacity, claim, live pid) before any side effect, then **mutates** with a recorded rollback for each side effect (worktree, branch, claim, pending record); the manifest is created with an exclusive hard-link create and swapped under a marker named by the digest of the bytes read, so a stale reader exits 75 (PR #1555; the abstract-socket mutex of `claims.ts` was removed in fcd3030). A refused verb leaves every store byte-identical. No caller writes the file.

### 2. How a process finds its lane

One function, `laneOfSession(payload, env, cwd)` in `src/lane/manifest.ts`, returns `{ kind: 'lane', manifest } | { kind: 'legacy-lane', worktree } | { kind: 'unbound-worker' } | { kind: 'lead' }`, in this order:

1. **Environment.** `KRN_LANE_ID`, which `krn lane run` sets for its child next to `KRN_LANE` and `KRN_TASK` (`src/cli/lane-run/environment.ts`).
2. **Agent binding.** Payload `agent_type: krn-lane` with an `agent_id` that a manifest's `agents` holds. In-session subagents inherit the lead's environment, so they cannot carry `KRN_LANE_ID`; a PreToolUse payload carries `agent_id` but no transcript path (`test/claude/fixtures/pretooluse-bash-lead-subagent.jsonl`). The binding is written when a subagent runs `krn lane start --lane <laneId>`: the PreToolUse Bash hook splits the command with the hooks' shell command parser (`commandTargets` in `src/hook/scope.ts`), and appends the `agent_id` through the writer. `krn lane brief` reserves the `laneId` and prints the exact start command, so the id exists before the subagent does. A start command the parser does not recognise leaves the worker unbound, and the refusal quotes the command.
3. **Argument, then checkout.** For `krn` verbs, which get no hook payload: the lane their argument names (`--worktree <path>`, `--lane <laneId>`, or a lane slug as in `krn lane drop <slug>`), else the live manifest whose `worktree` equals the enclosing worktree root exactly (an in-session subagent's `krn task close` or `krn pr ship` run inside its worktree).
4. **Legacy.** While any existing worktree under `.krn/worktrees/` has no manifest (a lane started before the manifest writer was released), an unbound `krn-lane` agent is judged by today's rules. Payload `cwd` cannot name the worktree (the PreToolUse capture carries `"."`), so the rule keys on the worktrees on disk, not on the agent. It ends by itself once those lanes are pruned, and the branch is deleted with the evidence fallback (step 7).
5. Otherwise a `krn-lane` agent is `unbound-worker` and anything else is `lead`.

Policy, fail closed for workers:

- **scope** refuses every write from an `unbound-worker`; from a bound lane, every write outside its manifest `worktree` and `targets`, and every write under `tasks/` (`krn task` is the writer, see 3).
- **Stop** judges a bound lane on its manifest: `merged` with `head` equal to the lane tip, or commits on its branch with the change proof. A manifest still `reserved` has nothing to judge; Stop retires it and lets the worker report. An `unbound-worker` that made a mutating tool call is refused; one that only read may stop. Deciding "made a mutating call" stays a transcript read, the one left, owned by `src/harness` under `test/rules/transcript-readers.test.ts`.
- The lead session is not judged as a lane, as today (`judgeStop` returns early without a worker).
- Hooks run from `.krn/product-release`, refreshed after each merge in the product checkout (`refreshAfterMerge`, `src/ci/ship.ts:945`). The legacy branch keeps lanes started before that refresh writable until they are pruned, so no release gate is needed.

### 3. One task record writer

`src/task/storage.ts` owns where a record lives:

- `locateTask(root, id)` returns `{ where: 'pending' | 'tree' | 'archived' | 'absent', record? }` with one precedence: pending ref, then `tasks/`, then the archive.
- `writeTaskRecord(root, record)` writes where `locateTask` found it (a pending edit stays pending, a published record stays in the tree, an archived one is refused with exit 65); a new record goes to the pending ref on the main checkout and to `tasks/` in a lane worktree.
- A record a lane carries keeps its pending entry, marked held by the lane branch (`held/<id>.json` on the ref: branch and the base's blob at the start). `locateTask` returns it as `pending` with `heldBy`, every main reader sees it, `writeTaskRecord` refuses it with exit 65 and `krn task publish` skips it. The hold ends when the base's copy of the record changes (the lane merged; the next write drops the entry) or the lane branch is gone (the record is plain pending again).
- `laneOnlyRecords(main, branch)` returns the task record versions present in a lane's worktree tree or index, or on its branch tip when the worktree is gone, that `locateTask` on the main checkout and `origin/<base>` do not hold. A staged deletion holds no version. The unpushed-delete hook today reads `tasks/<id>.json` only from the main checkout and fails open when the record lives only on the branch (`src/hook/unpushed-delete.ts:135-145`).

The eleven sites become calls of these or private helpers of `storage.ts`, and every `krn task` verb behaves the same on a pending, worktree-only and published record. `krn lane drop` and the unpushed-delete hook both ask `laneOnlyRecords`, and a `merged` lane bypasses the check.

### Defect to clause

| Defect | Clause | Step |
|---|---|---|
| Stop zero-commit | 2: no other lane's ship record or verdict is read; an unbound worker with a mutating call is refused | 4 |
| Scope worktree | 2 and 3: writes outside `worktree` and `targets`, under `tasks/`, or from an unbound worker are refused | 3 |
| Drop staged deletion | 3: `laneOnlyRecords` | 2b |
| Dep on pending | 3: `locateTask` and `writeTaskRecord` | 2a |
| Unpushed-delete pending | 3: `laneOnlyRecords` | 2b |
| Ship pid clobber | 1: `shipping` is validated before any write | 5 |
| Refused start erases a ship record | 1: validate before mutate | 1 |

t-9egpjj4 (Stop zero-commit), t-1zptswy (scope worktree) and t-48b8v1f (subshell `cd`, covered by the worktree rule) are closed by the step that turns their case green. t-1vmjrty (unpushed-delete flag parsing) stays its own fix.

## Migration, in order

Each step is one PR under about 400 changed lines, test-first: its first commit adds the lifecycle cases it turns green, and its body cites their red run on base. A store moves only after the open PRs that touch it merge (#1546 hooks, #1551 ship).

1. **Lifecycle suite and manifest writer**, two PRs: 1a the writer, its transitions and the `STORES` entry; 1b the suite. `test/lane/lifecycle.test.ts`: one real-git fixture (bare origin, clone, real `krn` verbs in process, no stubbed transport, no prior-lane state) walks create, edit, dep, brief, start, scope, stop, ship and drop. GitHub is replaced only where it is the receiver, by a fake built from verbatim captures (KRN-12). A refusal-invariance case snapshots every store before and after each refused verb. Lands with `src/lane/manifest.ts`, the `STORES` entry, `krn lane brief` and `krn lane start` writing `reserved` and `started`, and start validating before `forgetShip`.
2. **Task storage owner**, two PRs. 2a: `locateTask` and `writeTaskRecord`, the eleven sites behind them, and a verb-by-storage matrix (every `krn task` verb on pending, worktree-only and published records). 2b: `laneOnlyRecords` for drop and unpushed-delete.
3. **Hook binding.** `laneOfSession`, the binding write in the PreToolUse Bash hook, scope on it.
4. **Stop and claims on the manifest.** `recordedShip`, `laneRecords`, `laneWorktreeIn`, `claimedWorktree` and `ownerCheckout` read the manifest; the manifest writer claims and releases through `claims.ts`. Their transcript and raw claim reads are deleted.
5. **Ship writes phases.** `shipping`, `shipped`, `merged` and the back-edges; `.krn/tmp/ship.pid` is deleted.
6. **Lane run phases.** `parked` replaces `*.parked`; `verdict.ts` reads `merged`.
7. ADR 0028 step 7: after one prune grace period, `readLane` drops the evidence fallback and `laneOfSession` its legacy branch.

## Consequences

- Proof: the `fix` commits on the changed set fall at least 40% from 129 within two 14-day windows after step 6. Measure: `git log origin/main --since=14.days --format=%s -- src/hook/stop.ts src/hook/scope.ts src/cli/lane.ts src/cli/lane-run.ts src/cli/lane-run src/task src/lane | grep -c '^fix'`.
- Until step 4, Stop keeps its transcript and ship-record reads; a Stop fix in the meantime goes into the manifest path, not a new guess.
- A subagent that never ran `krn lane start --lane` is an unbound worker and cannot write; general-purpose calls routed to `krn-lane` that only read are unaffected.
- The binding depends on the PreToolUse payload carrying `agent_id`; step 3 adds a verbatim `krn-lane` capture beside the existing general-purpose one.
