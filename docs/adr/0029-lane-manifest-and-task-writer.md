# 29. Lane manifest and task writer: one recorded lane, one owner of task record storage

Date: 2026-11-20

## Status

Proposed (t-setr7a5). Amends [ADR 0028](0028-lane-lifecycle.md): its migration steps 2 to 5 are replaced by the order below. Step 1 (`src/lane/state.ts`) stays and becomes the manifest reader; step 6 (protocol lines) and step 7 (delete the evidence fallback) stay as written. Absorbs slices 3 (lane state owner) and 4 (session context) of t-91n0383; that task keeps slices 1, 2 and 5 to 9, and its slices 5 (one retire path) and 6 (settle) write manifest transitions. Consistent with [ADR 0022](0022-harness-integration-and-delivery-transport.md) item 7: the Stop proof, proof line, ledger, contract and `Ticket:` check stay; only how a hook finds its lane changes. Consistent with [ADR 0027](0027-ship-state-model.md): ship keeps the PR state classifier and records its outcome as a manifest transition. Consistent with [ADR 0015](0015-repository-task-tracker.md) and [ADR 0018](0018-task-storage-file-per-task-with-archive.md): `krn task claim` keeps its meaning and records keep their file and archive format; a lane's claim moves into its manifest, and one module decides where a record lives.

## Context

From 2026-11-06 to 2026-11-20, 129 `fix` commits on `origin/main` touched the lane and task set (`src/hook/stop.ts`, `src/hook/scope.ts`, `src/cli/lane.ts`, `src/cli/lane-run.ts`, `src/cli/lane-run/`, `src/task/`, `src/lane/`); the hottest files were `src/ci/ship.ts` (41), `src/hook/stop.ts` (34), `src/cli/lane.ts` (30) and `src/cli/lane-run.ts` (19) (`node scripts/fix-churn.ts --report`). ADR 0028 named the class, no owner for a fact that crosses processes, and built the read side. It gave the fact no writer, so verbs and hooks still guess lane and task state from six stores:

| Store | Today's writers | Guessing readers | End state |
|---|---|---|---|
| `.krn/task-claims/<id>.json` | `src/task/claims.ts` | `lane.ts`, `stop.ts` raw reads, `src/state/loss.ts` (14 files) | lane claims move into the manifest (step 4); the file stays only for claims without a lane, owned by `claims.ts` |
| `.krn/runs/shipped/` ship record | `src/ci/ship.ts` | `src/lane/state.ts`, `lane.ts`, `stop.ts` | `merged` phase replaces its Stop and prune role (step 5); the file stays as ledger input until the ledger reads manifests |
| `.krn/tmp/ship.pid` | `src/ci/ship-live.ts` | drop and prune guards | deleted; `shipping { pid }` (step 5) |
| `.krn/tmp/*.parked` | `src/cli/lane-run/verdict.ts` | `lane-run/prepare.ts` | deleted; `parked` phase (step 6) |
| `refs/krn/pending-tasks` | `src/task/pending.ts` | `pending.ts`, `store.ts` | kept, private to `src/task/storage.ts` (step 2) |
| transcript text and cwd | Claude Code | `stop.ts`, `scope.ts` (71 reads) | lane identity no longer read from them (steps 3 and 4); the read-only test for an unbound worker stays, in `src/harness` |

Task records are written at eleven sites with no owner: `createTask` (`src/task/store.ts:427`), `closeTask` (`:478`), `editTask` (`:582`), `changeDependency` (`:624`), the archive (`src/task/archive.ts:158`), `writeEntries`, `removePendingTasks`, `takePendingTask`, `commitPendingRecords` (`src/task/pending.ts:252,271,299,326`), `carryTaskRecord` (`src/cli/lane.ts:385`) and the pending restore of lane start's rollback (`src/cli/lane.ts:596`).

Four reproduced defects on base `bb545b1` (`.krn/tmp/gemini/d3.test.ts`, `d4.test.ts`, `d7.test.ts`, `d8.test.ts`, the short-named files; each fails on its assertion) show the class:

