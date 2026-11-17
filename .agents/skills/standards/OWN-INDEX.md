# Own standards index

Generated from .agents/standards.json by `node scripts/render-standards-index.ts --write`; do not edit.
The repository's own enforced records, beside the pack index: `id [first path scope +others]: rule`. Each is checked by `krn standards check --record <id>`.
s-finish-gate-worker-stop: KRN's own Stop hook runs `src/hook/stop.ts` (the gate `krn hook stop` runs in adopted repositories), which refuses the end of a session while the related tests are red
s-ci-biome-clean [**/*.ts+3]: Code and JSON pass Biome with warnings as errors; run npm run fast, which formats with biome --write, before every commit
s-ci-import-boundaries [src/**+1]: Imports between src areas follow the layer map in scripts/boundaries.ts; core imports only its own files
s-ci-task-quality [tasks/**]: Task records pass every task-quality rule: a stated outcome, a Proof as `cmd: verdict` and the Files they touch
s-ci-typecheck [**/*.ts+1]: The tree typechecks under tsc --noEmit; every tracked .ts file is reached by the tsconfig include globs
s-ci-commit-title [scripts/commit-title.ts]: The PR title, which becomes the squash subject, reads `type(scope): outcome (t-id)`
s-ci-weakened-tests [test/**]: A PR deletes no assertion, adds no skip, only or todo, and deletes no test file whose target stays, unless its body has a `Weakens-tests: <reason>` line
s-ci-task-records [tasks/**]: A PR whose commits carry `Ticket: <id>` closes that task; work that leaves it open carries `Refs: <id>`
s-ci-test-suite [test/**+1]: The full suite passes in every CI shard; a new test file under test/ mirrors its src area and uses node:test
s-ci-agent-config-secrets [.claude/**+2]: Tracked agent config holds no token-shaped values
s-ci-capture-privacy [test/fixtures/**]: Committed receiver captures carry no account state: credit balance, usage or installation id
s-ci-commit-title-format [scripts/commit-title.ts]: Commit and PR titles keep the conventional `type(scope): outcome (t-id)` form
s-ci-context-budget-hooks [.claude/settings.json+1]: Context budget settings wire the documented hooks, and the project gauge matcher names every built-in tool the ceiling refuses
s-ci-docs-referenced [docs/**]: Every file under docs/ is named by a rule, test, skill, hook or script that reads it
s-ci-flag-value-reader [src/cli/**+1]: CLI value flags read their value through the shared reader, never a `startsWith("--")` missing-value check
s-ci-format-contract [spec/schema/**+2]: Every format the build reads has a schema file under spec/schema, krn.json declares it, and every task file conforms to krn.task/v1
s-ci-harness-literals [src/**]: Outside src/harness no string literal names the `.claude` directory or the `claude` binary
s-ci-shell-quoting [src/**+2]: Shell text is quoted with shellWord (src/repo/shell-text.ts), never `sh -c ${JSON.stringify(x)}`
s-ci-host-path-guard [src/**+2]: Tracked tests, scripts and sources name no host-specific path; captures use the redaction placeholder
s-ci-instruction-bytes [AGENTS.md+4]: Agent instruction bytes stay within spec/context-budget.json; growth is a reviewed edit of that file with its reason in the PR body
s-ci-instruction-references [AGENTS.md+3]: Instruction text names only npm scripts and repository files that exist
s-ci-lane-close-rule [AGENTS.md+1]: KRN-11 and the lane brief agree: a lane closes its own task in its own PR and names the close command and the Ticket trailer
s-ci-lane-limit [.agents/skills/delivery-lead/**+1]: Lead surfaces state only the lane budget limit and never merge with gh pr merge
s-ci-lead-traps [.agents/skills/delivery-lead/**+1]: The open traps section of the lead loop is `none` or a list of ids that each have a workaround
s-ci-lint-warnings [biome.json+1]: npm run lint fails on Biome warnings
s-ci-local-settings-ignore [.gitignore+1]: The repository .gitignore ignores local Claude settings without relying on global excludes
s-ci-one-owner-docs [docs/program/**]: plan.md is the one plan file and each delivery rule text has one owner; other docs point to it
s-ci-role-names-paths [src/**+2]: Tracked code, test and script paths carry no phase, slice, ticket or round tokens
s-ci-project-skills [.agents/skills/**+2]: The lead loop skills are project skills for Codex and Claude Code, name the real launch command, and every agent file has a description
s-ci-receiver-evidence [src/**+1]: Every module that spawns a receiver names its evidence in spec/receivers.json: a verbatim capture, a test driving the real receiver, or `pending: <open task>`
s-ci-required-check-owner [src/**+1]: The required check App id and check name come from spec/ci-admission.json; no source repeats the literal
s-ci-sandbox-stubs [**/*]: No tracked file is an empty sandbox placeholder; stage files by name, never git add -A
s-ci-session-role [AGENTS.md+2]: The lead role is tied to the delivery-lead skill in one workflow paragraph; a session without a lead brief stays in its checkout
s-ci-settings-hygiene [.claude/settings.json+1]: Every project hook command has a timeout and runs a script that exists
s-ci-shard-weights [test/**+1]: No shard weight names a deleted test file, and no test file is heavy enough to bound its shard wall; a recorded weight lives in scripts/lib/shard-weights.json
s-ci-steering-consistency [AGENTS.md+2]: Each steering fact stated in the instruction files holds in the code it describes
s-ci-test-hygiene [test/**]: Tests never wait on the clock, skip without quarantine, assert wall-clock deltas or set a per-test timeout; poll a condition under a deadline
s-ci-transcript-readers [src/**]: No source outside src/harness reads transcript files
s-ci-typecheck-coverage [tsconfig.json+1]: The tsconfig include covers every tracked .ts file
s-ci-fr40-freeze [evals/fr40/**+2]: The frozen FR-40 inputs match what the freeze regenerates; regenerate them when the layer map or repo contract changes
