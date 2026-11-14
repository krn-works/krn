# KRN

KRN is the product: fast, low-noise software creation with agents. It is a software delivery layer that runs on top of agent harnesses; a harness is the model's tool loop, and an agent is a model plus a harness. KRN is not a harness. Its own delivery is the benchmark: merges per lane-hour, review rounds, conflicts, and flaky stalls.

## Run

Use Node **24.22.1** and pnpm **12.10.1**. Run a Product CLI command with:

```sh
node src/cli/main.ts --version
```

Install repository dependencies with `pnpm install --frozen-lockfile`.

Product implements `--version`, `task`, `ci`, `pr`, `lane`, `state`, `doctor`, `brain`, `ledger`, `decide`, `adopt`, and `plan`. Unknown commands exit 64 under KRN-06. Merging is `gh pr merge --auto --squash` once the required `Check` passes.

## Checks and delivery

- `npm run check` checks TypeScript.
- `npm run rules` verifies generated `AGENTS.md` against `spec/rules.json`.
- Before pushing, run `npm run lint`, `npm run check` and the touched tests (`npm test` runs the whole suite). The only gate is required CI on the exact HEAD (`npm run gate` locally): the aggregate GitHub Actions `Check` (App `15368`, `.github/workflows/ci.yml`).

The in-repository `krn task` tracker owns task status through committed `tasks/<id>.json` records, dependencies, readiness, and claiming. No legacy board data is imported; its Product integration is removed. Delivery evidence stays in git history and PRs. [ADR 0014](docs/adr/0014-operator-decisions-2026-10-23.md) and [ADR 0015](docs/adr/0015-repository-task-tracker.md) record the tracker decision. ADR 0013 records the repository-consolidation direction; its trigger is superseded by the current one-repository shape.

## Start here

- [Current boundaries and terminology](CONTEXT.md)
- [Roadmap](docs/program/roadmap.md)
- [Lead rules](docs/program/lead-rules.md)
- [ADR index](docs/adr/README.md)