- **D3.** Stop lets a `krn-lane` worker with zero commits finish, because the ship record of an earlier task its brief names (`After: t-old1234`) matches.
- **D4.** The scope hook lets a `krn-lane` subagent write `tasks/<other>.json` in its worktree (D4a) and write into a foreign repository (D4b), because it identifies the lane by cwd.
- **D7.** `krn lane drop` refuses a lane whose only task change is a staged deletion, calling it "the only copy", because it infers record ownership from the worktree diff.
- **D8.** `changeDependency` after an `editTask` that went pending writes `tasks/` while `readTask` reads the pending ref, so the change vanishes (D8a); on a pending-only task it reports "archived" (D8b).

## Decision

### 1. One lane manifest

- **Where.** `.krn/lanes/<laneId>.json` in the main checkout, so it outlives the worktree. A `STORES` entry in `scripts/boundaries.ts` names `src/lane/manifest.ts` its only writer.
- **Identity.** `laneId` is `<slug>-<6 random base36>`. A reused branch, slug or task gets a new `laneId`; no reader takes an earlier lane's manifest or ship record for this one (D3). One live (not `retired`) manifest per worktree path.
- **Shape**, parsed once with a zod schema: `{ laneId, slug, branch?, worktree?, base, task?, actor, createdAt, agents: string[], phase }`. `phase` is a discriminated union: `reserved`, `started`, `shipping { pid, head }`, `shipped { pr, head }`, `parked { reason }`, `merged { sha, head }`, `retired { at, reason }`.
- **Transitions**, one exhaustive switch; any other edge throws (exit 70):

| From | To | Writer |
|---|---|---|
| (none) | `reserved` | `krn lane brief --task` |
| (none) or `reserved` | `started` | `krn lane start` (with `--lane <laneId>` when reserved) |
| `started` | `shipping` | `krn pr ship` |
| `shipping` | `shipped` | ship, once the PR is open with auto-merge |
| `shipping`, `shipped` | `started` | ship on exit 74, 75, 76, 77, 84 or 85; any reader that finds `shipping.pid` dead |
| `shipped` | `shipping` | `krn pr ship --force` |
| `shipped` | `merged` | ship, or the first reader that sees the PR merged (ADR 0027 classifier) |
| `started` | `parked` | lane run |
| `parked` | `started` | lane run, lane start reuse |
| any but `retired` | `retired` | drop, prune, settle (t-91n0383 slices 5, 6), an abandoned reservation |

- **Transactional** means: one writer module; each write takes an exclusive lock file (`O_EXCL`; stale once its owner pid is gone), reads the manifest, applies one allowed transition, writes a temporary file and renames it. No caller writes the file.

### 2. How a process finds its lane

One function, `laneOfSession(payload, env, cwd)` in `src/lane/manifest.ts`, returns `{ kind: 'lane', manifest } | { kind: 'unbound-worker' } | { kind: 'lead' }`, in this order:

