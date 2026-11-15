# 19. One record store for durable knowledge, and a remember loop fed only by evidence

Date: 2026-11-15

## Status

Accepted. Amends [ADR 0002](0002-brain-v2.md):
- the record types it listed but the schema refused are added;
- the "supersession write path" trigger is declared fired;
- the retire rule defers to [ADR 0021](0021-proof-methodology.md).

[ADR 0014](0014-operator-decisions-2026-10-23.md) stays the authority for operator decisions D1–D37. This ADR only fixes where they are queryable. The `krn decide` store and `.krn/runs/lead/decisions.md` are superseded.

## Context

- Six stores hold durable knowledge, and none can hold another's content (judge-J2 F1):
  - Claude auto-memory (49 files);
  - capsule and handoff (`state.md`, 10,120 bytes);
  - `.krn/operator/inbox.jsonl` (582 lines);
  - `standards/records.json` (117 records);
  - `.krn/runs/lead/decisions.md`;
  - ADR 0014.

  `src/brain/record.ts` allows only `standard | convention | pitfall | recipe`, so an operator decision cannot enter the brain.
- Auto-memory drifts (judge-J2 F2): 11 dangling links, `decisions-register.md` stops at D30 while ADR 0014 reaches D37, and no file has `valid_to`.
- The inbox is 31% agent text: 182 of 582 lines are relay prompts or harness blocks recorded as operator intent (judge-J2 F3).
- Supersession has never been used (judge-J2 F4, verified in judge-J10 section 1):
  - 0 of 117 records have `supersedes`;
  - 84 are copies of AGENTS.md rules;
  - 4 retirements were made by hand and 0 by measurement.
- Agents do not pull memory on their own. `krn standards query` was typed once in 58 exposures (judge-J2 F5, judge-J3 F4). Agent-edited memory in the Letta or mem0 style is scored on chat recall, not on coding correctness (sota.md section 2). ACE shows that weak feedback pollutes a playbook and that wholesale rewrites collapse it.
- Red-team corrections (judge-J10 sections 2 and 3):
  - Decisions need validity and supersession, so they belong in the record schema. But they must never be served in packets, because ranking already cannot tell records apart.
  - Stop refusals must not create candidates: 83% of recent ones were false.
  - A PR-failing curation check is a gate in KRN's own delivery, which the north star excludes.

## Decision

1. **One schema, `krn.record/v1`, for everything durable.**
   - Types: `standard | convention | pitfall | recipe | decision | preference | fact`.
   - New fields:
     - `subject`: the conflict key.
     - `evidence_kind`: `operator-verbatim | ci | hidden-test | review | agent`.
     - `superseded_by`.
     - `review_by`: a date.
2. **Three tracked files, split by who is served.**

   | File | Holds | Served at push moments |
   |---|---|---|
   | `standards/records.json` | universal pack | yes |
   | `.agents/records.json` | this repository's conventions, pitfalls, recipes | yes |
   | `.agents/decisions.json` | decisions, preferences, facts, grants | never; query only (`krn standards query --type decision`) |

3. **What holds what.**

   | Knowledge | Home | Expiry |
   |---|---|---|
   | Standards, conventions, pitfalls | the two served files | by measurement (ADR 0021) or `review_by` |
   | Decisions, preferences, grants, facts | `.agents/decisions.json`, citing the ADR anchor instead of copying it | `superseded_by` or `valid_to`; never deleted |
   | Session state | the capsule: pointers only (task id, HEAD, blockers, record and PR ids), at most 2 kB | overwritten each handoff |
   | Work | `tasks/` (ADR 0018) | closure |
   | Direction | `docs/program/plan.md` (ADR 0024) | edited by plan PRs |
   | Raw events (operator prompts, exposures, CI and review findings) | `.krn/operator/inbox.jsonl`, `.krn/brain/exposures.jsonl`; gitignored, never served | disposable |
   | Claude auto-memory | an inbox, not an authority | each file reduces to a one-line pointer to a record id once absorbed |

