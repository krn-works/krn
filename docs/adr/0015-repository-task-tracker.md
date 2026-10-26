# 15. Repository task tracker

Date: 2026-10-25

## Status

Accepted. Supersedes the import clauses of [ADR 0013](0013-repository-consolidation.md) and [ADR 0014 D8](0014-operator-decisions-2026-10-23.md) by operator decision of 2026-10-26 (“Oki spoko”): do not import Paperclip or legacy queue records.

## Context

ADR 0014 D8 selected one Git-backed task tracker because tasks must travel with
their repository. The tracker replaces the legacy Git-ref `krn task` queue and
the host-SQLite `krn work` design recorded in ADR 0011. Paperclip integration
was removed from Product in #109 and from GLOBAL in krn-works/krn-codex-skills #461
(merge 26446dd5).
The tracker starts empty: no Paperclip or legacy queue records are imported.
The format lenses
recommended a file per task: independent task creation remains mergeable, while
edits to the same task remain visible as Git conflicts instead of silently
losing an update.

## Decision

Store each durable task as `tasks/<id>.json` in the repository worktree. Use
canonical UTF-8 JSON with LF, a trailing newline, fixed key order, and sorted,
unique dependencies. New IDs use `t-` followed by seven lower-case Crockford
base32 characters. Compute the task index in memory for each command.
`krn task check` validates task files and references
and runs in the Product gate.
Task files are formatted only by `krn task`.

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

Every claim mutation, including expired-claim removal, takeover, and release,
holds a Linux abstract-namespace Unix socket named from the main checkout's
real path and task id for the full inspect, mutation, and publish operation.
The kernel releases the name on process exit, including `SIGKILL`, so this
single-host tracker needs no lock files or stale-lock recovery; claim mutations
require Linux and a live lock blocks for at most two seconds before returning
exit code 75. Read-only `ready` and `show` commands do not lock or remove
expired claims.

## Routing

The installer-owned GLOBAL `~/.local/bin/krn` forwards `krn task …` to the
Product executable configured by `KRN_PRODUCT_ENTRY` or
`~/.config/krn/product-entry` (GLOBAL #457, #459). On the host, that entry
points to Product `bin/krn`, which runs the Node version pinned in
`.node-version`.

## Consequences and delivery

The format lens's merge table found that separate files keep unrelated task
changes mergeable and make an identical-ID add/add collision visible. A check
is needed because Git can still merge independent field edits into a
semantically invalid record. The shipped CLI provides create, show, list,
ready, claim, release, close, dep, edit, and check. With `--json`, successful
task operations return an object with `ok: true` and command-specific fields;
failures return `ok: false`, a numeric `code`, an `error` message, and optional
`findings`. Help output (`krn task`, `krn task --help`, and
`krn task <verb> --help`) stays plain text, even when `--json` is supplied.
The lead manages task status with `ready`, `claim`, `release`, and `close`.
Workers receive the task id in their brief, never claim tracker work, and use
the id in commit titles and the `Ticket:` trailer. The delivering PR closes the
task. Readiness is read-only and never removes expired claims.

Product forwarding and tracker commands are shipped; per-task claim mutations
use a Linux abstract Unix socket held for the full inspect, mutation, and
publish operation. The kernel releases the lock on process exit (#110).
GLOBAL's Paperclip integration was removed in krn-works/krn-codex-skills #461
(merge 26446dd5). The only remaining Paperclip item is the host service and
data; they remain untouched pending a separate operator decision and grant.
