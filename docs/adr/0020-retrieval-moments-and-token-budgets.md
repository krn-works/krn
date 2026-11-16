# 20. Retrieval at four moments with a token budget each, keyed by the task

Date: 2026-11-15

## Status

Accepted. Amends [ADR 0002](0002-brain-v2.md): the 2,000-token packet budget is replaced by per-moment budgets, and the session query is the task. Supersedes the capability-index SessionStart injection (#752). Implements north-star items 1 to 3.

## Context

- The lead's start grew to about 21 KB, or 5.3k tokens. The SessionStart hook alone injects 14,344 bytes, of which the capability index is 9,353 (judge-J3 F1).
- Nothing reads the index. There were 0 Read or Grep calls on it since it shipped, 17 of 17 lead starts carried it, and 66 commits touched the generated file (verified in judge-J10 section 1). The argument that carries is attention (Gloaguen, arXiv 2602.11988), not cache cost.
- The "task-scoped" block is static (judge-J3 F2):
  - the session query is the branch name plus a directory listing;
  - all 11 session exposures served the same 8 records;
  - `applies.terms` is filled in 0 of 136 records, so ranking cannot tell tasks apart.
- The lane packet is nearly static too: 18 distinct records across 8 unrelated tasks, and a lead-only rule reaches workers (judge-J3 F3).
- Moment-of-need retrieval exists but barely runs. Exposures by channel are lane 45, session 11, edit 2, query 1. Agents typed `krn standards query` 0 times in 39 sessions (judge-J3 F4, judge-J2 F5).
- Injected state contradicts the tracker: a "closed:" line and an "Open claim" line for the same task. Disk-pressure lines are sent to the model (judge-J3 F5).
- Unmeasured context files are neutral to harmful and cost more than 20% (sota.md section 4).

## Decision

1. **Budgets.** Each is enforced by a test that runs the hook on a fixture and counts bytes (tokens = bytes/4).

   | Moment | Carrier | Content | Budget |
   |---|---|---|---|
   | Always loaded | AGENTS.md | rules only | ≤ 600 tokens |
   | Session start, lead | SessionStart hook | plan pointer `plan.md@<hash>` plus current slice line (≤ 150), handoff resume and claimed task (≤ 650), task packet (≤ 400) | ≤ 1,200 tokens total |
   | Session start, worker | — | nothing; the worker gets the packet in its brief | 0 |
   | Task start | `krn task claim`, lane brief | acceptance clauses from the brief, top precedent, scoped records | ≤ 400 tokens |
   | Before editing a new file kind or stack | PreToolUse edit hook | records scoped to that kind; once per kind per session | ≤ 150 tokens |
   | Before Stop | Stop hook | nothing on pass; only the violated records on refusal | 0 / ≤ 250 tokens |
   | Any time | `krn standards query "<what I am doing>"` | ranked, scoped answer; at most 5 hits | ≤ 400 tokens |

   `krn adopt` honours the first row (ADR 0023, north-star item 2: the brain serves records at the moment of need): the block it writes into AGENTS.md holds the delivery rules and names the `standards` skill and `krn standards query`, never the record list, and it is left out when a test of the repository caps the file below the block.

2. **The query is the task, or nothing is injected.**
   - Session and lane packets build their query from the claimed task's title, Outcome, Files, `stack`, `area` and touched paths.
   - With no claimed task, no standards block is sent.
3. **Records carry retrieval keys.**
   - Every in-force record gets `applies.stacks`, `applies.paths` and `applies.terms`.
   - A record with empty keys is served only at Stop.
   - Audience is honoured: `r-bounded-context` becomes `lead`.
4. **Retrieval is evaluated.**
   - `evals/retrieval/cases.json` holds 30 cases of (task text, files) mapped to the record ids actually violated. They are mined from review findings, CI failures and true Stop refusals.
   - `recall@5` is reported for the query, the packet and the edit moment.
   - A retrieval change ships only if it does not lower recall@5.
5. **One universal skill, `standards`.** It is a thin router that says when to call the query tool. It is the same file in KRN and in every adopted repository, and KRN installs it on itself. Per-language prose skills are harvested into stack-tagged records and removed (north-star item 2).
6. **Pull is a hypothesis with a stop rule.** If query calls stay below 0.2 per interactive session two weeks after the skill ships, no further work goes into pull (no MCP server, no skill tuning) and KRN relies on the three push moments. An MCP `standards_query` tool is built only if the stop rule is passed and a second harness needs it.
7. **Removed from the model's context:**
   - the capability index;
   - disk-pressure lines, which move to the status line and `krn doctor`;
   - "closed:" request lines;
   - any claim line that disagrees with `tasks/*.json`.
8. **`context-gauge` is registered once, on PostToolUse** (ADR 0022).

## Expected effect

- Lead SessionStart hook output falls from 14,344 bytes to at most 4,800. Measure: `node src/dispatch/main.ts session-start < test/fixtures/claude/session-start.json | wc -c`, and `.krn/runs/startup-context/measure.py 30` before and after.
- Mean Jaccard overlap of served record sets between sessions on different tasks falls from about 1.0 to under 0.4. Measure: `krn standards effect --overlap` over `exposures.jsonl`.
- `applies.terms` or `applies.paths` filled goes from 0 of 136 to 100% of in-force served records. Measure: `node -e` count over the two served files.
- recall@5 is reported, and reaches at least 0.6 on the 30 cases for the task-start packet. Measure: `node evals/retrieval/run.ts` prints one line per moment.
- Edit-moment exposures rise from 2 in total to at least 30 a week at lane traffic. Measure: `grep -c '"channel":"edit"' .krn/brain/exposures.jsonl`.
- Conflicts on a generated tracked file fall to 0. Measure: ship exit-76 count.

## Consequences

- Deleted:
  - `scripts/claude/capability-index.ts` (167 lines), `docs/generated/capability-index.md`, its test, its SessionStart entry and its call in `fast-check.ts`;
  - `src/context/replay.ts` and `src/context/report.ts`, with `scripts/claude/context-replay.ts`, `context-report.ts` and the `context:report` npm script;
  - `src/context/disk-pressure.ts` wiring in restart (the module moves to doctor).
- `.agents/skills/typescript` and the per-stack prose skills are harvested into records and removed from the installed set. `architecture` stays as a procedure skill.
- `src/hook/session-start.ts` and `src/context/restart.ts` take the task as input.
- `spec/context-budget.json` becomes the single budget table that the tests read.

## Falsified if

- Index holdout: for two weeks the index is injected on even session ids only. If the off arm shows at least 2 more operator corrections of the kind "the lead did not know its own code", or a higher median of warm-up turns than the on arm, a shorter index returns (at most 1,500 bytes).
- Served-set overlap stays above 0.7 after points 2 and 3. Then the ranker, not the keys, is the fault, and FTS5 (ADR 0002's trigger) is pulled forward.
- recall@5 for the task-start packet is below 0.3. Then acceptance clauses and precedent are served without scoped records until ranking is fixed.
- Arm B is at or above arm C on hidden tests at lower cost (ADR 0021). Then retrieval shrinks to the Stop checks.
