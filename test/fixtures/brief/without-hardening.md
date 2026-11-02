# Brief — sweep orphaned review verdict trees (t-7be2jjm)

Repo: worktree `<repo>/.krn/worktrees/review-verdict-cleanup`, branch `fix/review-verdict-cleanup`, base origin/main `b2705d7` (branch HEAD 13c55c0 adds tracker files only; do not touch `tasks/`). Task id `t-7be2jjm`.

## Outcome
`krn review` never leaves `<root>/.krn/tmp/verdict-*` trees behind for longer than the next review run. On 2026-11-01 `<storage>` hit 100%: 8+ orphaned `verdict-*` red-first clones of ~1.9 GB each from 10-29, no live owner. In-process `finally` blocks already clean up on success, failure and SIGINT/SIGTERM; SIGKILL, OOM and quarantined trees (`TeardownUnconfirmed`) leak. Fix: record each tree's owner and sweep dead owners' trees when a review next allocates one.

## Facts
- Single allocation seam: `createWorktreeDirectory` `src/verdict/sandbox.ts:436` (`mkdtempSync(join(directory,'verdict-'))`). Callers: `src/verdict/index.ts:154` (then `addWorktree` → registered `git worktree add --detach`, `sandbox.ts:439`) and `src/flow/repository.ts:831` (plain `git clone`, `createCandidateCopy` `:302-308`, no registration).
- Cleanup: `pruneExactWorktree` `sandbox.ts:395-433` (exact registered-worktree removal), `cleanupWorktrees` `sandbox.ts:442`; red-first `cleanupCandidateCopies` `repository.ts:313-324`, called at `:873-875` and `:916-918`.
- Quarantine (intentionally kept, a sandbox scope may still read the tree): `repository.ts:871` (`quarantined.add`), `index.ts:200-203,215` (`teardownUnconfirmed` skips cleanup). Scopes are user units named `krn-check-<uuid>.scope` (`sandbox.ts:593`).
- Consumers of `verdict-` names: `test/flow/repository-object-store.test.ts:140-142` counts `readdirSync(.krn/tmp)` entries starting with `verdict-`; nothing new in `.krn/tmp` may start with `verdict-`.
- Tests: node:test + `node:assert/strict`, TS imported directly; SIGTERM child pattern in `test/verdict/sandbox.test.ts:119-170`.

## Behaviour (decided)
1. Owner record: when `createWorktreeDirectory` allocates `<dir>/verdict-X`, write `<dir>/.verdict-owners/verdict-X.json` = `{pid, start}` where `start` is field 22 of `/proc/<pid>/stat` for `process.pid`. Directory mode 0o700.
2. Removal of a tree by `pruneExactWorktree` or `cleanupCandidateCopies` also removes its owner record (missing record is fine).
3. Quarantine marks the record `quarantined: true` (export a small helper from `sandbox.ts`, call it at `repository.ts:871` and for each copy in the `index.ts` teardown-unconfirmed path).
4. Sweep, exported from `sandbox.ts` as `sweepOrphanedVerdictTrees(root, directory, options?)`, run once per `directory` per process from `createWorktreeDirectory` before allocating. For each `verdict-*` entry in `directory`:
   - owner record present and owner alive (pid exists and `start` matches) → keep;
   - owner dead, `quarantined` and any `krn-check-*.scope` user unit is not inactive (probe: `systemctl --user list-units 'krn-check-*' --all --plain --no-legend`; probe failure counts as live) → keep;
   - owner dead otherwise → remove: if the tree has a `.git` file (registered worktree) use `pruneExactWorktree(root, tree)`, else `rmSync` recursive; then drop the record;
   - no record (trees made by older releases) → remove only if its mtime is older than 24 h.
   Records whose tree is gone are dropped. Sweep errors go to one stderr line and never fail or block the review. `options` lets tests inject the scope probe, clock and liveness check; defaults are the real ones.
5. Keep the existing `biome-ignore format` style of neighbouring one-liners; no other refactors.

## Readiness matrix (each a test in the new file)
SIGKILLed child that allocated a tree (real fork + `process.kill(pid,'SIGKILL')`) → next allocation in the parent removes it and its record; live owner (the test process) → kept; pid alive but `start` differs (reused pid) → removed; dead quarantined owner with a live scope → kept, with no live scope → removed; probe failure → quarantined kept; unrecorded tree 25 h old → removed, 1 h old → kept; registered worktree of a dead owner → directory gone and `git worktree list --porcelain` no longer lists it; normal cleanup removes the record; sweep runs once per directory per process; sweep error → allocation still succeeds.

## Proof
- New observer file `test/verdict/verdict-tree-sweep.test.ts`. It must fail at base `b2705d7` by assertion: check `typeof sandbox.sweepOrphanedVerdictTrees === 'function'` with `assert` before calling it (import the module namespace, not a named import), and assert on directory contents for the SIGKILL case.
- `npm run preflight` passes (biome check 0 errors); `node --test test/verdict/verdict-tree-sweep.test.ts test/verdict/sandbox.test.ts test/verdict/sandbox-orphans.test.ts test/flow/repository-object-store.test.ts test/flow/red-first.test.ts` passes (tests needing systemd/bwrap may skip in your sandbox: report which skipped; the lead reruns them on the host); `git diff --check` clean.
- One commit on top of 13c55c0: `fix(review): sweep orphaned verdict trees (t-7be2jjm)`, final trailer paragraph with no blank lines: `Ticket: t-7be2jjm`, `Change-contract: test/verdict/verdict-tree-sweep.test.ts:red->green`, `Co-Authored-By: Codex <noreply@openai.com>`.

## Allowed paths
`src/verdict/sandbox.ts`, `src/verdict/index.ts`, `src/flow/repository.ts`, `test/verdict/verdict-tree-sweep.test.ts`.

## Stop rules
Stop and report if an existing test must change, a path outside the allow list is needed, or the decided behaviour conflicts with existing code. Never touch real `krn-check-*` units or real user trees outside the test's own temp repos. Scratch only under the run dir, never /tmp.

## Report
Five lines: commit SHA, tests run with exit codes and skips, red-at-base evidence, deviations.
