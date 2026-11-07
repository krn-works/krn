---
name: krn-architecture
description: Find and design deeper TypeScript modules in KRN. Use when designing or refactoring a module, reviewing architecture, or deciding where a seam belongs; run the measured depth check first. Skip for bug fixes and single-file edits that keep the interface.
---

# KRN architecture

Goal: more behaviour behind a smaller interface, so changes and tests concentrate in one place. Adapted from mattpocock/skills `engineering/improve-codebase-architecture` and `engineering/codebase-design` at commit 6654f6b (MIT, Copyright (c) 2026 Matt Pocock; permission notice kept in the upstream LICENSE). KRN additions: measured depth check, TypeScript guidance, and KRN delivery.

## Vocabulary

Use these terms exactly; do not drift to "component", "service", "API", or "boundary".

- **Module**: anything with an interface and an implementation (function, file, package). In KRN usually one `.ts` file or one `src/<area>/index.ts`.
- **Interface**: everything a caller must know: types, invariants, ordering, error modes, configuration.
- **Depth**: behaviour a caller or test can exercise per unit of interface. Deep = much behaviour behind a small interface; shallow = interface nearly as large as the implementation.
- **Seam**: where behaviour can change without editing in place; where a module's interface lives.
- **Adapter**: a concrete thing satisfying an interface at a seam. One adapter is a hypothetical seam; two is a real one. KRN's real seams: core versus hosts, trace, and verdict adapters (KRN-05).
- **Leverage**: what callers gain from depth. **Locality**: what maintainers gain: change, bugs, and checks concentrate in one place.

**Deletion test**: imagine deleting the module. Complexity vanishes: it was a pass-through. It reappears in N callers: it earned its keep. "Concentrates" is the signal to deepen. **The interface is the test surface**: if tests need to reach past it, the module has the wrong shape.

## Process

1. **Measure.** `node scripts/architecture/depth.ts` prints per module: exported symbols, non-test lines, importers (fan-in; src, test, scripts), imports (fan-out), flags (`pass-through`, `shallow`, `hub`, `types-only`), ranked candidates, and a verdict. Flags are heuristics that point at where to read, not proof.
2. **Scope.** Weight recently changed areas: `git log --since=<date> --name-only | sort | uniq -c | sort -rn | head`. Read `CONTEXT.md` for domain names and `docs/adr` for settled decisions; do not re-litigate an ADR unless friction is real, and say so.
3. **Explore.** Delegate reading to a fresh-context subagent that returns a verdict and a path (KRN-13), not file contents. Look for: understanding one concept needs many small modules; pure functions extracted only for tests while bugs hide in the callers; modules leaking across seams; exports no caller imports; code hard to test through its interface. Apply the deletion test to each suspect.
4. **Rank.** Write candidates to `.krn/runs/lead/architecture/candidates.md`, never into the repo tree. Per candidate: `path:line` evidence, problem in depth/locality terms, proposed seam, what deletes, strength (`Strong`, `Worth exploring`, `Speculative`). No interface proposals yet.
5. **Design it twice.** For the chosen candidate, produce two or three radically different interfaces (for example: minimal; flexible; caller-optimised) and compare by depth, leverage, and test surface. Pick one, or merge the best parts. Do not skip this for a new seam.
6. **Deliver.** Turn each candidate into a `krn task` (lead only; workers get the id in the brief). One deepening per slice, behaviour unchanged, existing tests green, before/after numbers from the depth script in the PR.

## TypeScript deep modules

- **Small public interface.** Export the few functions and types callers need; keep helpers, schemas, and constants module-private. An export nobody imports is interface cost with no leverage: delete the `export`.
- **Hide the implementation.** Callers import the module entry (`index.ts`), not its internals; do not re-export internals through barrels. A file that only re-exports is a pass-through: delete it and import the owner.
- **Narrow exports.** Prefer one function that does the job over several steps callers must order. Return results, accept dependencies; keep ordering constraints and invariants inside.
- **Types describe the interface.** Use narrow types and discriminated unions at the seam so invalid callers fail to compile; keep `any` and casts behind the seam (see the `typescript-engineering` skill, if installed).
- **Core stays independent (KRN-05).** `src/core` imports only its own files; adapters (hosts, trace, verdict) depend on core, never the reverse. A seam is real only when two adapters vary across it, such as a host and its test double.
- **Test through the interface.** Tests import what callers import. A test that needs a private symbol is a signal to move the seam, not to export more.
- **Types-only files** are shared vocabulary, not a deepening target; large ones are still worth splitting by owner.
