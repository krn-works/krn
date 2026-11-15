---
name: architecture
description: Judge or design module structure in any language, including sets of .ts modules: deep modules, seams, one owner per concern, deletion test, design-it-twice. Use for structure reviews, refactors and seam decisions, with the measured depth check first; skip for bug fixes and edits that keep the interface.
compatibility: Works in any repository and language; reads commands from `krn repo contract` when a krn CLI is present.
---

# Architecture

Goal: more behaviour behind a smaller interface, so changes and tests concentrate in one place. Adapted from mattpocock/skills `engineering/improve-codebase-architecture` and `engineering/codebase-design` at commit 6654f6b (MIT, Copyright (c) 2026 Matt Pocock; permission notice kept in the upstream LICENSE). Additions: measured depth check, core/adapter rule, and delivery.

## Vocabulary

Use these terms exactly; do not drift to "component", "service", "API", or "boundary".

- **Module**: anything with an interface and an implementation (function, file, package). Usually one source file or one package entry.
- **Interface**: everything a caller must know: types, invariants, ordering, error modes, configuration.
- **Depth**: behaviour a caller or test can exercise per unit of interface. Deep = much behaviour behind a small interface; shallow = interface nearly as large as the implementation.
- **Seam**: where behaviour can change without editing in place; where a module's interface lives.
- **Adapter**: a concrete thing satisfying an interface at a seam. One adapter is a hypothetical seam; two is a real one.
- **Leverage**: what callers gain from depth. **Locality**: what maintainers gain: change, bugs, and checks concentrate in one place.

**Deletion test**: imagine deleting the module. Complexity vanishes: it was a pass-through. It reappears in N callers: it earned its keep. "Concentrates" is the signal to deepen. **The interface is the test surface**: if tests need to reach past it, the module has the wrong shape.

## Process

1. **Measure.** Use the repository's own depth measure if it has one; otherwise count per module: exported symbols, non-test lines, importers (fan-in) and imports (fan-out). Flag pass-throughs (an interface as large as the body), hubs and types-only files. Flags are heuristics that point at where to read, not proof.
2. **Scope.** Weight recently changed areas: `git log --since=<date> --name-only | sort | uniq -c | sort -rn | head`. Read the repository's domain glossary and decision records for settled decisions; do not re-litigate an ADR unless friction is real, and say so.
3. **Explore.** Delegate reading to a fresh-context subagent that returns a verdict and a path, not file contents. Look for: understanding one concept needs many small modules; pure functions extracted only for tests while bugs hide in the callers; modules leaking across seams; exports no caller imports; code hard to test through its interface. Apply the deletion test to each suspect.
4. **Rank.** Write candidates to `.krn/runs/<owner>/architecture-candidates.md`, never into tracked files. Per candidate: `path:line` evidence, problem in depth/locality terms, proposed seam, what deletes, strength (`Strong`, `Worth exploring`, `Speculative`). No interface proposals yet.
5. **Design it twice.** For the chosen candidate, produce two or three radically different interfaces (for example: minimal; flexible; caller-optimised) and compare by depth, leverage, and test surface. Pick one, or merge the best parts. Do not skip this for a new seam.
6. **Deliver.** Turn each candidate into a task (`krn task create`; the lead creates it and workers get the id in the brief). One deepening per slice, behaviour unchanged, existing tests green, before/after depth numbers in the pull request.

## Deep modules, any language

- **Small public interface.** Expose the few operations callers need; keep helpers and constants private. An exported symbol nobody uses is interface cost with no leverage.
- **Information hiding.** Callers use the module entry, not its internals; do not re-export internals. A module that only forwards is a pass-through: delete it and use the owner.
- **One owner per concern.** One module owns each decision, format, or invariant; other code asks it. Duplicated knowledge across modules is the first deepening candidate.
- **One call does the job.** Prefer one operation over steps callers must order. Return results, accept dependencies; keep ordering and invariants inside.
- **Core stays independent.** The core imports only its own files; adapters (hosts, storage, external services) depend on core, never the reverse. A seam is real only when two adapters vary across it, such as a host and its test double.
- **Test through the interface.** A test that needs a private symbol is a signal to move the seam, not to export more.
- **Types-only files** are shared vocabulary, not a deepening target; split large ones by owner.

For a language's expression of these rules (export minimisation, barrels, types at the seam) follow that language's conventions in the repository's standards: `krn standards query "<what I am doing>"`.
