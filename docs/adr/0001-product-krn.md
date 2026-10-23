# 1. Product repository and J1 scaffold

Date: 2026-10-07

## Status

Accepted for E1 scaffold.

## Context

The selected direction was a dedicated `krn` repository, one package with
module boundaries, a Node 24 TypeScript runtime, and a CLI strangler boundary.
This ADR records the initial scaffold decision; it does not assert current
module status or behavioral qualification.

## Decision

Create one private package with `core`, `relay`, `foreman`, `ledger`,
`verdict`, `memory`, `trace`, `hosts`, and `cli` modules. Unknown commands
forward through the legacy boundary with a recursion guard. Repository rules
live in `spec/rules.json` and generate `AGENTS.md`.

## Policy and evidence

- **POLICY:** The product name, repository, package topology, Node 24 baseline,
  adapter boundary, and Spec Language rule registry are the selected scaffold
  decisions recorded here.
- **Evidence:** This ADR does not qualify J1, prove the current architecture,
  or establish the Spec v0 compliance experiment.
- **Implementation detail:** TypeScript 7, Node's built-in type stripping,
  Biome, and `node:test` implement the selected stack for this scaffold.

## Consequences

The module exports are deliberately small stubs. J1 implementation and
behavioral qualification remain future work. Type-only Node definitions are a
development dependency so the strict check can describe Node APIs.

## Implementation follow-up (2026-10-20)

[CODE] The repository now contains a TypeScript package and CLI. The current entry point and checks are listed in [README](../../README.md). Unknown commands use `KRN_LEGACY_ENTRY` (default `~/.codex/krn/current/scripts/krn.mjs`); `KRN_LEGACY_BIN` is historical. This implementation readback does not change the accepted single-package decision.
