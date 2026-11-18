# KRN plan

Every agent reads this at session start. A change to this plan that moves none of items 1–5 is rejected. Lanes never edit this file; slice status is the task's status.

## North star

Operator, 2026-11-15, verbatim: "od poczatku planowalem najpierw miec własny system tworzenia tasków lepszy niż beads i realnie tworzenie dopierdolonego turbo sexy - opakowanie na harness który realnie dodaje mu kurwa mocy, od memory przez brain, od tasków przez persistence, przez wszystkie inne przełomowe wzorce wyodrębniane względem paperów i prac naukowych sukcesywnie przerabiane i analizowane przez Fable oraz tworzone w 80% przez opusa 5.5"

KRN is a harness wrapper that adds real power to any agent session: tasks better than Beads, memory, the brain, persistence across sessions, and patterns extracted from research. All pillars stay. Cutting means removing slop (dead code, duplicates, unused paths), never a pillar.

The brain is three verbs over one store:
1. Remember: every delivered change leaves evidence (CI, hidden tests, review findings, operator corrections). A lesson becomes a record only with evidence, a scope and a date. Records supersede; they never pile up.
2. Retrieve: at the moment of need. The moments are task start (clauses and precedent), before editing a file kind or stack, before Stop, and any time through `krn standards query`, routed by one `standards` skill.
3. Prove: every record carries its measured effect. A record that moves nothing retires.

