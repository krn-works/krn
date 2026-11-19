# 26. Standards: a rule is stated once, at its check or in AGENTS.md

Date: 2026-11-19

## Status

Proposed. The operator accepts or rejects it.

If accepted:
- Amends [ADR 0019](0019-one-record-store-and-evidence-driven-remember-loop.md). KRN's own rules leave the record store. `.agents/records.json` and `.agents/decisions.json` are deleted. Decisions stay in ADRs.
- Completes the rule-source fold of [ADR 0024](0024-one-tracked-plan-and-three-rule-sources.md).
- Moves KRN's own edit moment of [ADR 0020](0020-retrieval-moments-and-token-budgets.md) to native path-scoped rules.
- Leaves the shipped pack and the S8 proof of [ADR 0021](0021-proof-methodology.md) in place until S8 reports.

## Context

The operator, verbatim: "czemu my przechowujemy standardy w jsonie? imo jest niesamowity szum i za duzo dróg otwartych". In English: why do we store standards in JSON? There is enormous noise and too many open paths.

How the numbers were measured:
- All numbers are from main at `1cfd0601` on 2026-11-19.
- Churn counts commits since 2026-11-01. There were 1,724 commits in that window.
- Duplicates were found with word-set Jaccard ≥ 0.4 over every record text, every `spec/rules.json` rule and every bullet in `docs/program`.
- The trace ran the edit hook's own selection function (`editRecordsFor`) without writing the ledger.

### Inventory: where a rule lives today

| # | Surface | Holds | Written by | Read by | Reaches the agent | Bytes | Churn |
|---|---|---|---|---|---|---|---|
| 1 | `spec/rules.json` | 10 KRN rules; 5 are `kind: none` (manual review) | hand | `scripts/render-agents.ts` through `src/repo/agents-render.ts` | rendered into AGENTS.md; only 7 of the 10 appear, because KRN-05, 06 and 08 are filtered out at `src/repo/agents-render.ts:45-46` | 5,327 | 14 |
| 2 | `AGENTS.md` (`CLAUDE.md` links to it) | 7 rules and a preamble | generated | the harness | every session | 2,178 | 16 |
| 3 | `src/repo/agents-render.ts:56-67` | 1 worker rule ("prove red at base") written as a code literal | hand | worker render | lane sessions | – | – |
| 4 | `docs/program/lead-rules.md`, `repository-workflow.md` | lead and worker procedure | hand | required reading through KRN-09 and KRN-10 | must be read | 6,904 + 8,446 | 27 + 37 |
| 5 | `docs/program/hardening-checklist.md` | 8 hardening rules; 2 match pack records almost word for word | hand | lead | by reference | 3,175 | 8 |
| 6 | `docs/program/standards-enforcement.md` | a table from rule id to gap to task | hand | `test/rules/docs-referenced.test.ts` only | nobody at run time | 2,336 | 1 |
| 7 | `standards/records.json` (the pack) | 117 records, 110 active: 79 command, 2 krn, 29 advisory, across 9 stacks | hand and `harvest` | adopt, `standards check/query/review`, hooks, index render, `scripts/standards-audit.ts`, `scripts/fast-check.ts` | copied by adopt; served by hooks; `query` | 166,673 | 36 |
| 8 | `.agents/standards.json` | 42 own records; 41 of them only check that CI still runs a step | hand edits (t-5j1sapv asks for a command instead) | Stop (`standardsBlockers`), lane brief, edit hook, OWN-INDEX render, `test/brain/ci-rule-coverage.test.ts` | Stop refusals; edit, session and lane packets | 40,567 | 9 |
| 9 | `.agents/records.json` | 20 conventions and pitfalls, all advisory; 19 say in their provenance that they copy AGENTS.md, `repository-workflow.md` or a skill | hand and `harvest --write` | packets, `query`, `retire` | lane brief, session start, edit | 20,651 | 7 |
| 10 | `.agents/decisions.json` | 50 decisions: 37 copy ADR 0014, 13 come from the deleted `krn decide` | hand | `query --type decision` only (`src/brain/worker-packet.ts:404`) | never; no skill, rule or doc names the query | 41,486 | 1 |
| 11 | `.agents/standards-proposals/` | 9 proposals | `krn standards propose` | `harvest` | never | 2,989 | 9 |
| 12 | `.agents/skills/standards/INDEX.md`, `OWN-INDEX.md`, plus a byte copy at `src/adopt/skills/standards/INDEX.md` | one line per enforced record | `scripts/render-standards-index.ts` | the standards skill says "read it once" | when the skill loads | 12,397 + 6,185 (+ 12,397) | 4 + 4 (+ 4) |
| 13 | `spec/context-budget.json` | byte ceilings for 16 instruction files, 91.7 kB allowed in total | hand bumps | `test/rules/instruction-bytes.test.ts` | – | 781 | 52 |
| 14 | `src/hook/session-standards.ts` | SessionStart packet, 400 tokens | code | dispatcher | session start | 95 lines | 4 |
| 15 | `src/hook/edit-standards.ts` | edit packet on the first edit of each file kind, 150 tokens, 1 record in 10 withheld | code | dispatcher | first edit | 253 lines | 11 |
| 16 | `src/hook/edit-rules.ts` | regex copies of 2 test-hygiene rules | code | dispatcher | at the edit | 57 lines | 1 |
| 17 | `src/hook/stop.ts` | the own-record Stop gate and a second weak-tests implementation | code | dispatcher | Stop | 2,149 lines | 55 |
| 18 | `src/brain/**` | 28 modules, 5,693 non-test lines, 335 exports (20 flagged shallow, 1 hub); 8 `krn standards` verbs | code | CLI, hooks, adopt | – | 256,370 | 110, of which 36 are `fix` |
| 19 | `test/rules/**` | 33 guard tests: the rules that actually execute | code | CI, `npm run fast` | the failure message | 103,460 | 149 |
| 20 | `test/brain/**` and 23 other test files that read the stores | 32 + 23 files; 6,032 lines in `test/brain` | code | CI | – | – | – |
| 21 | `.krn/brain/exposures.jsonl` | served and withheld ledger | hooks | `standards effect`, `retire` | – | gitignored, one per host | – |

