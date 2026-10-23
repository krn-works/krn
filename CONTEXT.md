# KRN context

## Terms and boundaries

- **Harness:** the tool loop around a model, such as Claude Code or Agent SDK, Codex CLI or App Server, or Pi.
- **Agent:** a model running through a harness.
- **KRN:** the product for fast, low-noise software creation with agents. It is a software delivery layer above agent harnesses and is never called a harness. KRN measures its own delivery by merges per lane-hour, review rounds, conflicts, and flaky stalls.
- **Host:** owns model sessions, tool execution, and host permissions.
- **Product KRN:** owns this TypeScript CLI and runtime. It implements `--version`, `review`, `delegate`, `report journey`, `start`, `checkpoint`, `stop`, and `note`. Unknown commands are forwarded under KRN-06; Product does not implement merge.
- **Global KRN package:** owns the compatibility CLI, skills, hooks, and installer. The package boundary remains until the measured trigger in ADR 0013.

## Current control plane

The in-repository `krn task` tracker is the selected task-status source: Git-backed JSONL or files, a rebuildable local index, dependencies, readiness, and claiming. Its implementation is a later slice; it replaces the legacy Git-ref `krn task` queue and host-SQLite `krn work`. Paperclip is legacy and will be removed everywhere after import. Do not add Paperclip dependencies. ADR 0014 D8 records the decision; ADR 0013 keeps Product as the target home and Global as a compatibility boundary until its measured consolidation trigger fires.

The [plan](docs/program/PLAN.md) records sequence, not task status or additional authority. Read tracker status from `krn task` when implemented; until then, treat the missing command as an implementation gap, not a reason to return to Paperclip.

## Durable state

- Accepted decisions live in [ADRs](docs/adr/README.md); repository workflow rules live in [repository workflow](docs/program/repository-workflow.md).
- A delivery-loop continuation capsule lives at `.krn/runs/delivery-loop/<outcome-id>/state.md`. The delivery-loop owner is its sole writer; Global KRN's `krn state check` and `krn state resume` validate and resume it through Product's unknown-command forwarding.
- `krn ship` is also forwarded to Global KRN, which performs merges; it is not a Product command.
- Capsules and traces support continuation and evidence. They do not replace task status, acceptance, or ADRs.

## Working links

- [Delivery plan](docs/program/PLAN.md)
- [Lead rules](docs/program/lead-rules.md)
- [ADR index](docs/adr/README.md)
