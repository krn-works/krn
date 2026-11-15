# 18. Task storage: one file per open task, monthly archive for closed tasks, categorised records

Date: 2026-11-15

## Status

Accepted. Amends [ADR 0015](0015-repository-task-tracker.md) in four places:
- where closed tasks are stored;
- the record fields;
- the claim lock;
- comments, which are removed (this ends the [ADR 0014](0014-operator-decisions-2026-10-23.md) D29 exception).

The file-per-task decision of ADR 0015 is reaffirmed. A single JSONL file, SQLite and Dolt are rejected at KRN's scale.

## Context

- The operator asked whether one `.jsonl`, as in Beads, would be better. The evidence says no.
  - Beads needed a custom merge driver for its JSONL and then left JSONL for Dolt. Its documented costs were "merge conflicts, no concurrent access, no query capability" (judge-J4 F2).
  - A merge driver lives in per-clone git config. KRN merges through GitHub auto-merge, which never runs one (judge-J4 F2).
- Shared single files are what conflict here.
  - `roadmap.md`, `spec/context-budget.json` and the generated capability index each needed fix PRs (judge-J4 F1).
  - `package.json` conflicted 168 times.
  - Task files conflicted on rebase 4 times across 999 task-touching commits: t-8k6n32d, t-mr1a70f, t-ve0zsvy and t-a5z5yqn (judge-J10 section 1).
  - J4's "0 per 999" is wrong, because its method could not see rebase conflicts. The corrected rate is about 0.4%.
- Slowness is code, not format. `task show` takes 1.39 s and `ready` 1.27 s with only 0.47 s of user CPU. The time goes to a full scan of 922 files plus `spawnSync` git calls (judge-J4 F3).
- The directory grows about 55 files a day. 913 of 922 tasks are closed and never change again (map.md).
- The graph and categories are thin (judge-J4 F4, judge-J7 F6):
  - 115 of 922 tasks use `after`;
  - 1 of 922 has `acceptance`;
  - no task has a kind, area, stack or origin.

  The operator asked for "skategoryzowanych tasków".
- Unused parts (judge-J4 F5):
  - `comments.ts` is 163 lines with zero comment files;
  - the abstract-socket lock sits on top of an exclusive hard-link create that is already atomic, and makes claims Linux-only.
- Tracker bookkeeping is 247 `chore(tasks)` commits in 14 days, 19% of all commits (research-health.md, slop item 1).

## Decision

1. **Open tasks: one file each, `tasks/<id>.json`, as today.**
2. **Closed tasks: archived.**
   - A task closed for more than 14 days moves into `tasks/archive/<YYYY-MM>.jsonl`.
   - The month is the task's immutable `created` month. There is one record per line, sorted by id.
   - Placement is a pure function of the record, so two archive runs produce identical bytes.
   - The lead's retro runs `krn task archive`. It is the only writer.
   - `show`, `list --closed`, `Ticket:` checks and precedent read both places.
   - There is no summarising compaction. Full closed records are the corpus the brain mines.
3. **Single-task commands read one file.** `show`, `close`, `edit` and `claim <id>` open `tasks/<id>.json` directly and fall back to the archive. `ready` computes git facts once per call.
4. **Four new optional fields in `krn.task/v1`.**
   - `kind`: `feature | defect | debt | gate | chore | research`.
   - `area`: the owning areas of the functional map.
   - `stack[]`: the same vocabulary as record `applies.stacks`.
   - `from {kind: inbox | finding | outside-row | task | candidate, ref}`.

   No `related` or parent-child edges are added. `krn task create` requires `kind` and `area` for new tasks. Old tasks are not back-filled.
5. **Task and brain are joined at claim and at close** (retrieval budget in ADR 0020, evidence rules in ADR 0019).
   - `krn task claim` prints acceptance clauses derived from the brief, plus the top precedent records matched by `stack` and `area`. It stores the clause ids on the task.
   - `krn task close --as done` appends the outcome to each exposed record's exposure row: PR, CI conclusion, and the hidden-test result when present.
6. **Claims keep the exclusive hard-link create and the liveness check.** The abstract-socket lock and `lock-host.ts` are deleted once a race test shows the link alone refuses a double claim.
7. **Deleted:** `src/task/comments.ts`, its tests and the `merge=union` line in `.gitattributes`. Notes go in `body`.
8. **Task bookkeeping rides in delivering PRs.** A task is created in the PR that plans it (the plan or retro PR) or in the PR that discovers it. It is closed in the PR that delivers it. A standalone `chore(tasks)` PR is for operator-inbox intake only.

## Expected effect

- `ls tasks/*.json | wc -l` drops from 922 to under 80. Measure: that command.
- `krn task show <id>` drops from 1.39 s to under 0.45 s, and `krn task ready` from 1.27 s to under 0.5 s. Measure: `time bin/krn task show t-jgent6a`, `time bin/krn task ready`.
- Task-file conflicts stay at or under 1 per 200 task-touching PRs. Measure, monthly: transcript grep for rebase conflicts naming `tasks/`, plus ship exit-76 events with `tasks/` in the dirty paths.
- Within 4 weeks, at least 80% of new tasks carry `kind` and `area`, and at least 50% carry `from`. Measure: `krn task list --json --since <date>` piped to a count.
- The share of commits titled `chore(tasks)` falls from 19% to under 8% over the next 14 days. Measure: `git log --since=14.days --format=%s | grep -c '^chore(tasks)'` over the total.
- The share of done tasks with stored clause ids rises from 0.1% to at least 70% within 4 weeks. Measure: `krn task list --json --closed --since <date>`.

## Consequences

- `src/task` loses about 550 lines: comments, the socket lock and `lock-host.ts`.
- `src/cli/decide.ts` (216 lines) is deleted by ADR 0019. Decisions are records, not tasks.
- `scripts/task-quality.ts` and `src/brain/task-quality.ts` become validation inside `src/task`, with one check instead of two.
- The seven `task-quality` records leave the standards pack.
- A CI test closes a task, archives it and validates a PR carrying its `Ticket:`, so archiving cannot break the base/head check.

## Falsified if

- Two or more same-task conflicts occur in a month. The response is git-bug-style operation logs under `refs/`, not a JSONL file.
- `ready` stays above 2 s after points 2 and 3. The response is a derived index cache that git ignores, with git still the source of truth.
- Fewer than 10% of new tasks carry `from` after 4 weeks. Then the field is deleted.
- Any double claim appears in the claim directory after the socket lock is removed. Then the lock returns.
- Archiving causes a false `Ticket:` refusal in CI. Then the archive is reverted until the guard test covers the case.
