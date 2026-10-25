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
priority, title, blocking `after` dependencies, and paragraph body text. Claims
and other volatile coordination state stay outside tracked task records and
are deferred to a later change.

## Consequences and sequence

The format lens's merge table found that separate files keep unrelated task
changes mergeable and make an identical-ID add/add collision visible. A check
is needed because Git can still merge independent field edits into a
semantically invalid record. This change supplies the record model, CRUD and
dependency CLI, and validation; it does not add readiness or claims.

Remaining sequence: add ready and claim; import Paperclip records; commit the
imported data; connect PR preflight; import the legacy queue; update GLOBAL
forwarding; remove the legacy queue and `krn work`; then remove Paperclip from
Product and GLOBAL under their respective delivery authority.
