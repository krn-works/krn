# KRN

KRN is the product: fast, low-noise software creation with agents. It is a software delivery layer that runs on top of agent harnesses; a harness is the model's tool loop, and an agent is a model plus a harness. KRN is not a harness. Its own delivery is the benchmark: merges per lane-hour, review rounds, conflicts, and flaky stalls.

## Run

Use Node **24.22.1** and pnpm **12.10.1**. Run a Product CLI command with:

```sh
node src/cli/main.ts --version
```

Install repository dependencies with `pnpm install --frozen-lockfile`.

Product implements `--version`, `task`, `review`, `delegate`, `report journey`, `start`, `checkpoint`, `stop`, `note`, and `eval`. Unknown commands are forwarded to the Global KRN package under KRN-06. Product does not implement merge: merges go only through GLOBAL `krn ship`, which pins the reviewed head through the pull request API (D21).

## Checks and delivery

- `npm run check` checks TypeScript.
- `npm run rules` verifies generated `AGENTS.md` against `spec/rules.json`.
- Before review, run `npm run preflight`: local types, lint, rules, task check, documentation and core-import observers. Manually review test impact: identify changed behavior, its observers and receiver proof, then run the relevant tests. Under the ADR 0014 D30 amendment, the full Product gate is required CI on the exact HEAD (`npm run gate`): the aggregate GitHub Actions `Check` (App `15368`, `.github/workflows/ci.yml`), selected from the authoritative PR base. Independent preflight and review remain mandatory. `npm run gate:local` remains available for optional local diagnostics (source-selected isolation tests with zero isolation skips); delivery does not invoke it or wait for host load. This cheap preflight is distinct from the networked exact-head `scripts/pr-preflight.mjs` used by `krn ship`.
- The review panel is `standards`, `spec`, and `adversarial` (`src/flow/types.ts`). `krn/judge-standards` and `krn/judge-spec` are published only from a record with `panelVerdict` PASS or a recorded D10 override. PR delivery also requires the exact head SHA and required CI.

The in-repository `krn task` tracker owns task status through committed `tasks/<id>.json` records, dependencies, readiness, and claiming. No legacy board data is imported; its Product integration is removed. Review and delivery evidence stays in local `krn review` records and git history. [ADR 0014](docs/adr/0014-operator-decisions-2026-10-23.md) and [ADR 0015](docs/adr/0015-repository-task-tracker.md) record the tracker decision. The repository-consolidation trigger is defined in [ADR 0013](docs/adr/0013-repository-consolidation.md).

Create a draft PR before PR-bound review:

```sh
krn review --repo <path> --pr <number> --base <exact-base-sha> --head <exact-head-sha> --lens <path>
```

The CLI and direct API verify authoritative PR number, canonical base repository, target base ref and exact base/head SHA before cost. A series is canonical repository + PR number + base ref. Head, session, worktree, remote URL spelling and moving main never reset its two-attempt budget; changing an established base ref fails closed. Reservations live in repo-common `.krn/runs/review-series/`, anchored via Git's common directory. A crash after reservation consumes the attempt. Corrupt, gapped or missing established state refuses review/admission; there is no automatic recovery. Local reviews without `--pr` remain unbound and cannot admit a PR; historical v1/v2 records still parse without implying attempt counts.

Before reserving a PR review attempt, `krn review --pr` reads check runs for the exact head using the gate selector from the exact base. The latest matching run by `started_at` then ID refuses admission when it concludes `failure`, `timed_out` or `startup_failure`; the refusal names the check, conclusion and URL. Pending or absent checks and other conclusions are allowed. A check read or response validation error refuses before reservation, so retrying does not spend an attempt.

PR admission requires the reviewed base to be an ancestor of the requested base and exact head, allowing the target base to move without another review attempt.

For prior verification add `--prior-record <first-FAIL-record.json>` and retain the same panel roles. Deterministic checks always block. Each attempt above two requires `--budget-exception <path>` with a separate explicit operator exception for that exact slot and head:

```json
{"schemaVersion":1,"repository":"owner/repository","pr":17,"baseRef":"main","ordinal":3,"headSha":"<full-exact-sha>","authority":"explicit operator grant","evidence":"verbatim grant and supporting evidence"}
```

The exception is retained in the reservation and raw record; it cannot be reused for another ordinal or head. Acceptance override is separate: `krn review --repo <path> --pr <number> --base <exact-base-sha> --head <exact-head-sha> --override --reason <text> --evidence <text>`. It grants no budget and cannot bypass deterministic failure or incomplete exact-head evidence. An earlier consumed incomplete attempt may precede a later complete attempt on the same or a different head. PR metadata reads can be injected into the direct API for offline tests; local exception text uses the trusted lead boundary, without cryptographic operator authentication.

## Paused foreman/live-delivery route (D23)

The live foreman route is paused under D23 until the delivery proof metrics exist. The route contract below documents the paused implementation; it is not the current delivery path.

The live foreman reads a local JSON contract:

```sh
KRN_LIVE=1 npm run live -- --repo /absolute/repo --job delivery --issue t-example --contract /absolute/contract.json
```

The contract supplies `issueId`, `identifier`, `title`, `description`, `revision`, `targetRepo` (`owner/repository` matching the origin remote), and a nonempty `checks` array of declared check IDs. For example:

```json
{
  "issueId": "t-example",
  "identifier": "t-example",
  "title": "Implement the requested change",
  "description": "Delivery requirements",
  "revision": "1",
  "targetRepo": "owner/repository",
  "checks": ["typecheck", "lint", "rules"]
}
```

Optional `--revision` must match the contract. Passing verification records local `ready_for_review` evidence; the live command does not publish reviews or deliveries to an external service.

## Start here

- [Current boundaries and terminology](CONTEXT.md)
- [Delivery plan](docs/program/PLAN.md)
- [Lead rules](docs/program/lead-rules.md)
- [ADR index](docs/adr/README.md)