What is missing, in order:
1. Retrieval at the three moments plus the query tool.
2. Stack-scoped content: records tagged by stack, harvested from skills; no per-language prose skills.
3. One universal `standards` skill, the same in KRN and every adopted repo; KRN adopts itself.
4. Remember loop closed automatically: outcomes propose records, lead or Fable accepts, effect measured.
5. The proof: A plain, B static instruction file, C KRN brain with Remember (earlier units' graded failures propose evidence-gated records), at most 3 records per moment behind a precision gate, executable-only Stop, on outside rows with hidden tests. Only C > A and C > B on pass rate counts; cost per resolved task and regression rate sit beside it (ADR 0021 point 10).

Correction (ADR 0021): the D23 "PB 62.5% vs P 10.7%" result is an oracle upper bound, because its requirements were derived from the hidden tests. The brief-only clause arm is measured in S4.

Not the goal: gates and ceremony in KRN's own delivery, skills nobody uses, dead code, more research before items 1–3.

## Decisions

- [ADR 0017](../adr/0017-one-repository-versioned-file-contracts.md): one repo, one package; versioned file formats are the contract; research joins by candidate files; extraction only on a measured test.
- [ADR 0018](../adr/0018-task-storage-file-per-task-with-archive.md): one file per open task, monthly JSONL archive for closed; `kind`, `area`, `stack`, `from`; task joined to brain at claim and close.
- [ADR 0019](../adr/0019-one-record-store-and-evidence-driven-remember-loop.md): one record schema; decisions queryable but never served; candidates only from CI, hidden-test, review and verbatim operator evidence.
- [ADR 0020](../adr/0020-retrieval-moments-and-token-budgets.md): four moments with token budgets; the query is the task; retrieval keys and a recall@5 eval; pull has a stop rule.
- [ADR 0021](../adr/0021-proof-methodology.md): claims ladder; per-record `violated` signal; retire by Fisher test; preregistered A/B/C with cost co-primary; `metric` predictions.
- [ADR 0022](../adr/0022-harness-integration-and-delivery-transport.md): one hook process per event with a latency budget; lane ends at auto-merge; transport is `gh`; plugin and MCP deferred behind triggers.
- [ADR 0023](../adr/0023-onboarding-installs-gates-that-run.md): adopt installs gates that run, fills gaps, files categorised gate tasks; first real adopters are named work.
- [ADR 0024](../adr/0024-one-tracked-plan-and-three-rule-sources.md): this plan; three rule sources; folded in two measured steps.

## Program

Slice line: `- [S<n>] title — Outcome — Proof — Predicted — After`.

- `Predicted: metric …` claims use the source that S3 ships (spec/metrics.json); they are unmeasured until S3 merges.
- `[slop]` slices delete code and count toward t-jgent6a (src −15% from 32,128 lines).
- Proof commands for things a slice creates exist once that slice merges.

### Sector 1 — Direction and operator surface (ADR 0024)

- [S1 t-9pra0h1] Every session starts from the tracked plan, not the module listing [slop] — Outcome: SessionStart injects `plan.md@<hash>` plus the current slice line; the capability index, its generated file and hook are deleted; disk lines and stale claim lines leave the model's context — Proof: `node --test test/claude/context-restart-plan.test.ts: pass` and `git ls-files docs/generated/capability-index.md | wc -l: 0` — Predicted: metric session-start-bytes <= 4800
- [S2 t-zkar758] Rules live in AGENTS.md, the plan and skills only [slop] — Outcome: step 1 deletes roadmap.md, roadmap-prune, proposals.md and the stale plans; after a red-CI baseline over 50 merges, step 2 folds lead-rules.md and repository-workflow.md into the krn-lead skill and removes KRN-09/KRN-10 — Proof: `ls docs/program | wc -l: 2` and `npm run rules: pass` — Predicted: metric lead-mandatory-bytes <= 15000 — After: S1

### Sector 2 — Proof (ADR 0021; north-star item 5)

- [S3 t-k3jmgax] Plan predictions are scored by command — Outcome: `Predicted: metric <name> <op> N` is parsed by `krn ledger --predictions` from `spec/metrics.json`; fable-plan-brief.md documents it; every ADR measurement is registered — Proof: `bin/krn ledger --predictions | grep -c unmeasured: fewer than today for plan.md rows` — Predicted: metric plan-slices-scored-share >= 0.8
- [S4 t-6psh6t3] The specification claim is measured as it ships — Outcome: arms P and P+clauses-from-brief run on the 56 screened units, 2 reps, preregistered; result recorded in `evals/d23/` and the D23 line here restated — Proof: `node evals/d23/analysis.ts --arms P,PC: prints delta with CI` — Predicted: metric clause-arm-delta-pp < 10
- [S5 t-c6hrj5m] Exposure rows carry a per-record effect — Outcome: `krn.exposure/v1` with `at`, `tokens`, `attempt` and per-record `violated`; withheld = would-serve ∩ held-out; `rework` dropped; `retire --write` frozen behind the Fisher rule — Proof: `node --test test/brain/exposures.test.ts test/brain/retire.test.ts: pass` — Predicted: metric records-with-30-scoped-diffs >= 10
- [S6 t-26p4xm7] One replay harness runs arms A, B and C [slop] — Outcome: `evals/replay/` replaces outside-acceptance, outside-testgrade and the d23 harness; arms are configuration; results rows are (unit, arm, rep, pass, cost, harness sha) — Proof: `node evals/replay/run.ts --arms A,B,C --units 3 --dry: 9 rows` — Predicted: outside hidden >= 1 in >= 9 rows — After: S4
- [S7 t-1p7dmw9] Screening shows whether correctness can be proven — Outcome: at least 70 post-June-2026 units with issue-only bodies; arm A screened on a separate run; go only if A passes at most 85% — Proof: `node evals/replay/run.ts --screen --report: prints A pass rate and go/no-go` — Predicted: metric abc-screen-a-pass-rate <= 0.85 — After: S6
- [S8 t-1ntztra] A/B/C reports correctness and cost per resolved task — Outcome: preregistered confirmatory run, 3 reps, Holm over C−A and C−B, cost co-primary; "not shown" is a published result — Proof: `node evals/replay/run.ts --prereg evals/replay/abc.prereg.md --report: verdict line per contrast` — Predicted: metric abc-c-minus-a-pp >= 15 — After: S7, S10, S11

### Sector 3 — Retrieval (ADR 0020; items 1–3)

- [S9 t-6035vcr] Retrieval is keyed by the task — Outcome: session and lane packets query by task title, Outcome, Files, stack and paths; no task means no standards block; AGENTS.md duplicates are not served; audience honoured — Proof: `bin/krn standards effect --overlap: mean Jaccard < 0.4` — Predicted: metric served-set-overlap < 0.4 — After: S5
- [S10 t-r35kjgy] Records carry retrieval keys and recall is measured — Outcome: every in-force served record has stacks, paths and terms; `evals/retrieval/cases.json` holds 30 mined cases; recall@5 printed per moment — Proof: `node evals/retrieval/run.ts: recall@5 >= 0.6 at task start` — Predicted: metric recall-at-5-task-start >= 0.6 — After: S9
- [S11 t-9027pqy] One standards skill routes every repo to the query tool — Outcome: the `standards` skill is the same file in KRN and adopted repos; per-language prose skills are harvested into records and removed; the pull stop rule is measured after 2 weeks — Proof: `bin/krn adopt --refresh . --dry-run: no drift` — Predicted: metric query-calls-per-session >= 0.2 — After: S10

### Sector 4 — Formats and memory (ADR 0017, ADR 0019; item 4)

- [S12 t-85wjjhq] File formats are versioned contracts — Outcome: `spec/schema/*.v1.json` for task, record, exposure and contract; `krn.json` declares `formats`; readers refuse unknown majors; `tasks/` and record files are reached only through their owner; product/workshop partition in boundaries.ts — Proof: `node --test test/rules/format-contract.test.ts: pass` and `node scripts/boundaries.ts: pass` — Predicted: metric hardcoded-tasks-paths == 0
- [S13 t-bp8c2f9] One record store holds decisions, preferences and facts [slop] — Outcome: schema gains the types and `subject`, `evidence_kind`, `superseded_by`, `review_by`; `.agents/decisions.json` is queryable and never served; `krn decide`, decisions.md and the d-* rows migrate and are deleted; one standards CLI router — Proof: `bin/krn standards query --type decision "auto-merge" --json: >= 1 row` — Predicted: metric durable-stores == 1 — After: S12
- [S14 t-kjbxv9d] Session memory is pointers [slop] — Outcome: capsule at most 2 kB; MEMORY.md links all resolve; decisions-register removed; inbox drops harness blocks and tags agent-origin rows; memory-refs shrinks to a link check — Proof: `wc -c .krn/runs/delivery-loop/session-continuity/state.md: <= 2048` — Predicted: metric memory-dangling-links == 0 — After: S13
- [S15 t-cbsn9kz] Delivered evidence proposes records — Outcome: CI failures, failed hidden tests, review findings and verbatim operator corrections create `trial` proposals with `subject` matching; Stop refusals are not a source; pack hygiene applied (process records leave the universal layer, advisory records get a check or `review_by`) — Proof: `bin/krn standards harvest --from-ledger --dry-run: lists proposals with evidence_kind` — Predicted: metric trial-records-proposed-30d >= 5 — After: S13, S19

### Sector 5 — Tasks (ADR 0018)

- [S16 t-jsdzgnx] Tasks are categorised and carry their origin — Outcome: `kind`, `area`, `stack`, `from` in `krn.task/v1`; create requires kind and area; task-quality becomes one check inside src/task — Proof: `bin/krn task check: pass` and `bin/krn task list --kind gate --json: ok` — Predicted: metric new-tasks-with-kind-share >= 0.8 — After: S12
- [S17 t-js6d0hx] Task commands answer in under half a second and closed tasks archive — Outcome: single-task verbs read one file; `krn task archive` moves tasks closed over 14 days to `tasks/archive/<YYYY-MM>.jsonl`; `Ticket:` checks read both — Proof: `ls tasks/*.json | wc -l: < 80` and `node --test test/task/archive-ticket.test.ts: pass` — Predicted: metric task-show-ms < 450 — After: S12
- [S18 t-tsak7jn] A claimed task opens with its clauses and precedent — Outcome: `krn task claim` prints brief-derived clauses and top precedent matched by stack and area within 400 tokens, and stores clause ids — Proof: `node --test test/task/claim-packet.test.ts: pass` — Predicted: proof clauses >= 1 — After: S9, S16
- [S19 t-nzbhbtq] A closed task writes its outcome back as evidence — Outcome: `close --as done` appends PR, CI conclusion and hidden-test result to each exposed record's exposure rows — Proof: `node --test test/task/close-evidence.test.ts: pass` — Predicted: proof precedent >= 1 — After: S5, S18
- [S20 t-p14tych] The tracker keeps only what is used [slop] — Outcome: comments.ts, the socket lock and lock-host.ts deleted after a race test; claims run off Linux; task bookkeeping rides in delivering PRs — Proof: `node --test test/task/claim-race.test.ts: pass` and `test ! -e src/task/comments.ts: 0` — Predicted: metric chore-tasks-commit-share < 0.08

### Sector 6 — Harness and delivery (ADR 0022)

- [S21 t-n5d7fks] A lane that merged stops cleanly — Outcome: ship leaves the worktree and branch; the lane ends at "auto-merge enabled"; the lead prunes merged worktrees at the next lane start — Proof: `node --test test/hook/stop-merged-lane.test.ts: pass` — Predicted: proof stop-refusals == 0
- [S22 t-4khgs7r] Delivery transport is gh behind the required Check [slop] — Outcome: one test PR proves plain `gh` triggers and waits for `Check`; then `krn pr ship` is Proof commands plus two gh calls, and src/deliver and src/ci wait/logs/gh-reply/git-lock/rebase-generated are deleted (App token kept only if the test PR needs it) — Proof: `gh pr list --state merged --limit 20 --json statusCheckRollup: every head has Check success` — Predicted: metric delivery-fix-commits-30d < 10 — After: S21
- [S23 t-1v46dxv] One hook process per event inside the latency budget [slop] — Outcome: one `krn hook <event>` entry per event with lazy routes and a timing log; gauge once; shims, subagent-hook-errors, lead-file-read hook and stop-failure deleted; `.codex/hooks.json` generated from the same table — Proof: `bin/krn doctor --hooks: tool-call p50 <= 60 ms, p95 <= 150 ms` — Predicted: metric hook-tool-p50-ms <= 60 — After: S1
- [S24 t-x4z168s] The headless lane runner serves only the proof harness [slop] — Outcome: lane start is claim plus native worktree isolation; lane-run's worktree, preflight and git code, lane-canary and lane-lock are deleted; the session driver moves under evals/replay — Proof: `node evals/replay/run.ts --arms C --units 1: verdict line` — Predicted: outside drain == 0 in >= 3 rows — After: S6, S22
- [S25 t-7yd86sx] The session relay logs every launch and drops unused hosts [slop] — Outcome: launches.jsonl records each successor launch; the hc host path is removed; cc-clearing-watch runs on a timer; handoff prose-shape checks become the inbox-to-task invariant — Proof: `wc -l .krn/successors/launches.jsonl: grows by one per launch in the test` — Predicted: metric successor-launches-logged-share >= 0.9

### Sector 7 — Onboarding (ADR 0023)

- [S26 t-reddqmp] Adopted gates run — Outcome: contract holds real lint, typecheck and test commands; run checks supersede the presence checks; init skeletons run every installed tool in CI; the smoke test imports a source module — Proof: `node --test test/adopt/init-gates.test.ts: 5 of 5 stacks pass` — Predicted: outside adopt >= 1 in >= 5 rows
- [S27 t-8bv3z0k] Adopt fills gaps and files categorised gate tasks — Outcome: existing workflows are read and only missing gate jobs are added; gate tasks are written with kind, area, stack and tier order — Proof: `bin/krn adopt --verify <pilot>: duplicate-ci: 0` — Predicted: metric adopted-duplicate-ci == 0 — After: S16, S26
- [S28 t-4hg6y8x] One adoption check replaces three [slop] — Outcome: verify, canary and the walkthrough merge into `krn adopt --verify`; census moves to evals/adoption; unused and host-remediation fold or go — Proof: `find src/adopt -name '*.ts' | xargs cat | wc -l: <= 2450` — Predicted: outside adopt >= 1 in >= 5 rows — After: S27
- [S29 t-bvhfanp] A real operator repository runs KRN — Outcome: one census repository with a test command, then boilerplate-2026, are adopted; tier 1–3 gate tasks close within 10 merges — Proof: `bin/krn task list --kind gate --json` in that repo: `0 open in tiers 1–3` — Predicted: metric real-adopted-repos >= 1 — After: S11, S27

### Sector 8 — Research to practice (ADR 0017)

- [S30 t-d8wt16e] A research candidate enters by file and leaves with a verdict — Outcome: `krn.candidate/v1` and `krn.verdict/v1` schemas; `krn standards propose --from-candidate` refuses candidates without `motivated_by`; radar ritual lines deleted; cap of one experiment and 10 USD a week — Proof: `node --test test/brain/candidate-ingest.test.ts: pass` — Predicted: metric records-with-external-provenance >= 1 — After: S10, S15

### Closing

- [S31 t-vj5vfvs] The slop cut is accounted for [slop] — Outcome: `.krn/runs/prune/inventory.md` gives every src module a verdict; remaining delete-verdict modules (dead files, misplaced brain files moved, duplicate price tables, spend-window.py) go; t-jgent6a closes — Proof: `find src -name '*.ts' | xargs cat | wc -l: <= 27300 with main CI green` — Predicted: metric src-lines <= 27300 — After: S1, S6, S13, S14, S20, S22, S23, S24, S25, S28

## Parallel lanes

- Wave 1, no dependencies, run together: S1, S3, S4, S5, S12, S20, S21, S25, S26.
- Wave 2: S2, S6, S9, S13, S16, S17, S22, S23, S27.
- Wave 3: S7, S10, S14, S18, S24, S28.
- Wave 4: S11, S19, then S15, S29, S30.
- Last: S8 (needs S7, S10, S11) and S31.
- Shared files: S1 and S23 both edit `.claude/settings.json`; S9 and S18 both edit the packet builder; S21 and S22 both edit `src/ci/ship.ts`. Run each pair in sequence.

## Deferred, with triggers

- Claude Code plugin: 2 real adopted repositories, or C > A shown (ADR 0022).
- MCP query tool: the pull stop rule passes and a second harness needs it (ADR 0020).
- Ratchets and mutation in adopted repos: one real repository has tiers 1–3 green (ADR 0023).
- Separate repository for task, ledger or lab: the three-part test of ADR 0017.
- Probe replay per record: only records passing the recall eval (ADR 0021).
