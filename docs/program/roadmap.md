# Improvement roadmap

Generated from the open tasks in `tasks/` by `node scripts/claude/roadmap-prune.ts`; do not edit by hand. Rank is the task priority (1 first), then the task id. Change the ranking, title or evidence by editing the task (`krn task`), and run the script in the same change; `--check` prints `in-sync` when the file matches the tasks. The handoff's `## Resume` carries `- Roadmap: <task ids changed>` or `- Roadmap: unchanged (<reason>)`; `scripts/claude/handoff-requests.ts` refuses a handoff without that line or naming an id with no task file. The proactive refill scan runs `krn-radar` and files each pattern as a task, which then appears here.

| Task | Priority | Opportunity | Evidence |
|---|---|---|---|
| t-d2h3m4w | 1 | KRN-11 and lanes.md agree on who closes a task in a lane PR, and the lane brief prints it | KRN-11 (AGENTS.md/CLAUDE.md) says workers MUST NOT mutate tracker state, while .agents/skills/krn-lead/lanes.md line 7 tells lanes to close their task inside the worktree, and CI task check rejects a… |
| t-db6tyeb | 1 | Twenty tasks are delivered by record and the lead-cost verdict is recorded | the lead costs $0.87 per PR over 18.6 turns (`krn ledger --last 20`); the task-record shape is unproven on live delivery. |
| t-1y29yhq | 2 | FR-40 arm C measures the conventions packet against the instruction file alone | memory audit: FR-40 compared packet vs none and vs static standards, never vs the repository instruction file alone, which already carries most rules (lanes arm A 75%). |
| t-czn62h3 | 2 | A worker proves a failing reproduction test before its fix and ends on green | Agentless reproduction+regression selection 25.67 -> 32.0; TestPrune +4.8 pp; R2E-Gym verifier 42.9 -> 51.0 (papers.md). A red test, not tracker state, defines done. |
| t-wtcdg41 | 2 | krn lane start admits parallel lanes on one task the lead already claimed | lanes refactor-successor and refactor-misc for t-5wzk8zf found `krn lane start` refusing because lane refactor-context held the claim, and created worktrees by hand with git worktree add (skipping fe… |
| t-aj36bdz | 3 | Mutation samples run on a schedule over the touched critical modules | ARCH:177, DEC:90 |
| t-gm98qy4 | 3 | README, CONTEXT and per-verb help name every command, flag and krn.json field | CAP:133, CAP:105-109 |
| t-mmyjfjn | 3 | ci.yml names the rules check once the App can write workflows | the ship of t-4p169xy exited 83 on a real push of the .github/workflows/ci.yml:67 comment fix: the KRN GitHub App token lacks Workflows (write), so no KRN session can edit workflow files. |
| t-p70b19s | 3 | The D23 confirmatory run compares a frozen K with PB on clean units, two runs each, with an equivalence test | D23 v2 run1 (t-cbwqm50, diagnostic, harness 27fe971) put K at +8.9 pp over PB (same requirements text, plain harness) over 56 units, CI [-2.5, 20.4], p=0.127: suggestive, not shown. K has since chang… |