Totals:
- 228 live structured rule statements in 5 JSON stores (10 + 110 + 42 + 20 + 46 not retired or expired).
- 4 prose documents state rules.
- 1 rule exists only as a code literal.
- 2 hooks restate rules as code.
- 3 files are generated from these: AGENTS.md, `INDEX.md` and `OWN-INDEX.md`.
- 1 file is a shipped byte copy: `src/adopt/skills/standards/INDEX.md`.

### End-to-end trace: `s-ci-weakened-tests`

1. **The rule that runs.** `scripts/weak-tests.mjs`:
   - It reads `Weakens-tests:` from the PR body (`:12`, `:111`).
   - CI runs it at `.github/workflows/ci.yml:92`; `npm run fast` runs it at `scripts/fast-check.ts:832`.
   - Its failure message tells the agent what to do (`:119`).
2. **A second implementation.** `src/hook/stop.ts:338-360` (`WEAKENS_REASON`, `deletionExplained`):
   - It reads commit bodies, not the PR body, and uses its own import heuristic.
   - `src/cli/lane-finish.ts:138` copies a lane note into the PR body to bridge the two versions.
3. **The JSON copy.** `.agents/standards.json:192-228` spends 37 lines on a one-sentence rule.
   - Its `enforcement.run` (`:216`) is `node scripts/ci-check-wired.ts 'node scripts/weak-tests.mjs'`.
   - That command checks that CI lists the step (`scripts/ci-check-wired.ts:9`). It does not check the rule.
