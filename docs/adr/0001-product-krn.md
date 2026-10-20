# 1. Product repository and J1 scaffold

Date: 2026-10-07

## Status

Accepted for E1 scaffold.

## Context

The approved product blueprint selects a new `krn` repository, a single package
with module directories, a Node 24 TypeScript runtime, and a CLI strangler
boundary. The source decision is [Blueprint v4, §§3, 7, 9, 10](../program/blueprint.md#3-struktura)
and [the operator charter](../program/charter.md#decyzja-nazwy-lead-2026-10-07-na-polecenie-operatora-sam-zadecyduj).

## Decision

Create one private package with `core`, `relay`, `foreman`, `ledger`,
`verdict`, `memory`, `trace`, `hosts`, and `cli` modules. Unknown commands
forward through `KRN_LEGACY_BIN` with a recursion guard. Repository rules live
in `spec/rules.json` and generate `AGENTS.md`.

## Policy and evidence

- **POLICY:** The product name, new repository, single-package topology, module
  responsibilities, Node 24 baseline, code style, adapter boundary, and Spec
  Language rule registry are selected decisions from Blueprint v4.
- **Evidence:** Blueprint citations record the selected source and its own
  evidence labels. They do not qualify J1, prove the chosen architecture, or
  establish the Spec v0 compliance experiment.
- **Implementation detail:** TypeScript 7, Node's built-in type stripping,
  Biome, and `node:test` implement the selected stack for this scaffold.

## Consequences

The module exports are deliberately small stubs. J1 implementation and
behavioral qualification remain future work. Type-only Node definitions are a
development dependency so the strict check can describe Node APIs.

## Implementation follow-up (2026-10-20)

[CODE] The repository now contains a working TypeScript package and CLI; the opening scaffold description is historical. Current executable entry and supported commands are indexed in [README](../../README.md). Unknown commands use `KRN_LEGACY_ENTRY` (default `~/.codex/krn/current/scripts/krn.mjs`), rather than the historical `KRN_LEGACY_BIN` variable recorded in this ADR’s decision block. This follow-up records implementation readback without changing the ADR's accepted single-package decision. Current inter-module dependencies and proposed refactoring are in [architecture](../architecture.md).
