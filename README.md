# KRN

KRN is the software delivery layer that runs on top of agent harnesses. An agent is a model plus a harness. A harness owns the model's tool loop, such as Claude Code or the Claude Agent SDK, Codex CLI or App Server, or Pi. KRN coordinates planning, dispatch, verification, review, and merge across its Product and Global components.

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
- `npm run gate` runs type, lint, test, and generated-rule checks.
- PR delivery requires the repository's independent Standards and Spec reviews on the exact head SHA and required CI.

Paperclip owns task status and acceptance until an explicit per-project tracker cutover under [ADR 0011](docs/adr/0011-krn-work-tracker.md). The repository-consolidation trigger is defined in [ADR 0013](docs/adr/0013-repository-consolidation.md).

## Start here

- [Current boundaries and terminology](CONTEXT.md)
- [Delivery plan](docs/program/PLAN.md)
- [Lead rules](docs/program/lead-rules.md)
- [ADR index](docs/adr/README.md)