4. **A guard that forces the copy.** `test/brain/ci-rule-coverage.test.ts:63` requires one record per CI check.
5. **A generated copy.** `.agents/skills/standards/OWN-INDEX.md:11` needs a render script, a staleness check and a byte ceiling (`spec/context-budget.json:15`).
6. **Serving.** On the first `test/**` edit, the edit hook selects 10 records through its retrieval gate. 3 of them fit in 150 tokens: `s-ci-weakened-tests`, `r-node-test` and `r-role-names`.
   - `r-role-names` is a second copy of the pack's `s-role-names`.
   - The 1-in-10 holdout can withhold any record on purpose (`src/brain/worker-packet.ts:56-62`).
   - Other paths to the agent: the session packet, the lane brief, `krn standards query` and `krn standards review`.
7. **Stop.** `standardsBlockers` (`src/brain/standards-cli.ts:507`) runs the wiring check from hop 3, not the rule.

Result:
- 1 rule has 2 implementations that can disagree.
- The rule is stated 4 times: the JSON text, the OWN-INDEX line, the `ci.yml:85` comment and the script header.
- Of 7 hops, only hops 1 and 2 enforce anything, and they read different inputs.
- The agent reliably learns the rule from the CI or `fast` failure message, which already states the fix.

### Noise numbers

- **No check.** 100 of the 228 live statements (44%) have no check:
  - 5 `spec/rules.json` rules of `kind: none`;
  - 29 advisory pack records;
  - 20 conventions;
  - 46 decisions.
- **Mirrors.** 41 of the 42 "enforced" own records only check CI wiring. Only 1 own record checks behaviour, and it is red (ASAP 1).
- **Metadata.**
  - In the pack, the own file and the conventions file, `text` and `why` make up 16% of the bytes; the other 84% is fields.
  - `valid_from` equals `recorded_at` in all 179 served records.
  - 6 of the 16 fields in `.agents/standards.json` have the same value in every row.
- **Supersession never used.** No record anywhere has `superseded_by`. No served file holds a `trial` record. ADR 0019 expects at least 5 of each by 2026-12-15, so the window is still open, but the count has not moved.
- **Shell in strings.**
  - 82 pack command records hold 29,108 characters of shell inside JSON strings (median 270, longest 1,195). 81 of them are pipelines or `node -e` one-liners.
  - Neither Biome nor shellcheck can read them.
  - Testing them takes `scripts/lib/record-plants.ts` (393 lines) and `test/cli/standards-coverage.test.ts` (627 lines).
- **Duplicates.**
  - The word-overlap scan finds 12 pairs at Jaccard ≥ 0.4, 10 of them across files. That is a lower bound, because paraphrases score low.
  - By their own provenance, 19 of 20 conventions and 37 of 50 decisions copy another source.
  - 9 conventions copy an AGENTS.md rule, and the restatement filter drops none of them (ASAP 5).
- **Serving is not measurable from the repository.**
  - The exposure ledger is gitignored and kept per host, so the repository cannot answer "was this record ever served".
  - ADR 0019 measured `krn standards query` being typed once in 58 exposures.
  - The ledger was empty on this host when the audit began.
- **Budget churn.**
  - `spec/context-budget.json` took 52 commits in 19 days. Only `spec/receivers.json` changed more often among spec files.
  - `INDEX.md` sits at 12,397 of 12,400 bytes and `OWN-INDEX.md` at 6,185 of 6,200, so every new record forces a ceiling bump.
  - Tests that exist only because text is copied or large: `instruction-bytes`, `ci-rule-coverage`, the AGENTS.md and index staleness checks, and part of `docs-referenced`.
- **Commit traffic.**
  - 491 of 1,724 commits (28%) touched a rule surface: the stores, `docs/program`, the skills, `src/brain`, `test/rules`, `spec/rules.json`, `spec/context-budget.json` or the render scripts.
  - 53 commits touched a JSON store.
  - 36 `fix` commits landed in `src/brain` and the standards hooks.
  - #1530 merged during this audit and added one CI rule (a PR body check). 5 of its 19 files were mirror bookkeeping:
    - `.agents/standards.json` (+34 lines, now 43 own records);
    - `OWN-INDEX.md`;
    - a `spec/context-budget.json` bump;
    - `src/brain/standards-index.ts` and its test.
