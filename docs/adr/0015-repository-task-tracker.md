# 15. Repository task tracker

Date: 2026-10-25

## Status

Accepted. Supersedes the import clauses of [ADR 0013](0013-repository-consolidation.md) and [ADR 0014 D8](0014-operator-decisions-2026-10-23.md) by operator decision of 2026-10-26 (“Oki spoko”): do not import Paperclip or legacy queue records.

Amended on 2026-11-08 by the lead under the operator's full project control
grant of 2026-11-03, which covers ADR amendments: a claim whose worktree has
closed the task stays live while the task is in delivery, and CI refuses a
pull request whose `Ticket:` task stays open.

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
and runs in the Product gate. In pull requests CI runs it with `--base` and
`--head`, which also refuses a branch whose commits carry `Ticket: <id>` while
that task is open or missing on the branch.
Task files are formatted only by `krn task`.

Records contain open or closed status, typed closure resolution, creation date,
priority, title, blocking `after` dependencies, and paragraph body text. Ready
tasks are open, have every `after` dependency closed as `done`, and have no live
claim. Order them by ascending priority, creation date, then id. Closing a
dependency as `dropped`, `duplicate`, or `superseded` does not unblock it;
`krn task check` refuses an open task still ordered after such a dependency.

Claims stay outside tracked task records, in
`.krn/task-claims/<id>.json` under the main checkout shared by linked
worktrees. Each canonical claim records its id, actor, real worktree path,
branch, UTC claim time, and optional reason. Create claims by staging under the
main checkout's `.krn/tmp/task-write/` and using an exclusive hard link; never
stage files inside the claim directory. A claim is live only while its worktree
exists and is registered, its branch still exists, its task file exists in the
worktree, and `origin/main`, when that ref contains the task, still has it
open. A task closed in the worktree is in delivery: its claim stays live until
the merge closes the task in `origin/main` or the worktree or branch goes away,
so `ready` and `claim --next` never offer work whose closing PR is still open.
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
expired claims; `ready` removes only claims whose task the main checkout
records as closed.

## Routing

On the host, `~/.local/bin/krn` links to the pinned Product entry (t-ez3nsc3;
until then the GLOBAL release forwarded `krn task …` through `KRN_PRODUCT_ENTRY`
or `~/.config/krn/product-entry`, GLOBAL #457, #459). That entry is Product
`bin/krn`, which runs the Node version pinned in
`.node-version`. The entry must not be the lead working checkout, whose commit
moves with every branch switch. `scripts/product-release.sh` keeps a detached
worktree at `.krn/product-release` on `origin/main`; `krn ci wait` runs it once
it observes an auto-merged PR merge, and the entry points at it via
`scripts/product-release.sh --entry`. The candidate must pass `bin/krn doctor`
before it stays; a failed smoke restores the previous commit, names it and
exits 78. Its default output prints the entry path, the previous commit and the
pinned commit. A forwarded `krn task`
(`KRN_FORWARDED` set) fails closed with exit 78 when its checkout is not the
pinned worktree or its HEAD differs from the local `origin/main`, naming both
commits, the refresh command and a `which -a krn` hint. `krn doctor` reports
the configured entry, its commit and `origin/main`, with the same exit.

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
task; a PR that leaves the task open carries `Refs: <id>` instead of `Ticket:`.

Product forwarding and tracker commands are shipped; per-task claim mutations
use a Linux abstract Unix socket held for the full inspect, mutation, and
publish operation. The kernel releases the lock on process exit (#110).
GLOBAL's Paperclip integration was removed in krn-works/krn-codex-skills #461
(merge 26446dd5). The host Paperclip service and data were removed on operator
order on 2026-10-27, without an archive.
