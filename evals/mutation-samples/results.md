# Mutation samples

Five hand mutations in each critical module, applied one at a time by
`node evals/mutation-samples/run.mjs`; a mutant is killed when the module's own test file goes red.

| Module | Mutants | Killed before | Killed after |
| --- | --- | --- | --- |
| src/ci/ship.ts | 5 | 3 | 5 |
| scripts/claude/worker-stop.ts | 5 | 4 | 5 |
| src/cli/lane-run.ts | 5 | 4 | 5 |
| Total | 15 | 10 (67%) | 15 (100%) |

Survivors of the first run and the test that now kills each:

- ship: a refused push exit code (70) -> `a refused push exits 70 and names the --force rerun after a rebase`.
- ship: an unrecognised verdict falling to exit 74 is unreachable (the wait always prints a verdict), so the mutant was replaced by the still-open exit code (80), which an existing test kills.
- worker-stop: a non-executable runner (exit 126) -> `a test runner that is not executable (exit 126) refuses like a missing one`.
- lane-run: a failed token mint read as success -> `mintFailure` extracted and covered by `a token helper run is a failure unless it exited 0, and names its first stderr line`.
