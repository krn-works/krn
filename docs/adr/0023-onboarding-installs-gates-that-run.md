# 23. Onboarding: `krn adopt` installs gates that run, fills gaps, and files categorised tasks

Date: 2026-11-15

## Status

Accepted. Amends [ADR 0014](0014-operator-decisions-2026-10-23.md) only as to what the universal standards pack checks (run, not presence). Ratchets and mutation testing (J7 D2, D3) are deferred behind a trigger. The plugin installer is deferred by [ADR 0022](0022-harness-integration-and-delivery-transport.md).

## Context

- The operator's goal: "wykonujemy onboard krn i już wiemy że projekt będzie wykonany zajebiście, bez syfu, bez długu technologicznego, z systemem skategoryzowanych tasków" (program.md).
- Zero real operator repositories run KRN. All 20 registry entries are scratch clones, yet `src/adopt` is 2,957 lines with 68 commits in a month (adoption.md, map.md).
- Standards check presence, not execution (judge-J7 F1):
  - `s-linter-configured` passes on `.prettierrc`;
  - `s-typescript-strict` passes on any `extends`;
  - `s-ci-runs-tests` greps for a word.
- `krn adopt --init` installs tools its own CI never runs (judge-J7 F2):
  - biome is not in devDependencies;
  - golangci, ruff and mypy are never invoked;
  - the smoke test is `assert 1+1==2`.
- The operator's real repositories lack the basics. Of 15, 13 fail `s-ci-runs-tests`, 12 fail `s-test-command` and 12 fail `s-linter-configured` (judge-J7 F3).
- On the one pilot with good CI, adopt duplicated it with `krn-ci.yml` (judge-J7 F5).
- Tasks have no category, and "no tech debt" is measured nowhere (judge-J7 F6).
- Red team: ratchets and mutation before any real adopter is four slices of machinery for nobody. Gates that run come first (judge-J10 section 3).
- KRN dogfoods a different skill set than it installs (adoption.md). t-a8va9ce (self-adoption) and t-xmmvdwy (boilerplate-2026 skills) are in flight.

## Decision

1. **What `krn adopt` installs, in tiers.** Each tier becomes `kind: gate` tasks in the adopted repository's `tasks/`, with `area` and `stack` set (ADR 0018), ordered by tier.

   | Tier | Installed and checked |
   |---|---|
   | 0 Contract | `krn.json` (`krn.contract/v1`) with real `test`, `lint`, `typecheck` commands; AGENTS.md rules; `tasks/`; the one `krn hook <event>` entry per event; the `standards` skill; stack-scoped records |
   | 1 Floor | no secrets tracked; tests tracked; a test command that runs a test importing a source module |
   | 2 CI | CI invokes exactly the contract's commands (`s-gate-in-ci`) |
   | 3 Lint and types | `s-gate-lint-runs`, `s-gate-typecheck-runs`: the command exits 0 on the base branch |
   | 4 Ratchet | deferred, see point 6 |

2. **Gates must run.**
   - The presence checks `s-linter-configured`, `s-typescript-strict` and `s-ci-runs-tests` are superseded (ADR 0019 SUPERSEDE) by run checks reading the contract's commands.
   - The `extends` escape is removed.
   - Init skeletons run every tool they install in the CI they write. The `1+1` smoke test is replaced by a test that imports a source module.
3. **Fill gaps, never duplicate.** Adopt reads existing workflows. It adds only the jobs for gates that no workflow already runs, and it never writes `krn-ci.yml` beside a workflow that runs the same command.
4. **One adoption check.** `verify`, `canary` and the first-day walkthrough merge into `krn adopt --verify`, which runs the contract commands and the hook entries once. `census` moves to `evals/` as measurement. `unused.ts` and `host-remediation.ts` fold into init or are deleted.
5. **KRN installs on itself what it installs elsewhere.** `krn adopt --refresh` on this repository shows no drift (t-a8va9ce). The skill set is one source.
6. **Ratchets and diff-scoped mutation wait for a trigger.** They start when one real operator repository has tiers 1 to 3 green. Then:
   - a baseline per gate in `.krn/quality-baseline.json` that may only fall on changed files;
   - `weak-tests` patterns for Go, Python, PHP and Rust in `project-ci.yml`;
   - mutation as report-only.
7. **The first real adopters are named work.** One operator repository from `evals/adoption-census.md` that already has a test command, then `boilerplate-2026` for the WordPress/frontend stack records. Scratch clones no longer count as adoption evidence.

## Expected effect

- Real operator repositories running KRN hooks go from 0 to at least 1 within 3 weeks, and to 2 within 6. Measure: `node -e` over `~/.krn/adopted.json`, excluding paths under `/mnt/storage/tmp`.
- 5 of 5 init stacks run every installed tool in CI. Measure: `node --test test/adopt/init-gates.test.ts`, one canary per stack.
- The census "lint gate" pass rate is restated at its true value (prediction: at most 3 of 15, down from the presence-check figure). Measure: `node scripts/adoption-census.ts`.
- On the first real adopted repository, all tier 1 to 3 gate tasks close within 10 PRs. Measure: `krn task list --kind gate --json` in that repository.
- Duplicate CI: 0 adopted repositories where two workflows run the same contract command. Measure: `krn adopt --verify` prints `duplicate-ci: 0`.
- `src/adopt` shrinks by at least 500 lines. Measure: `find src/adopt -name '*.ts' | xargs cat | wc -l`.

## Consequences

- `src/adopt/host-remediation.ts` (151 lines) folds into `init.ts` as gap-filling. `canary.ts` (436) and `verify.ts` (184) become one. `census.ts` (207) moves to `evals/adoption/`. `unused.ts` is deleted.
- `scripts/first-day-walkthrough.ts` and `scripts/lane-canary.ts` are deleted in favour of `--verify`.
- `standards/records.json`: three presence records are superseded by run records, and four KRN-process records leave the universal layer (ADR 0019).
- `src/adopt/failure-tasks.ts` writes `kind`, `area`, `stack` and tier order.
- The outside rows gain descriptive debt columns in the replay harness (ADR 0021), not a new gate.

## Falsified if

- Four weeks after the first real adoption, no `gate` task has closed. Then the bottleneck is writing tests, and the next slice is a characterisation-test generator task, not more standards.
- Rewritten run checks fail fewer than 30% of the repositories that pass `s-linter-configured` today. Then the presence checks were adequate, and J7 F1 overstated the hole.
- Gate time exceeds 3 minutes per PR, or false failures exceed 5% of PRs, on an adopted repository. Then the slowest gate moves to a non-required job.
- The second real adopter also already has better gates than KRN installs, as the pilot did. Then adopt's value is categorised tasks and the brain, and tier 2 to 3 installation shrinks to gap reports.