- **The product check fails on the product.**
  - `krn standards check --root .` on KRN prints `FAIL standards: 79 enforced, 10 failed` (floor 2/9).
  - No workflow runs it: `grep "standards check" .github/workflows/*.yml` finds nothing.
- **ADR 0024 targets missed.**
  - Mandatory reading for a lead is 35.5 kB (AGENTS.md, lead-rules, repository-workflow and plan). The target was at most 15 kB.
  - `docs/program` holds 6 files. The target was 2.
  - `hardening-checklist.md` was due to move into the lead skill's references in step 1 and is still in `docs/program`.

### The JSON question

What JSON buys here, judged on what is in use:
- **Machine filtering.** `applies.stacks/paths/terms` lets `krn adopt` choose pack records per stack and lets the hooks choose them per path. Used.
- **A runnable check per record.** `krn standards check` runs `enforcement.run` in any adopted repository. Used, but it is code stored as a string.
- **A versioned schema.** `spec/schema/record.v1.json` (ADR 0017). Used.
- **Temporal and evidence fields.** `valid_to`, `supersedes`, `evidence_kind` and the holdout for per-record effect (ADR 0021). Built but not yet earning anything:
  - no record has been superseded;
  - no record has a measured effect;
  - the ledger never leaves the host.

What it costs:
- 84% of the bytes are metadata.
- Prose and shell are escaped inside strings.
- A hand edit reformats or truncates the file. In t-5j1sapv, adding one record took 4 `npm run fast` runs and once truncated `.agents/standards.json`.
- Generated indexes need byte ceilings, and every mirror needs its own sync test.

Verdict: JSON is not the root cause. Copying is.
- JSON is a fair container for one machine-owned catalog that is shipped to other repositories and filtered there. That is the pack.
- JSON is the wrong container for KRN's own rules. Those are either already executable in `test/rules/` and `ci.yml`, where the JSON row is a mirror, or a handful of prose rules that belong in AGENTS.md or a skill.
- Every extra store needs a sync test, and the sync tests are the noise.

### Options (designed twice)

The interface is what an author has to know to add one rule. A smaller interface is a deeper module.

| | A. Checks are the rules, plus one short list | B. Markdown with frontmatter, one file per rule | C. Keep JSON with one owner |
|---|---|---|---|
| Shape | A KRN rule lives at its check: a `test/rules/*.test.ts` or CI script with a `// Rule:` header and a failure message that names the fix. Rules without a check go in AGENTS.md. | `rules/<id>.md` with `paths:`, `check:` and `tier:` frontmatter; the body holds the rule and the reason. Rendered to `.claude/rules/` for native path loading (t-yv53bd6). | The 4 files merge into `standards/records.json` with a `scope` field. The own mirror is generated from `ci.yml`. |
| Statements per rule | 1 | 1 file, which still restates its check unless combined with A | 1 row plus generated copies |
| Author interface | write a test with one header line | 4 frontmatter keys and a body | 16-19 fields, a render, a budget bump and a coverage test |
| Deletes | `.agents/standards.json`, `.agents/records.json`, `.agents/decisions.json`, OWN-INDEX, `standards-enforcement.md`, `ci-check-wired.ts`, `ci-rule-coverage.test.ts`, `decisions.ts`, the own-record Stop path | 4 JSON stores and the edit hook process for Read/Edit/Write | 3 files; no code |
| Proactive reminders at the edit | none for KRN's own rules; the failure teaches | yes, natively, but Claude only (Codex reads AGENTS.md only) | yes, through the hook |
| Adopted repositories | unchanged | adopt and `check` need a frontmatter reader | unchanged |
| Main risk | violations that a reminder would have prevented reach `fast` | about 150 files; still copies checks | the operator's complaint stays true |

## Decision

Use A for KRN's own rules. Use B's carrier (native path-scoped rule files) only for the few path hints worth keeping. Clean up the shipped pack in place.

1. **One statement per rule.**
   - A rule KRN checks mechanically lives only at its check, with a first-line `// Rule: <one sentence>` and a failure message that names the fix.
   - The CI workflow is the list of what is enforced. Nothing copies that list.
