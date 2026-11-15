# 17. One repository, one package, versioned file formats as the contract

Date: 2026-11-15

## Status

Accepted. Decided by Fable under the operator's mandate of 2026-11-15 ("wybierz z fablem najlepszy możliwy kierunek"; splitting was explicitly allowed and is declined here on evidence).

- Confirms the single-package decision of [ADR 0001](0001-product-krn.md).
- Amends [ADR 0013](0013-repository-consolidation.md): the one-repository shape is no longer just "the current shape". It is the decided shape, with a measured exit test.
- Rejects, for now, workspace packages (J1 D1), a `krn-lab` repository (J8 D1, J1 D4, J5), and moving the session relay out (J6).

## Context

- Changes cross area lines too often for a split to pay. Over 1,660 commits, the share of an area's commits that also touched another area was 69% for brain, 79% for adopt, 86% for hook, 88% for repo and 43% for task (judge-J1 F2). A brain repository would turn about two of three brain changes into two coordinated PRs plus a version bump.
- The split was tried and undone. ADR 0013 records a forwarder 55 commits behind, 30 export-pin commits in three days and test lists conflicting in 13 of 23 runs (judge-J1 F3, judge-J8 F6).
- There are zero outside consumers and zero real adopted repositories (adoption.md; judge-J10 section 2).
- The import graph is already acyclic with zero boundary violations. The real coupling is on disk (judge-J1 F1):
  - 20 files outside `src/task` hard-code `tasks/`;
  - `.krn/runs` is touched by 9 areas;
  - no format carries a version (`tasks/*.json`, `standards/records.json`, `krn.json`, `exposures.jsonl`).
- The red team rejected workspace packages as machinery that moves no north-star item, and rejected a lab repository now: 0 records have ever come from a paper and correctness sits at ceiling on the outside rows (judge-J10 section 3; judge-J8 F1, F4).
- The one split that has cost nothing is a data contract. `rss-news` shares no code with KRN and has had no drift (judge-J8 F2, F6).
- The market rewards separable tools over plain files and a CLI (sota.md). That argues for a stable file format, which is cheap now. It does not argue for a repository boundary, which is expensive now.

## Decision

1. **KRN stays one repository and one private package.** No pnpm workspace, no package `exports` maps, no second repository for brain, memory, tasks, session relay or research.
2. **The contract between parts is the file format.** Each store has a named, versioned format with a JSON Schema in `spec/schema/<name>.v<major>.json`:

   | Format | Files |
   |---|---|
   | `krn.contract/v1` | `krn.json` |
   | `krn.task/v1` | `tasks/<id>.json`, `tasks/archive/*.jsonl` (ADR 0018) |
   | `krn.record/v1` | `standards/records.json`, `.agents/records.json`, `.agents/decisions.json` (ADR 0019) |
   | `krn.exposure/v1` | `.krn/brain/exposures.jsonl` (ADR 0021) |
   | `krn.candidate/v1`, `krn.verdict/v1` | research exchange files (point 6) |

   - A repository declares the versions it holds once, in `krn.json` under `formats`. The 922 task files are not rewritten.
   - Files that cross a repository boundary (candidates, verdicts) carry `"schema"` themselves.
   - Readers refuse an unknown major version with exit 78.
   - One contract test validates every committed file against its schema.
3. **Frozen command surfaces.** These keep documented exit codes; everything else is internal and may change without notice:
   - `krn task … --json`
   - `krn standards query --json`
   - `krn standards propose --from-candidate <file>`
   - `krn hook <event>`
4. **Stores are reached through their owner.** Code outside `src/task` reaches `tasks/` only through the task module, and code outside `src/brain` reaches records only through the brain module. `scripts/boundaries.ts` enforces both.
5. **Product and workshop are partitioned inside the one tree.**
   - Product is what an adopted repository runs: `task`, `brain`, `hook`, `adopt`, `repo`, `harness`, and the CLI verbs over them.
   - Workshop is the operator's own delivery tooling: `successor`, `context`, `state`, `memory`, `outcome`, lanes, `scripts/claude/*`.
   - `scripts/boundaries.ts` gains the rule that product never imports workshop. Violations present when the rule lands are listed as exceptions, and that list may only shrink.
6. **Research is joined by files and pulled by failure, not pushed by feed.**
   - `rss-news` stays the separate ingestion repository. KRN keeps denying its MCP.
   - A candidate is one `krn.candidate/v1` file with these fields: `id`, `source {url|arxiv_id, quote, sha256}`, `pillar`, `claim`, `record_draft` (a `krn.record/v1` object with `status: "trial"`), `experiment {population, metric, predicted_delta, min_n}`, `expires`, and `motivated_by`.
   - `motivated_by` is required. It names a failing recall-eval case, a failed hidden test or a review finding. A candidate with no named failure is refused.
   - KRN ingests with `krn standards propose --from-candidate` and answers with a `krn.verdict/v1` file (`n`, `delta`, `p`, `cost_usd`, `decision`).
   - Cap: one candidate experiment a week and 10 USD a week.
   - No scheduled triage job and no lab repository are built now.
7. **Exit test for any future extraction** (task, evidence ledger or lab). All three must hold:
   - at least one consumer that is not KRN;
   - cross-area co-change at or below 15% for 30 days;
   - a versioned format with contract tests.

   A lab repository is created when the candidate contract has carried at least 5 candidates and at least 1 accepted record.

## Expected effect

- Formats with a declared version and schema go from 0 of 4 to 5 of 5. Measure: `node --test test/rules/format-contract.test.ts` exits 0 and reports the count of validated files.
- Hard-coded `tasks/` paths outside the task module go from 20 files to 0. Measure: `git grep -lE "['\"\`]tasks/" -- src ':!src/task' | wc -l`.
- Fix commits caused by package or repository wiring stay at 0, because none is introduced. Measure: `git log --since=30.days --oneline --grep='^fix' -i --grep='export\|workspace\|pin' --all-match | wc -l`.
- Within 6 weeks of the candidate ingest shipping, at least 1 record carries an `https` or arXiv `provenance.origin` and a verdict file. Today the count is 0. Measure: `node -e` scan of `provenance.origin` over the three record files, plus `ls .agents/standards-proposals/verdicts | wc -l`.

## Consequences

- Nothing moves to another repository.
- Deleted:
  - the radar-refill requirement in `src/successor/handoff-requests.ts`;
  - the radar sentence in `src/repo/roadmap.ts`;
  - `src/evals/stats.ts` and `src/fs/read-regular-file.ts` (dead, 127 lines).
- `krn-radar` stays an on-demand agent and is not scheduled.
- Research evidence that an ADR or the plan cites moves to tracked `evals/` as short reports. `.krn/runs` stays disposable, and nothing tracked may depend on it.
- `src/repo` keeps `contract.ts`. `ship-record.ts` and `ci-admission-contract.ts` follow their users when ADR 0022 cuts the transport.
- The misplaced brain files move to their owners: `adopted-registry` and `first-test` to adopt, `lane-proposal` and `proof-line` to lanes, `task-quality` to task.

## Falsified if

- A trial extraction of `src/task` shows co-change at or below 15% over 30 days and no pin drift. Then point 7 should have run earlier, and task is extracted.
- More than 3 commits in a month fix schema or version drift between KRN and a file-contract partner. Then the contract is too wide and is narrowed.
- 10 or more candidates are ingested in 8 weeks and 0 become accepted records. Then the research pipeline is not built further and point 6 shrinks to on-demand reading.
