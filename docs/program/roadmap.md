# Improvement roadmap

Generated from the open tasks in `tasks/` by `node scripts/claude/roadmap-prune.ts`; do not edit by hand. Rank is the task priority (1 first), then the task id. Change the ranking, title or evidence by editing the task (`krn task`), and run the script in the same change; `--check` prints `in-sync` when the file matches the tasks. The handoff's `## Resume` carries `- Roadmap: <task ids changed>` or `- Roadmap: unchanged (<reason>)`; `scripts/claude/handoff-requests.ts` refuses a handoff without that line or naming an id with no task file. The proactive refill scan runs `krn-radar` and files each pattern as a task, which then appears here.

| Task | Priority | Opportunity | Evidence |
|---|---|---|---|
| t-db6tyeb | 1 | Twenty tasks are delivered by record and the lead-cost verdict is recorded | the lead costs $0.87 per PR over 18.6 turns (`krn ledger --last 20`); the task-record shape is unproven on live delivery. |
| t-1y29yhq | 2 | FR-40 arm C measures the conventions packet against the instruction file alone | memory audit: FR-40 compared packet vs none and vs static standards, never vs the repository instruction file alone, which already carries most rules (lanes arm A 75%). |
| t-czn62h3 | 2 | A worker proves a failing reproduction test before its fix and ends on green | Agentless reproduction+regression selection 25.67 -> 32.0; TestPrune +4.8 pp; R2E-Gym verifier 42.9 -> 51.0 (papers.md). A red test, not tracker state, defines done. |
| t-5wzk8zf | 3 | One refactor pass removes duplicated helpers, unchecked JSON boundaries, scripts logic and cli cycles after the adoption census | Fable plan 1114c merged t-rd8zndx, t-x4yx6df, t-x7nqpz9, t-mcfrwdf and t-15w1zrz into one refactor held until the adoption census shows which seams outside repositories stress. |
| t-aj36bdz | 3 | Mutation samples run on a schedule over the touched critical modules | ARCH:177, DEC:90 |
| t-gm98qy4 | 3 | README, CONTEXT and per-verb help name every command, flag and krn.json field | CAP:133, CAP:105-109 |
| t-mmyjfjn | 3 | ci.yml names the rules check once the App can write workflows | the ship of t-4p169xy exited 83 on a real push of the .github/workflows/ci.yml:67 comment fix: the KRN GitHub App token lacks Workflows (write), so no KRN session can edit workflow files. |
| t-p70b19s | 3 | The D23 confirmatory run compares a frozen K with PB on clean units, two runs each, with an equivalence test | D23 v2 run1 (t-cbwqm50, diagnostic, harness 27fe971) put K at +8.9 pp over PB (same requirements text, plain harness) over 56 units, CI [-2.5, 20.4], p=0.127: suggestive, not shown. K has since chang… |
