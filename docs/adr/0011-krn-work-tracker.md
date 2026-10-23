# 11. KRN work tracker

Date: 2026-10-22

## Status

Superseded by ADR 0014 D8.

This ADR remains the historical record of the former host-SQLite design; ADR 0014 D8 replaces its active tracker decision and cutover path.

## Context

**[CODE: GLOBAL ADR 0007]** ADR 0007 made Paperclip the shared tracker. The
operator now wants KRN's own tracker and intends to leave Paperclip. The
accepted direction and sequencing are recorded in
[plan F4/F5](../program/PLAN.md); this ADR fixes the target design
before implementation.

The decision owner is the KRN lead; project operators own individual cutovers.
The decision provenance is operator direction ("no ale generalnie chcielismy
zrobić własny :-(", "ja docelowo tego paperclipa chyba nie chce", and
"jak zrobić lepsze beadsy") and the independent Opus comparison commissioned
by the operator. This record captures the selected design, not implementation
proof. The independent Opus comparison was commissioned by the operator; its
findings are summarized in the 2026-10-22 task brief and were not re-audited
for this ADR.

The consumers are Global KRN's `krn work` and `krn ship`, planned Product
delivery orchestration, and the successor to ADR 0009. This ADR partially supersedes
[GLOBAL ADR 0007](https://github.com/krn-works/krn-codex-skills/blob/0606e4145a2fd1937a6108c76089f219a4617546/docs/adr/0007-paperclip-control-plane.md)'s
Paperclip tracker default only for each project after its explicit cutover.
ADR 0007's PR acceptance and delivery requirements remain in force. Memory
event policy remains under [GLOBAL ADR
0009](https://github.com/krn-works/krn-codex-skills/blob/0606e4145a2fd1937a6108c76089f219a4617546/docs/adr/0009-layered-memory.md)
until a successor adopts task links.

## Decision

Build `krn work` in GLOBAL `scripts/lib/work/`, backed by a host-level SQLite
database shared across projects and partitioned by a `project` column. The
tracker is the work-status authority after a project's cutover. One lead/loop
writer owns all mutations; workers never write the store.

### Work contract and readiness

Each task has acceptance criteria, scoped paths, required checks, and a
`contract_rev`. It remains `draft` until all contract fields are complete. Its
status is one of `draft`, `open`, `claimed`, `blocked`, `done`, or `dropped`;
dropping requires a typed disposition.

Task edges have four types: `blocks` is gating, so a task is ready only when
every `blocks` predecessor is `done`; `parent-child`, `related`, and
`discovered-from` are informational and never gate readiness. An `open` task
is also not ready when its scope paths overlap those of a `claimed` task in
the same project. Order ready tasks by descending priority, then creation
time ascending (oldest first). Claiming uses a lease, heartbeat, and epoch.
Three failed attempts move a task to `blocked`.

Canonical IDs are `KRN-<n>`. An alias table preserves existing `LON-*`
identifiers and later `task-<uuid>` identifiers. Existing `Ticket:` trailers
continue to resolve through `krn work resolve`. The agent-facing read
interface is `krn work next --json`.

### Ownership, history, and delivery

The host SQLite store has one writer. Record each mutation in an append-only,
hash-chained event history with deterministic export and verification. A
journal on `refs/krn/work-journal` and restore are part of S2; exports and
journal replay must preserve verifiable history. The store core is a library
with a stable JSON contract and an event stream with a sequence cursor, so a
future `krn work serve` server/UI can use the same core without duplicating
logic.

For PR work, Global KRN's `krn ship` is the only path to `done`. S4 binds the task and
claim epoch in the delivery record, closes idempotently by `(task, merge)`,
and reads back main CI. The tracker stores digests and links to ship evidence
rather than duplicating its record; task status alone is not merge
acceptance.

The proposed Product `krn deliver` command is not implemented in
`src/cli/main.ts` and currently falls through to Global forwarding. When
implemented, it is designed to consume the tracker through a `WorkTransport`
behind the existing `LedgerTransport` seam in
[`src/ledger/index.ts`](../../src/ledger/index.ts#L202-L215). S8 adds task
links to memory events only through a successor to ADR 0009.

### Migration and rollback

S6 imports Paperclip with dry-run and apply modes and fingerprints the input.
S7 cuts over one project at a time, rehearses rollback, leaves Paperclip
read-only, and removes legacy task/ticket/Paperclip code at cutover. Paperclip
remains the status and acceptance authority until each project's cutover;
transition uses no mirrored writes. The importer preserves existing aliases,
and export/verification provides the history readback. Cutover does not
itself authorize a host-side Paperclip archive action.

### Alternatives and supersession

**[POLICY] Beads itself or a thin adapter loses.** It retains a Dolt
dependency and upstream storage churn. **[OURS-EVIDENCE: independent Opus
comparison, 2026-10-22 task brief]** The reviewed history moved from SQLite to
Dolt and demoted JSONL to export; the comparison also reports recurring
operational complaints in 2026 issues. A thin adapter would preserve those
costs and leave KRN's work contract and delivery semantics dependent on
upstream change. These are findings from that review, not a new benchmark in
this ADR.

**[POLICY] Keeping Paperclip loses.** It conflicts with the operator's stated
direction to leave Paperclip; UI-centered acceptance also leaves the operator
in the middle of routine task progression.

**[POLICY] Reviving the legacy `krn task` Git-ref queue loses.** Its
multi-writer CAS and lease machinery accumulated 17 lease/race fixes, is
per-repository, and does not provide the chosen task contract,
conflict-scope readiness, or delivery evidence semantics. A single writer
does not need that coordination machinery. Keep its useful epoch and attempt
lessons in the new design.

### Devil's-advocate review

**[OURS-EVIDENCE: independent Opus comparison, 2026-10-22 task brief]**
Review-time verdict: **"OTHER (≈75%): delete legacy trackers first, revive
krn task"**. Rejected: a single writer removes the multi-writer race class
behind the legacy queue's 17 lease/race fixes, and that per-repository queue
lacks contract, conflict-scope, and evidence semantics.

| Risk | Mitigation |
|---|---|
| Second-system effect | Keep a small CLI and library core; S7 removes superseded task/ticket/Paperclip code for net-negative cleanup. |
| Tracker fragmentation from per-repository stores | Use one host-level store partitioned by `project`. |
| Sandbox workers cannot safely share the DB | Workers never write the store; only the lead/loop writes. |
| Backup/sync regresses from Git refs | S2 exports hash-chained events and journals them on `refs/krn/work-journal`; verify replay and restore. |
| Agents ignore the tracker | `krn work next --json` is the single entry point; Global KRN's `krn ship` is the done path (S4). |
| Two sources of truth during transition | Paperclip stays authoritative until each project cuts over; do not mirror writes. |
| Tracker sprawl | Require a complete contract before ready (otherwise `draft`); require typed drop dispositions. |
| Duplication with ship records and memory events | Store evidence digests/links; S8 memory events cite task IDs instead of copying tracker records. |

### Slices

1. **S1 — Store and CLI:** host SQLite schema, task contract, statuses, ready
   selection, create/show/ready/claim commands, and `next --json`.
2. **S2 — Journal and restore:** hash-chained events on
   `refs/krn/work-journal`, deterministic export, verify, and restore.
3. **S3 — Resolve:** add `krn work resolve` to Global `krn ship`, PR preflight, and changes
   flows so `Ticket:` trailers remain usable.
4. **S4 — Ship closure:** bind task and epoch to the delivery record; idempotent
   close by task and merge; read back main CI.
5. **S5 — WorkTransport:** adapt the planned Product `krn deliver` command through the existing
   `LedgerTransport` seam.
6. **S6 — Paperclip importer:** fingerprinted dry-run and apply.
7. **S7 — Project cutover:** cut over one project at a time, keep Paperclip
   read-only, rehearse rollback, then remove superseded legacy code.
8. **S8 — Memory successor:** link task identity into memory events under a
   successor to ADR 0009.
9. **S9 — Agent harness work:** create harness-specific work from closed tasks.

## Consequences

**[POLICY]** The second-system risk is limited by a small CLI, one writer, and
net-negative cleanup of legacy task/ticket/Paperclip code at cutover. Agent
adoption is supported by `next --json` and ship-driven closure. F2 sandbox
sequencing is unchanged because workers never write the store.

The operator has not decided whether a board UI is needed or CLI/JSON is
sufficient. The Paperclip archive form at cutover is also an open host action
for the project operator. Neither question changes the tracker contract or
grants archive authority.
