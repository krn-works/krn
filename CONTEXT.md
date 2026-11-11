# KRN context

## Terms and boundaries

- **Harness:** the tool loop around a model, such as Claude Code or Agent SDK, Codex CLI or App Server, or Pi.
- **Agent:** a model running through a harness.
- **KRN:** the product for fast, low-noise software creation with agents. It is a software delivery layer above agent harnesses and is never called a harness. KRN measures its own delivery by merges per lane-hour, review rounds, conflicts, and flaky stalls.
- **Host:** owns model sessions, tool execution, and host permissions.
- **Product KRN:** owns this TypeScript CLI and runtime. It implements `--version`, `task`, `ci`, `pr`, `lane`, `state`, `doctor`, `brain`, `ledger`, `decide`, `adopt`, and `plan`. Unknown commands exit 64 under KRN-06; Product does not implement merge.

## Current control plane

The in-repository `krn task` tracker is the task-status source. Its committed `tasks/<id>.json` records support dependencies, readiness, and claiming. It replaces the legacy Git-ref task queue and host-SQLite `krn work`; no Paperclip or legacy queue data is imported. Paperclip integration was removed from Product in #109 and from GLOBAL in krn-works/krn-codex-skills #461 (merge 26446dd5). The host Paperclip service and data were removed on operator order on 2026-10-27, without an archive. On the host, `~/.local/bin/krn` links to the pinned Product checkout's `bin/krn` at `.krn/product-release` (t-ez3nsc3); the GLOBAL release no longer sits on PATH. Git history and PRs provide delivery evidence; no board publication replaces them. ADR 0014 D8 and ADR 0015 record the tracker decision; ADR 0013 records Product as the home; its consolidation trigger is superseded by the one-repository shape.

The [plan](docs/program/PLAN.md) records sequence, not task status or additional authority. Read tracker status from `krn task`.

## Durable state

- Accepted decisions live in [ADRs](docs/adr/README.md); repository workflow rules live in [repository workflow](docs/program/repository-workflow.md).
- A delivery-loop continuation capsule lives at `.krn/runs/delivery-loop/<outcome-id>/state.md`. The delivery-loop owner is its sole writer; `krn state check` and `krn state resume` validate and resume it; Product `krn state` owns both.
- Merging is not a KRN command: an unknown command exits 64 and is never forwarded (KRN-06); merges happen through GitHub auto-merge.
- Capsules and traces support continuation and evidence. They do not replace task status, acceptance, or ADRs.

## Working links

- [Delivery plan](docs/program/PLAN.md)
- [Lead rules](docs/program/lead-rules.md)
- [ADR index](docs/adr/README.md)