1. **Environment.** `KRN_LANE_ID`: set by `krn lane run` for its child and by Codex lanes, which run as separate processes.
2. **Agent binding.** Payload `agent_type: krn-lane` with an `agent_id` that a manifest's `agents` holds. In-session subagents inherit the lead's environment, so they cannot carry `KRN_LANE_ID`, and a PreToolUse payload names no subagent transcript. The binding is written when a subagent runs `krn lane start --lane <laneId>`: the PreToolUse Bash hook sees `agent_id` and the parsed command, and appends the id through the writer. `krn lane brief` reserves the `laneId` and prints the exact start command, so the id exists before the subagent does.
3. **Checkout.** For `krn` verbs, which get no hook payload (an in-session subagent's `krn task close` or `krn pr ship`): the live manifest whose `worktree` equals the enclosing worktree root exactly.
4. Otherwise a `krn-lane` agent is `unbound-worker` and anything else is `lead`.

Policy, fail closed for workers:

- **scope** refuses every write from an `unbound-worker`; from a bound lane, every write outside its manifest `worktree` (D4b) and every write under `tasks/` (D4a; `krn task` is the writer, see 3).
- **Stop** judges a bound lane on its manifest: `merged` with `head` equal to the lane tip, or commits on its branch with the change proof. An `unbound-worker` that made a mutating tool call is refused (D3); one that only read may stop. Deciding "made a mutating call" stays a transcript read, the one left, owned by `src/harness` under `test/rules/transcript-readers.test.ts`.
- The lead is never judged as a lane.
- **Release.** Hooks run from `.krn/product-release`, so a lane alive when step 3 is released has no binding and would lose every write. The steps that switch hooks to the manifest (3 and 4) are released only with no live lane (`krn lane status`), and the release refuses otherwise.

### 3. One task record writer

`src/task/storage.ts` owns where a record lives:

- `locateTask(root, id)` returns `{ where: 'pending' | 'tree' | 'archived' | 'absent', record? }` with one precedence: pending ref, then `tasks/`, then the archive.
- `writeTaskRecord(root, record)` writes where `locateTask` found it (a pending edit stays pending, a published record stays in the tree, an archived one is refused with exit 65); a new record goes to the pending ref on the main checkout and to `tasks/` in a lane worktree.

The eleven sites above become calls of these two or private helpers of `storage.ts` (D8a, D8b). `krn lane drop` refuses when the lane worktree holds a task record version, a file present in its tree or index, that `locateTask` on the main checkout and `origin/<base>` cannot find with equal content. A staged deletion holds no version (D7); a record that arrived by rebase, merge or hand edit is still protected. The regression cases of `.krn/tmp/gemini/d5-unpushed-delete-lane-task.test.ts` and `d13-drop-lane-deletes-main.test.ts` join the lifecycle suite in step 2 to pin that.

### Defect to clause

| Defect | Clause that turns it green | Step |
|---|---|---|
| D3 | 2: an unbound worker with a mutating call is refused; no other lane's ship record is read | 4 |
| D4a | 2 and 3: lane writes under `tasks/` are refused | 3 |
| D4b | 2: writes outside the manifest worktree, or from an unbound worker, are refused | 3 |
| D7 | 3: drop compares record versions, not the worktree diff | 2 |
| D8a, D8b | 3: `changeDependency` reads and writes through `locateTask` | 2 |

### Overlapping tasks

t-9egpjj4 (D3), t-1zptswy (D4a, D4b) and t-48b8v1f (subshell `cd`, which the worktree rule of clause 2 covers) are closed by the step that turns their case green. t-1vmjrty (unpushed-delete flag parsing) stays its own fix; its D5 case joins the suite in step 2.

## Migration, in order

Each step is one PR under about 400 changed lines, test-first: its first commit adds the lifecycle cases it turns green, and its body cites their red run on base. A store moves only after the open PRs that touch it merge (#1546 hooks, #1551 ship).

1. **Lifecycle suite and manifest writer.** `test/lane/lifecycle.test.ts`: one real-git fixture (bare origin, clone, real `krn` verbs in process, no stubbed transport, no prior-lane state) walks create, edit, dep, brief, start, scope, stop, ship and drop. GitHub is replaced only where it is the receiver, by a fake built from verbatim captures (KRN-12). Lands green with `src/lane/manifest.ts`, the `STORES` entry, and `krn lane brief`/`krn lane start` writing `reserved` and `started`.
2. **Task storage owner.** `src/task/storage.ts`; the eleven sites move behind it. D7, D8a, D8b, D5, D13.
3. **Hook binding.** `laneOfSession`, the binding write in the PreToolUse Bash hook, scope on it. D4a, D4b.
4. **Stop and claims on the manifest.** `recordedShip`, `laneRecords`, `laneWorktreeIn`, `claimedWorktree` and `ownerCheckout` read the manifest; lane claims move into it, and `claims.ts` reads them there. D3. Their transcript and raw claim reads are deleted.
5. **Ship writes phases.** `shipping`, `shipped`, `merged` and the back-edges; `.krn/tmp/ship.pid` is deleted.
6. **Lane run phases.** `parked` replaces `*.parked`; `verdict.ts` reads `merged`.
7. ADR 0028 step 7: after one prune grace period, `readLane` drops the evidence fallback.

## Consequences

- Proof: the fix commits on the lane and task set fall at least 40% from 129 within two 14-day windows after step 6. Measure: `git log origin/main --since=14.days --format=%s -- src/hook/stop.ts src/hook/scope.ts src/cli/lane.ts src/cli/lane-run.ts src/cli/lane-run src/task src/lane | grep -c '^fix'`.
- Until step 4, Stop keeps its transcript and ship-record reads; a Stop fix in the meantime goes into the manifest path, not a new guess.
- A subagent that never ran `krn lane start --lane` is an unbound worker and cannot write; general-purpose calls routed to `krn-lane` that only read are unaffected.
- The binding depends on the PreToolUse payload carrying `agent_id`; step 3's fixture is a verbatim capture of one.
