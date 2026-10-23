# KRN context

## Terms and boundaries

- **Harness:** the tool loop around a model, such as Claude Code or Agent SDK, Codex CLI or App Server, or Pi.
- **Agent:** a model running through a harness.
- **KRN:** the software delivery layer above agent harnesses. It coordinates planning, dispatch, verification, review, and merge across the Product and Global components. KRN and this repository are not a harness.
- **Host:** owns model sessions, tool execution, and host permissions.
- **Product KRN:** owns this TypeScript CLI and runtime. It implements `--version`, `review`, `delegate`, `report journey`, `start`, `checkpoint`, `stop`, and `note`. Unknown commands are forwarded under KRN-06; Product does not implement merge.
- **Global KRN package:** owns the compatibility CLI, skills, hooks, and installer. The package boundary remains until the measured trigger in ADR 0013.

## Current control plane

Paperclip owns live task status and acceptance until an explicit cutover for each project under [ADR 0011](docs/adr/0011-krn-work-tracker.md). Do not mirror writes during migration; after cutover, Paperclip is read-only. ADR 0013 keeps the repositories separate until its measured consolidation trigger fires.

The [plan](docs/program/PLAN.md) records sequence, not live task status or additional authority. Read current task status from Paperclip.

## Durable state

- Accepted and proposed decisions live in [ADRs](docs/adr/README.md); reusable repository lessons live in [workflow lessons](docs/research/workflow-lessons.md).
- A delivery-loop continuation capsule lives at `.krn/runs/delivery-loop/<outcome-id>/state.md`. The delivery-loop owner is its sole writer; Global KRN's `krn state check` and `krn state resume` validate and resume it through Product's unknown-command forwarding.
- `krn ship` is also forwarded to Global KRN, which performs merges; it is not a Product command.
- Capsules and traces support continuation and evidence. They do not replace task status, acceptance, or ADRs.

## Working links

- [Delivery plan](docs/program/PLAN.md)
- [Lead rules](docs/program/lead-rules.md)
- [ADR index](docs/adr/README.md)