2. **A rule without a check lives in AGENTS.md** (at most 600 tokens, ADR 0024), or in the one skill that owns its procedure.
3. **Path hints become native rules.** The useful part of the edit hook becomes a few hand-written `.claude/rules/<area>.md` files with `paths:` frontmatter. Claude Code loads them on Read, Edit and Write. Each line names its check.
   - The hook keeps serving Bash edits only (t-yv53bd6; close its duplicate t-acvt8k9).
   - Codex keeps AGENTS.md.
4. **Decisions stay in ADRs.** `.agents/decisions.json` and its query type are deleted. ADR 0014 is already the authority (ADR 0019).
5. **The pack stays one JSON catalog,** because adopt and `krn standards check` filter and run it by machine. But:
   - every `enforcement.run` longer than one command moves to `standards/checks/<id>.sh` (or `.mjs`), where Biome and shellcheck can read it;
   - fields with the same value everywhere, or that duplicate another field, are dropped;
   - checks skip planted fixtures, so `krn standards check` passes on KRN and CI runs it.
6. **No new retrieval or experiment work before S8 reports.** This covers exposures, holdout, `effect`, `retire`, evidence proposals, candidate ingest and harvest.
   - If S8 shows no per-record effect (ADR 0021's own falsifier), that engine is deleted.
   - The pack is then served as native rule files rendered at adopt time.

## Expected effect

- KRN's own JSON rule stores go from 3 to 0. Measure: `ls .agents/*.json` lists nothing.
- KRN's own rules are stated once. Measure: a guard checks that every `test/rules/*.test.ts` has a `// Rule:` header, and `git grep -c ci-check-wired` returns 0.
- About 111 kB of rule text and JSON is deleted. That is 102.7 kB of JSON, 6.2 kB of OWN-INDEX and 2.3 kB of the enforcement map. Measure: `wc -c` before and after.
- `src/brain` shrinks by at least `decisions.ts`, the own-record path of `standards-cli.ts` and the conventions overlay. Measure: `node scripts/architecture/depth.ts` before and after, in each PR.
- `spec/context-budget.json` changes fewer than 10 times in 19 days, down from 52. Measure: `git log --since=19.days --oneline -- spec/context-budget.json | wc -l`.
- `krn standards check --root .` prints `PASS` on KRN and runs in CI.

## Consequences

- **Deleted:**
  - `.agents/standards.json`, `.agents/records.json`, `.agents/decisions.json`;
  - `.agents/skills/standards/OWN-INDEX.md`;
  - `docs/program/standards-enforcement.md`;
  - `docs/program/hardening-checklist.md`, after it moves into the `delivery-lead` skill;
  - `scripts/ci-check-wired.ts`, `test/brain/ci-rule-coverage.test.ts`, `src/brain/decisions.ts`;
  - the conventions key in `krn.json`.
- **Kept:**
  - `standards/records.json` as the shipped catalog;
  - `test/rules/**` as the executable rules;
  - AGENTS.md as the rule list;
  - the `standards` skill for adopted repositories.
- **Task changes:** t-5j1sapv (a command to append CI-rule records) becomes obsolete. t-yv53bd6 carries step 5.
- **Adopted repositories** see no change until step 6.

## Migration plan

Each step is one PR and keeps behaviour unchanged unless stated. The ASAP list below goes first.

1. **Decisions.**
   - Change: delete `.agents/decisions.json`, `src/brain/decisions.ts`, the `--type decision` branch (`src/brain/worker-packet.ts:404`) and `test/brain/decisions.test.ts`. Amend ADR 0019's table.
   - Proof: `git grep -c decisions.json -- src scripts` returns 0, and `fast PASS`.
2. **Conventions.**
   - Change: delete `.agents/records.json`. First move the few rows that carry knowledge stated nowhere else (`r-verify-premise-before-cause`, `r-shard-weights`, `r-piped-checks`) into AGENTS.md or the skill that owns them. Then drop `conventions` from `krn.json` and point `harvest --write` at proposals only.
   - Proof: `node evals/retrieval/run.ts` recall before and after.
3. **Own standards.**
   - Change: replace `.agents/standards.json`, OWN-INDEX, `ci-rule-coverage` and `ci-check-wired.ts` with a `// Rule:` header guard over `test/rules` and the CI scripts. Remove the own-record path from `standardsBlockers`; Stop already runs the related tests.
   - Proof: `node --test test/rules/rule-headers.test.ts` and `fast PASS`.
4. **Prose maps.**
   - Change: delete `standards-enforcement.md`, whose gaps already live in tasks. Move `hardening-checklist.md` into the `delivery-lead` skill's references (ADR 0024 step 1, overdue), dropping the 2 lines the pack already states. Remove their budget entries.
   - Proof: `ls docs/program | wc -l` prints 4.
5. **Native path rules.**
   - Change: t-yv53bd6. Add hand-written `.claude/rules/*.md` for KRN; the edit hook serves Bash only.
   - Proof: edit recall ≥ 0.76 (`node evals/retrieval/run.ts`) and hook p50 from `krn doctor --hooks`, before and after.
6. **Pack hygiene.**
   - Change: move shell to `standards/checks/`, drop constant fields, make checks skip fixtures, and add a CI step that runs `krn standards check --root .`.
   - Proof: that step passes on the PR.
7. **After S8.** Keep or delete the retrieval and experiment engine according to ADR 0021's falsifier.
8. **Optional: AGENTS.md as the source.** Fold `spec/rules.json` and its render into AGENTS.md. The registry test then reads the markdown.
   - Do this only if the render's registry check caught no drift in 30 days.

## ASAP: the five worst problems

1. **The only floor own record has been red on main since #1121 (2026-11-16), and nothing notices.**
   - `.agents/standards.json:34` looks for `src/hook/stop.ts` in the Stop hook, but `.claude/settings.json:91` runs `src/dispatch/main.ts stop`.
   - Stop blocks only records that pass at the base and fail now (`src/hook/stop.ts:2042`).
   - No workflow runs `krn standards check`.
2. **KRN fails its own pack.**
   - `krn standards check --root .` prints `FAIL standards: 79 enforced, 10 failed`, including the floor record `s-no-secrets-tracked`.
   - The pack's whole-tree greps hit planted fixtures such as `scripts/lib/record-plants.ts:206` and `test/cli/standards-coverage.test.ts:131`.
3. **The weak-tests rule is implemented twice, and the two read different inputs.**
   - `scripts/weak-tests.mjs:12` reads the PR body.
   - `src/hook/stop.ts:338-360` reads commit bodies and uses its own import heuristic.
   - `src/cli/lane-finish.ts:138` copies text between them.
   - The two can disagree on the same diff.
4. **41 of the 42 own records only mirror CI wiring.**
   - Example: `.agents/standards.json:216`.
   - `test/brain/ci-rule-coverage.test.ts` forces one per guard. Adding one took 4 `fast` runs and once truncated the file (t-5j1sapv).
   - Two records state the same rule: `.agents/standards.json:164` and `:375`.
5. **ADR 0019 §6 does nothing in practice.**
   - `src/brain/worker-packet.ts:96-107` drops only verbatim copies, so 0 of 9 AGENTS.md copies are dropped.
   - Lane briefs serve `r-regression-layer` (a copy of KRN-14) and `r-tracker-owner` (`.agents/records.json:160`).
   - `r-tracker-owner` contradicts KRN-11 (`spec/rules.json:75`). The skills audit lane is fixing that row's text now, but the class of problem stays while the copies exist.

## Falsified if

- After steps 2 and 3, the red-CI rate or the number of `npm run fast` reruns per PR rises by more than 10 points over 50 PRs, against the ADR 0024 baseline.
  - Then proactive serving was doing real work.
  - The rule areas that regressed get native path rules (step 5) before anything else is deleted.
- An agent repeats a violation class that a deleted record named at least 3 times in 2 weeks. Then that rule moves into AGENTS.md or a native rule file.
- S8 shows a measured per-record effect for KRN's own served records. Then serving is kept for those records only.
