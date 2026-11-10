# 16. The pull request is the delivery record

## Status

Accepted by the operator's order of 2026-11-10 ("Architecture program order" in [ADR 0014](0014-operator-decisions-2026-10-23.md)), which accepts the architecture program's recommendations; its evidence is local lead records in `.krn/runs/krn-architecture-program/` (`04-spikes.md`, `05-program.md`).

Date: 2026-11-10

## Context

- ADR 0001:18 names `ledger` and `trace` among the package's modules. KRN since built and deleted an append-only
  trace, a resumable slice journal and a red-first check (`02-patterns.md` section I). What remains is
  `src/outcome` (`krn ledger`), added on 2026-11-06 as an accepted-outcome ledger per merged PR.
- GitHub already records what a delivery store would hold: the PR, its head commits, its check runs, the merge.
  A patch of 319 added lines made `krn ledger` print PRs, spend and the task join for a window, equal to the cent
  to `scripts/claude/spend-window.py` on two windows, with three known PRs joined to the right task
  (`04-spikes.md` (b); re-run with `--root` at the main checkout, `verify-05-numbers.md` V10).
- The one argument for a local journal is lane work that is lost before it becomes a PR. Of $290.78 of lane spend
  (225 transcripts), $13.42 never reached a merged PR: 4.6% outside experiments, 5.7% if lanes with an unknown
  branch are counted as lost, and 0 to 0.5% since 2026-11-06 (`04-spikes.md` (i); total re-summed from the
  spike's data in session 6). The measure is at branch level: a lane counts as merged when its branch has a merged
  PR, so work redone inside a branch is not seen.
- A task is not a PR: of the last 100 merged PRs, 12 of 70 tasks took more than one PR and 2 PRs named no task.

## Decision

1. A delivery is a pull request and is identified by its number. A task (`tasks/<id>.json`) is the outcome; a task
   may take several deliveries.
2. KRN keeps no delivery store. `src/outcome` derives deliveries, outcomes and windows from GitHub and git when
   asked. A cache is allowed if it is keyed by PR number and can be deleted without loss.
3. The join is one task id in the PR title, repeated in the commit trailers (`Ticket:` closes the task, `Refs:`
   leaves it open). The gate enforces it (the gate-path report of the architecture program); it is not a convention.
4. `src/outcome` keeps two adapters, GitHub and a verbatim capture of its output (KRN-12), and no third.
5. A local journal of lane or delivery events is not built. The question reopens only if lane spend lost at branch
   level exceeds 10% over 100 merged PRs, measured as in `04-spikes.md` (i).
6. This supersedes the `ledger` and `trace` entries of ADR 0001:18 as far as they imply a KRN-owned record.

## Consequences

- Deleted with the first slice that implements this: the ledger's regex attribution and the second price table.
- State in flight stays in the session and in `.krn/`, derived and disposable. No crash that lost a delivery is on
  record; if one occurs it is evidence for point 5.
- Work that never becomes a PR is invisible by design and is sampled, not recorded.
- A GitHub outage stops measuring; it already stops shipping.
- A silent defect scores as success: only reverts and main reds are seen (0 and 2 in the last 100).