4. **Writes are deltas through the CLI.**
   - The only operations are ADD, SUPERSEDE (old gets `valid_to` and `superseded_by`), RETIRE (`valid_to`) and REVIEW (`review_by` moved).
   - Nobody rewrites a file wholesale or removes a row.
   - This is not a PR gate. `krn standards check` reports removed ids and a shrink of more than 15% as findings in the existing check output.
5. **Remember loop.**
   - A candidate `trial` record is proposed only from evidence of four kinds: a CI failure, a failed hidden test on an outside row, a review finding, or an operator correction quoted verbatim.
   - Stop refusals are not a source.
   - The candidate carries the event reference and a `subject`. A match on `subject` makes it a supersede proposal; otherwise it is an add.
   - The lead or Fable accepts.
   - A record with `evidence_kind: agent` is never accepted without a second, independent event.
6. **Pack hygiene.**
   - Records that restate an AGENTS.md rule keep their check, but are not served as text at the session or lane moment. This covers `r-required-check`, `r-regression-layer`, `r-receiver-tests`, `r-bounded-context` and the rest of the 84 "krn pack" copies.
   - KRN-process records leave the universal layer: `s-no-shared-stash`, `s-agent-state`, `s-finish-gate`, `s-ticket-trailer`.
   - Each of the 31 advisory records gets a check or a `review_by` within 30 days.
7. **Inbox hygiene.** The inbox writer drops harness blocks and tags sessions started by `successor-launch` as `origin: agent`. Only `origin: operator` rows count as operator intent.
8. **No external memory system.** Letta, mem0, Zep and A-MEM are not adopted. SQLite/FTS5 stays behind ADR 0002's trigger.

## Expected effect

- Durable-knowledge stores go from 6 to 1 schema in 3 files. Measure: `krn standards query --type decision "auto-merge" --json` returns rows citing ADR 0014 anchors; `test -e .krn/runs/lead/decisions.md` fails; `git grep -c decide src/cli/index.ts` is 0.
- Dangling memory links go from 11 to 0, and `decisions-register.md` is gone. Measure: the SessionStart memory check prints 0 findings.
- Agent text counted as operator intent falls from 31% to under 2% over the next 200 inbox rows. Measure: `grep -c '"origin":"agent"'` against harness-pattern rows among `origin: operator` rows.
- The capsule falls from 10,120 bytes to at most 2,048. Measure: `wc -c .krn/runs/delivery-loop/session-continuity/state.md`.
- The record count moves in both directions within 30 days: at least 5 records get `valid_to` or `superseded_by`, and at least 5 trial records are proposed from evidence. Measure: `git log -p --since=30.days -- standards/records.json .agents/records.json | grep -c '"valid_to"\|"superseded_by"'`, and a count of `status: "trial"`.
- At least 30% of trial records are accepted within 4 weeks of proposal.

## Consequences

- Deleted:
  - `src/cli/decide.ts` (216 lines) and its tests;
  - `.krn/runs/lead/decisions.md` and the 13 `d-*.json` rows, after migration;
  - auto-memory `decisions-register.md`;
  - the capsule fields "Outstanding workflow-run cleanup" and the closed-task log.
- `src/memory/memory-refs.ts` (319 lines, 12 finding kinds) shrinks to a link and coverage check of about 60 lines.
- `src/context/restart.ts` and `src/successor/handoff-requests.ts` read decisions through the brain module.
- The three standards CLI entry points merge into one router: `standards-cli.ts`, `standards-ledger.ts` and `standards-tasks.ts`.
- No `krn memory` verb is added. Absorbing auto-memory is a one-time lead action using `krn standards propose`.

## Falsified if

- Fewer than 20% of trial records are accepted after 4 weeks. Then candidates are restricted to hidden-test and CI events only.
- Arm B (a static instruction file) matches arm C on hidden-test pass rate in the ADR 0021 run. Then the store's value is bookkeeping, and it shrinks to a link-checked file plus the Stop checks.
- Decision rows start appearing in served packets (any exposure row with a `decision` id). Then the file split failed, and the type filter moves into the packet builder with a test.
- Operator preferences are lost because no verbatim quote exists (2 or more inbox corrections of the kind "I already told you"). Then an `operator-confirmed` evidence kind is added.
