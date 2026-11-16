# Standards index

Generated from standards/records.json by `node scripts/render-standards-index.ts --write`; do not edit.
One line per enforced record: `id [first path scope +others]: rule`. Each is checked by `krn standards check --record <id>`.
Ask `krn standards query "<what you do>" --file <path>` for the full text and the reason.
s-tests-tracked: The repository tracks automated tests next to the code they cover
s-test-command [krn.json+1]: The repository declares one test command that runs its tests, never a placeholder
s-test-exit-code: The test command exits non-zero when a test fails: no `|| true`, `; exit 0` or leading `-` masks its status
s-lockfile-committed [package.json+4]: The dependency lockfile of the stack is tracked, so every checkout installs the same versions
s-no-secrets-tracked: No tracked file is a credential file or holds a private key or provider token
s-no-dependency-dirs-tracked [package.json+4]: Installed dependencies, caches and bytecode are never tracked
s-gitignore-deps [package.json+4]: The ignore rules cover the dependency and build directories of the stack
s-readme-test-command: The README states how to run the tests
s-no-conflict-markers: No tracked file holds an unresolved merge conflict marker
s-one-instruction-file: A repository keeps one instruction file for agents, AGENTS.md; any other agent instruction file is a link to it or points to it
s-clean-checkout-tests: The test suite gives the same verdict on a clean checkout: no test depends on untracked local state such as an earlier build or the enclosing repository
s-regression-lowest-layer: A fixed defect gets its regression test in the same commit: each of the last ten `fix` commits touches a test file, or carries a `No-test: <reason>` line
s-role-names: Files, functions, tests and work are named by purpose and role, never by phase, ticket, round, date or version
s-exit-codes: Every error path has a stated exit code (64 usage, 65 invalid data, 70 internal, 75 temporary) and a message on stderr
s-secrets-redacted: Values that may hold credentials, multiline ones included, are redacted before they are logged, persisted or forwarded
s-no-shared-stash: Never change the git stash stack with a bare `git stash` or `git stash pop`; set work aside with a commit
s-task-records [tasks/**]: Task status lives in valid `tasks/<id>.json` records that only `krn task` changes
s-repo-contract [krn.json+1]: The repository contract names a test command, so lanes and the finish gate know what to run
s-agent-state: Agent notes, plans, logs and scratch files go under the git-ignored `.krn/` directory, never into tracked files or the repository root
s-finish-gate: A session cannot end while the tests related to its change are red: a Stop hook entry in `.claude/settings.json` runs a command that refuses the end (`krn hook stop` when adopted, or the repository's own stop script)
s-ticket-trailer: A commit that completes a managed task ends with a `Ticket: <id>` trailer; a commit that leaves the task open carries `Refs: <id>` instead
s-php-composer-lock [**/*.php]: A PHP project that declares Composer packages tracks its composer.lock
s-php-composer-scripts [**/*.php]: A PHP project with composer.json declares the composer scripts `test` and `lint`, so agents and CI run the same named checks
s-php-no-raw-request-output [**/*.php]: PHP code never echoes request input (`$_GET`, `$_POST`, `$_REQUEST`, `$_COOKIE`) without escaping it at the output boundary
s-php-no-tracked-salts [**/*.php]: No tracked PHP file defines a WordPress authentication key or salt as a literal; secrets, salts and deployment settings live in the private .env
s-php-no-error-suppression [**/*.php]: PHP code does not silence a function call with the `@` prefix; it checks the result or catches the exception
s-php-no-empty-catch [**/*.php]: A PHP `catch` block is never empty; it handles, logs or rethrows the error, or says in a comment why it is ignored
s-php-no-eval [**/*.php]: PHP code does not call `eval()` or `create_function()`; behavior is written as code or looked up in a map
s-php-autoload-declared [**/*.php]: A PHP project with Composer and classes under a src directory declares its Composer autoload, so classes load by namespace and not by hand-written require calls
s-php-composer-no-wildcard [**/*.php]: composer.json never requires a package at `*`, `dev-*` or `@dev`; each package carries a version constraint a release can be rebuilt from
s-wp-escape-translations [**/*.php]: WordPress templates print translated text through `esc_html_e`, `esc_attr_e` or `esc_html__`, never the bare `_e()` or `echo __()`
s-wp-nonce-on-request [**/*.php]: A WordPress PHP file that reads `$_POST` or `$_REQUEST` verifies a nonce (`wp_verify_nonce`, `check_admin_referer`, `check_ajax_referer`) or a REST `permission_callback`
s-wp-prepared-queries [**/*.php]: A WordPress database call (`$wpdb->query`, `get_results`, `get_var`, `get_row`, `get_col`) never builds its SQL from an interpolated or concatenated variable; it goes through `$wpdb->prepare`
s-wp-rest-permission-callback [**/*.php]: Every WordPress `register_rest_route` call declares a `permission_callback`; a public route says so with `__return_true`
s-wp-capability-with-nonce [**/*.php]: A WordPress PHP file that verifies a nonce (`wp_verify_nonce`, `check_admin_referer`, `check_ajax_referer`) also checks a capability with `current_user_can`, unless it only serves logged-out `nopriv` hooks
s-wp-sanitize-before-store [**/*.php]: WordPress never stores a raw `$_POST`, `$_GET` or `$_REQUEST` value with `update_option`, `add_option` or a `*_meta` writer: the value passes a `sanitize_*`, `absint`, `intval`, `wp_kses*` or a typed cast first
s-wp-text-domain-literal [**/*.php]: WordPress translation calls pass the text domain as one string literal, the same in every call of the repository (the `default` core domain aside)
s-wp-release-version-matches-readme [readme.txt+1]: A WordPress plugin that ships a readme.txt keeps its `Stable tag` equal to the `Version` header of the plugin file
s-semantic-commits: Commit subjects since the repository adopted krn are semantic: `type(scope): outcome` with a conventional type such as feat, fix, docs, chore or refactor
s-noninteractive-remote-commands [.github/workflows/**+1]: Tracked shell scripts run ssh and scp with `-o BatchMode=yes` and apt-get install with `-y`, so they fail instead of waiting for a prompt
s-no-whitespace-errors: Uncommitted changes pass `git diff --check`: no trailing whitespace, no space-before-tab, no conflict markers
s-skill-acf-component [**/*.php+2]: Every ACF field group JSON file under `acf-json/` parses and carries its stored `key`
s-skill-cube-css [**/*.css+1]: Theme CSS carries no `!important` without a comment on the same line
s-skill-plesk-deploy [.github/workflows/*.yml+2]: Deploy workflows and deploy files neither disable SSH host-key checking nor use the release tooling without a commit SHA pin
s-skill-wp-runtime [mise.toml+3]: `.env`, `auth.json` and `node_modules/` are not tracked
s-no-private-key-tracked: No tracked file holds a PEM private key block (a line that starts with `-----BEGIN ..
s-ts-no-any [**/*.ts+3]: TypeScript source never types a value `any`: use `unknown` and narrow it
s-ts-no-suppressions [**/*.ts+3]: TypeScript source carries no `@ts-ignore` or `@ts-nocheck` comment: an unavoidable suppression is a narrowly scoped `@ts-expect-error` with a reason
s-ts-no-star-reexport [**/*.ts+3]: TypeScript modules do not use `export * from`: import the owning module, or export the named symbols that callers need
s-no-deep-relative-imports [**/*.ts+3]: Source modules do not import across four or more directory levels (`../../../../x`): a caller that far away reaches past the owner of the concern
s-node-no-empty-catch [**/*.ts+3]: JavaScript and TypeScript never swallow an error with an empty `catch {}` or `.catch(() => {})`: handle it, rethrow it or report it
s-ts-no-floating-promises [**/*.ts+3]: A JavaScript or TypeScript project with a Biome or ESLint config lints floating promises: Biome `noFloatingPromises` or `@typescript-eslint/no-floating-promises` is on
s-py-no-bare-except [**/*.py]: Python never uses a bare `except:`: name the exception the code can handle
s-py-no-mutable-default [**/*.py]: Python function signatures never default a parameter to a mutable literal (`[]`, `{}`, `set()`): default to `None` and create the value inside
s-py-no-unsafe-execution [**/*.py]: Python outside tests never runs text as code or as a shell line: no `eval(`, `exec(`, `os.system(`, `pickle.load(s)` or `shell=True`
s-node-no-dynamic-code [**/*.ts+3]: JavaScript and TypeScript outside tests never run text as code: no `eval(` and no `new Function(`
s-no-wildcard-dependencies [package.json+4]: package.json and composer.json never declare a dependency at `*`, `latest` or a development branch: a version range names a floor and a ceiling
s-release-notes [**/*.ts+4]: A versioned package keeps release notes: a CHANGELOG, HISTORY, NEWS, RELEASE or CHANGES file, or a release workflow
s-go-gofmt [**/*.go+1]: Tracked Go files are gofmt-formatted, so formatting is never a review topic
s-go-vet-run [**/*.go+1]: Go vet or a golangci-lint configuration runs in the repository's checks (a golangci config, workflow, Makefile or script names it)
s-go-sum-committed [package.json+4]: A Go module that requires other modules tracks go.sum beside its go.mod
s-go-wrapped-errors [**/*.go+1]: Go errors that are passed on are wrapped with `%w`, not formatted with `%v` or `%s`
s-go-no-library-panic [**/*.go+1]: Go library code returns errors instead of calling `panic`: only package main, init, Must* constructors, tests and generated code may panic
s-go-tests-beside-code [**/*.go+1]: Every Go package directory that declares functions has a _test.go file beside its code (package main, generated code and cmd, tools and examples directories excepted)
s-go-context-first [**/*.go+1]: A Go function that takes a context.Context takes it as its first parameter
s-go-pinned-toolchain [**/*.go+1]: go.mod pins the Go language version, and a workflow that sets a floating `stable`, `oldstable` or `latest` toolchain also pins one (go-version-file or a numeric go-version)
s-py-pinned-dependencies [package.json+4]: Every requirement in a tracked requirements*.txt is pinned with `==` (or `@` for a direct reference)
s-py-typecheck-configured [**/*.py]: A static type checker (mypy, pyright, ty, pyre or pytype) is configured for the Python project
s-py-linter-configured [**/*.py]: A Python linter (ruff, flake8 or pylint) is configured, not only a formatter
s-py-src-layout [**/*.py]: Importable Python packages live in a src directory, not at the repository root (a Django project with manage.py is excepted)
s-rust-lock-committed [package.json+4]: Every tracked Cargo.toml has a tracked Cargo.lock in its directory or above it
s-rust-fmt-check [**/*.rs+1]: Tracked Rust files pass cargo fmt --check, so formatting is never a review topic
s-rust-clippy-deny-warnings [**/*.rs+1]: Clippy runs in the repository's checks with warnings denied (a workflow, Makefile or script passes -D warnings, or Cargo.toml sets clippy lints)
s-rust-no-library-unwrap [**/*.rs+1]: Library Rust code outside tests never calls unwrap(): return the error or state the invariant with expect
s-rust-pinned-toolchain [**/*.rs+1]: A Rust project pins its toolchain: a tracked rust-toolchain file, or rust-version in Cargo.toml
s-rust-tests-present [**/*.rs+1]: A Rust crate tracks tests: a tests/ integration file or a #[test] function
s-gate-lint-runs [krn.json+1]: The lint command named in krn.json exits 0 on the base branch (a tool that is not installed in this checkout is left to CI)
s-gate-typecheck-runs [krn.json+1]: The typecheck command named in krn.json exits 0 on the base branch (a tool that is not installed in this checkout is left to CI)
s-gate-in-ci [krn.json+1]: A workflow that runs on pull requests invokes every test, lint and typecheck command the contract in krn.json names
s-frontend-verify-agent-browser: Verify a frontend change in the browser with agent-browser snapshot -i, console and a screenshot before it is done
s-frontend-browser-gate-axe: Gate rendered pages in CI with Playwright and axe-core: no console errors, overflow or serious axe violations
