# 15. Repository task tracker

Date: 2026-10-25

## Status

Accepted.

## Context

ADR 0014 D8 selected one Git-backed task tracker because tasks must travel with
their repository. The tracker replaces the legacy Git-ref `krn task` queue and
the host-SQLite `krn work` design recorded in ADR 0011. The format lenses
recommended a file per task: independent task creation remains mergeable, while
edits to the same task remain visible as Git conflicts instead of silently
losing an update.

## Decision

Store each durable task as `tasks/<id>.json` in the repository worktree. Use
canonical UTF-8 JSON with LF, a trailing newline, fixed key order, and sorted,
unique dependencies. Imported IDs remain unchanged; new IDs use `t-` followed
by seven lower-case Crockford base32 characters. Compute the task index in
memory for each command. `krn task check` validates task files and references
and runs in the Product gate.

Records contain open or closed status, typed closure resolution, creation date,
priority, title, blocking `after` dependencies, and paragraph body text. Ready
tasks are open, have every `after` dependency closed as `done`, and have no live
claim. Order them by ascending priority, creation date, then id. Closing a
dependency as `dropped`, `duplicate`, or `superseded` does not unblock it.

Claims stay outside tracked task records, in
`.krn/task-claims/<id>.json` under the main checkout shared by linked
worktrees. Each canonical claim records its id, actor, real worktree path,
branch, UTC claim time, and optional reason. Create claims by staging under the
main checkout's `.krn/tmp/task-write/` and using an exclusive hard link; never
stage files inside the claim directory. A claim is live only while its worktree
exists and is registered, its branch still exists, and the task remains open
in the worktree when its task file exists there and in `origin/main` when that
ref contains the task.
Claims outside those conditions are expired. Corrupt or unreadable claim files
are treated as live and reported, so only `release` or a reasoned `--takeover`
removes them. A live claim blocks another claim with exit code 75; takeover
requires a reason.

## Consequences and delivery sequence

The format lens's merge table found that separate files keep unrelated task
changes mergeable and make an identical-ID add/add collision visible. A check
is needed because Git can still merge independent field edits into a
semantically invalid record. The task CLI provides create, show, list, edit,
close, dep, ready, claim, release, and check commands. Readiness is read-only
and never removes expired claims.

1. Task records and validation (merged in #102).
2. Readiness and claims.
3. Connect PR preflight to `tasks/` instead of Paperclip.
4. Update GLOBAL forwarding to Product `krn task` under install/seal grant.
5. Remove the legacy queue and `krn work`; preserve legacy refs as a Git bundle
   under `.krn/archive` without importing them.
6. Remove Paperclip from Product.
7. Remove Paperclip from GLOBAL under its separate host-service grant.

The tracker starts empty. Do not import Paperclip records or legacy queue
records; Paperclip data on the host remains untouched unless the operator gives
a separate grant.
