# Outside rows: harvest sources and promotion

Harvest proposals come from four sources beyond a refused Stop. Each is a proposal in the shape `krn standards propose` writes, so `krn standards harvest` and `promoteCandidates` treat them alike.

| source | written by | evidence | when |
| --- | --- | --- | --- |
| Stop refusal | `scripts/outside-acceptance.ts` (`proposeArgs`) | `outside:<stack>:stop:<record>` | a row's Stop hook refused a record |
| hidden-test failure | `failureArgs` | `outside:<stack>:hidden` | the upstream fix's held-back test fails on the merged tree |
| non-zero drain | `failureArgs` | `outside:<stack>:drain:<exit>` | the unattended drain exits non-zero |
| audit FAIL in >=2 repositories | `auditFailProposals` | `evals/standards-audit.md#<record>` | the audit table (first, undrained table) has FAIL for one record in two or more rows; the proposal states the record's own text |
| KRN fix commits | `fixCommitProposals` | `#<PR>` | a merged `fix(...)` commit whose subject ends `(#PR)`; backfilled for #893-#900 |

`node scripts/outside-harvest-sources.ts [--from 893 --to 900] [--write]` runs the audit and fix-commit sources over the repository and promotes. `--write` records the promotion in `standards/records.json`.

## Backfill result

```
candidate count 5 in 1 repository (promotable): Verify the change against its receiver before shipping: a merged pull request was later changed or reverted.
  evidence: krn:#900, krn:#896, krn:#895, krn:#894, krn:#893
candidate count 3 in 3 repositories (promotable): A formatter or linter is configured for the stack, ...
candidate count 3 in 3 repositories (promotable): Continuous integration runs the tests on every pull request.
candidate count 3 in 3 repositories (promotable): The README states how to run the tests.
harvest: 4 candidates from 14 proposals in 4 repositories, 4 promotable
promoted: s-ci-runs-tests, s-linter-configured, s-readme-test-command
```

## Promotion

`s-ci-runs-tests`, `s-linter-configured` and `s-readme-test-command` failed in all three public rows (php, npm, py) before their remediation drain. Each is an enforced `command` record, so each now carries `harvested: { origins: [php, npm, py], occurrences: 3 }`; `promotionFailures` accepts it (3 repositories, command enforcement) and `test/scripts/outside-harvest.test.ts` checks the shipped pack. The fix-commit candidate is promotable by count but no pack record states it, so it stays a candidate (`s-receiver-evidence` is advisory and is not promoted). False-red cells after the change: rerun `node scripts/standards-audit.ts` (see `evals/standards-audit.md`).

## Earlier live run (Stop refusals only)

Live run of the three public rows (php, npm, py): no Stop refusal occurred, so no proposal was written; `harvest: 0 candidates from 0 proposals in 3 repositories`. Effect: 3 runs, 11 records, all served records followed.
