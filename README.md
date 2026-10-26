# KRN

KRN is the product: fast, low-noise software creation with agents. It is a software delivery layer that runs on top of agent harnesses; a harness is the model's tool loop, and an agent is a model plus a harness. KRN is not a harness. Its own delivery is the benchmark: merges per lane-hour, review rounds, conflicts, and flaky stalls.

## Run

Use Node **24.22.1** and pnpm **12.10.1**. Run a Product CLI command with:

```sh
node src/cli/main.ts --version
```

Install repository dependencies with `pnpm install --frozen-lockfile`.

Product implements `--version`, `task`, `review`, `delegate`, `report journey`, `start`, `checkpoint`, `stop`, and `note`. Unknown commands are forwarded to the Global KRN package under KRN-06. Product does not implement merge: `krn ship` is forwarded to Global, which performs the merge.

## Checks and delivery

- `npm run check` checks TypeScript.
- `npm run rules` verifies generated `AGENTS.md` against `spec/rules.json`.
- Before review, run the cheap preflight: types, lint, documentation-reading tests, test-impact review, and contracts. After review, Product's `npm run gate:local` runs the full local gate; CI runs the same steps for the PR.
- PR delivery requires the repository's independent Standards and Spec reviews on the exact head SHA and required CI.

The in-repository `krn task` tracker owns task status through committed `tasks/<id>.json` records, dependencies, readiness, and claiming. No legacy board data is imported; its Product integration is removed. Review and delivery evidence stays in local `krn review` records and git history. [ADR 0014](docs/adr/0014-operator-decisions-2026-10-23.md) and [ADR 0015](docs/adr/0015-repository-task-tracker.md) record the tracker decision. The repository-consolidation trigger is defined in [ADR 0013](docs/adr/0013-repository-consolidation.md).

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
