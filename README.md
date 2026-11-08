# KRN

KRN is the product: fast, low-noise software creation with agents. It is a software delivery layer that runs on top of agent harnesses; a harness is the model's tool loop, and an agent is a model plus a harness. KRN is not a harness. Its own delivery is the benchmark: merges per lane-hour, review rounds, conflicts, and flaky stalls.

## Run

Use Node **24.22.1** and pnpm **12.10.1**. Run a Product CLI command with:

```sh
node src/cli/main.ts --version
```

Install repository dependencies with `pnpm install --frozen-lockfile`.

Product implements `--version`, `task`, `review`, `ci`, `worker`, `ledger`, and `eval`. Unknown commands exit 64 under KRN-06. Merging is `gh pr merge --auto --squash` once the required `Check` passes.

## Checks and delivery

- `npm run check` checks TypeScript.
- `npm run rules` verifies generated `AGENTS.md` against `spec/rules.json`.
- Before pushing, run `npm run lint`, `npm run check` and the touched tests. The only gate is required CI on the exact HEAD (`npm run gate` locally): the aggregate GitHub Actions `Check` (App `15368`, `.github/workflows/ci.yml`). `krn review` and `npm run gate:local` are opt-in diagnostics.
- The review panel is `standards`, `spec`, and `adversarial` (`src/flow/types.ts`); it is advisory.

The in-repository `krn task` tracker owns task status through committed `tasks/<id>.json` records, dependencies, readiness, and claiming. No legacy board data is imported; its Product integration is removed. Delivery evidence stays in git history and PRs. [ADR 0014](docs/adr/0014-operator-decisions-2026-10-23.md) and [ADR 0015](docs/adr/0015-repository-task-tracker.md) record the tracker decision. The repository-consolidation trigger is defined in [ADR 0013](docs/adr/0013-repository-consolidation.md).

Opt-in review: `krn review --repo <path> --base <ref> --head <ref> --lens <path> [--panel standards,spec,adversarial] [--reasoning-effort high]` runs read-only Codex judges in parallel against a scratch clone of the head and prints one JSON verdict. Exit 0 PASS, 1 FAIL, 2 INCOMPLETE, 64 usage, 70 error. It writes no records, keeps no attempt budget and plays no part in merging.

## Start here

- [Current boundaries and terminology](CONTEXT.md)
- [Delivery plan](docs/program/PLAN.md)
- [Lead rules](docs/program/lead-rules.md)
- [ADR index](docs/adr/README.md)
