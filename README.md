# KRN

KRN is the product: fast, low-noise software creation with agents. It is a software delivery layer that runs on top of agent harnesses; a harness is the model's tool loop, and an agent is a model plus a harness. KRN is not a harness. Its own delivery is the benchmark: merges per lane-hour, review rounds, conflicts, and flaky stalls.

## Run

Use Node **24.22.1** and pnpm **12.10.1**. Run a Product CLI command with:

```sh
node src/cli/main.ts --version
```

Install repository dependencies with `pnpm install --frozen-lockfile`.

Product implements `--version`, `review`, `delegate`, `report journey`, `start`, `checkpoint`, `stop`, and `note`. Unknown commands are forwarded to the Global KRN package under KRN-06. Product does not implement merge: `krn ship` is forwarded to Global, which performs the merge.

## Checks and delivery

- `npm run check` checks TypeScript.
- `npm run rules` verifies generated `AGENTS.md` against `spec/rules.json`.
- Before review, run the cheap preflight: types, lint, documentation-reading tests, test-impact review, and contracts. After review, Product's `npm run gate:local` runs the full local gate; CI runs the same steps for the PR.
- PR delivery requires the repository's independent Standards and Spec reviews on the exact head SHA and required CI.

The in-repository `krn task` tracker is the selected replacement for Paperclip. Its Git-backed JSONL or file records, rebuildable local index, dependencies, readiness, and claiming are a later implementation slice. Import existing records, then remove Paperclip everywhere; do not add Paperclip dependencies. [ADR 0014](docs/adr/0014-operator-decisions-2026-10-23.md) records this and the other operator decisions. The repository-consolidation trigger is defined in [ADR 0013](docs/adr/0013-repository-consolidation.md).

## Start here

- [Current boundaries and terminology](CONTEXT.md)
- [Delivery plan](docs/program/PLAN.md)
- [Lead rules](docs/program/lead-rules.md)
- [ADR index](docs/adr/README.md)
