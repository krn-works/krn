---
name: implementation
description: Implement features, refactors, config changes, and repo edits with surgical scope, vertical slices, behavior-first tests, and concrete verification. Use when Codex should change files or execute a coding plan after the goal is clear.
---

# Implementation

Build the smallest useful change that can be verified. Match the repo instead of inventing a new style.

## Rules

1. **Inspect before editing.** Read the existing files, commands, package scripts, tests, and local conventions. Do not assume framework shape from memory.
2. **State the slice.** Before edits, name the current bead, the files you expect to touch, and the proof you will run.
3. **Prefer behavior tests.** Test public behavior through real interfaces. Avoid tests coupled to private functions, incidental DOM shape, or internal mocks unless the repo already has that pattern and no better seam exists.
4. **Implement vertically.** One behavior, one narrow implementation, one verification loop. Repeat.
5. **Keep changes surgical.** Do not reformat unrelated code, rename adjacent concepts, or refactor because it looks nicer.
6. **Add abstractions only when they pay rent.** A new module should reduce real duplication, isolate complexity, or match an existing local pattern.
7. **Use proven libraries for established domains.** Do not hand-roll parsers, game engines, auth, date math, or protocol logic when the repo already uses a credible library.
8. **Verify with the right proof.** Unit tests are not runtime proof. Local HTTP is not production proof. Rendered UI proof is not code inspection.

## Vertical Slice Template

```text
Slice: <behavior>
Existing pattern: <file or command that proves local convention>
Edit: <paths>
Test/proof: <exact command or runtime check>
Done when: <observable acceptance criterion>
```

## If Tests Are Missing

Do not use missing tests as permission to skip verification. Build the best available loop:

- direct function harness,
- CLI smoke command,
- HTTP request,
- browser check,
- snapshot/diff of generated output,
- manual proof with exact steps if automation is not possible.

Read `references/surgical-coding.md` for anti-patterns to avoid.
