# Standards audit

| record | php | npm | py | ymir-row |
| --- | --- | --- | --- | --- |
| s-tests-tracked | pass | pass | pass | pass |
| s-test-command | FAIL | pass | pass | pass |
| s-test-exit-code | pass | pass | pass | pass |
| s-ci-runs-tests | FAIL | FAIL | FAIL | pass |
| s-lockfile-committed | n/a | FAIL | n/a | n/a |
| s-no-secrets-tracked | pass | pass | pass | pass |
| s-no-dependency-dirs-tracked | pass | pass | pass | pass |
| s-gitignore-deps | n/a | pass | pass | n/a |
| s-linter-configured | FAIL | FAIL | FAIL | pass |
| s-typescript-strict | n/a | pass | n/a | n/a |
| s-readme-test-command | FAIL | FAIL | FAIL | pass |
| s-no-conflict-markers | pass | pass | pass | pass |
| s-one-instruction-file | pass | pass | pass | pass |
| s-clean-checkout-tests | pass | pass | pass | pass |
| s-regression-lowest-layer | advisory | advisory | advisory | advisory |
| s-plainest-input | advisory | advisory | advisory | advisory |
| s-receiver-evidence | advisory | advisory | advisory | advisory |
| s-role-names | pass | pass | pass | pass |
| s-exit-codes | pass | pass | pass | pass |
| s-secrets-redacted | pass | pass | pass | pass |
| s-no-shared-stash | pass | pass | pass | pass |
| s-task-records | pass | pass | pass | pass |
| s-repo-contract | pass | pass | pass | pass |
| s-agent-state | pass | pass | pass | pass |
| s-finish-gate | pass | pass | pass | pass |
| s-ticket-trailer | pass | pass | pass | pass |
| s-php-composer-lock | pass | n/a | n/a | FAIL |
| s-php-composer-scripts | FAIL | n/a | n/a | FAIL |
| s-php-no-raw-request-output | pass | n/a | n/a | pass |
| s-php-no-tracked-salts | pass | n/a | n/a | pass |
| s-php-no-error-suppression | pass | n/a | n/a | FAIL |
| s-php-no-empty-catch | pass | n/a | n/a | FAIL |
| s-php-no-eval | pass | n/a | n/a | pass |
| s-php-autoload-declared | pass | n/a | n/a | pass |
| s-php-composer-no-wildcard | pass | n/a | n/a | pass |
| s-wp-escape-translations | n/a | n/a | n/a | pass |
| s-wp-nonce-on-request | n/a | n/a | n/a | pass |
| s-wp-prepared-queries | n/a | n/a | n/a | pass |
| s-wp-text-domain-literal | n/a | n/a | n/a | pass |
| s-wp-release-version-matches-readme | n/a | n/a | n/a | pass |
| s-semantic-commits | pass | pass | pass | pass |
| s-noninteractive-remote-commands | pass | pass | pass | pass |
| s-no-whitespace-errors | pass | pass | pass | pass |
| s-skill-acf-component | n/a | n/a | n/a | advisory |
| s-skill-cube-css | n/a | n/a | n/a | advisory |
| s-skill-cube-review | n/a | n/a | n/a | advisory |
| s-skill-design-to-build | n/a | n/a | n/a | advisory |
| s-skill-plesk-deploy | n/a | n/a | n/a | advisory |
| s-skill-wp-runtime | n/a | n/a | n/a | advisory |
| s-no-private-key-tracked | pass | pass | pass | pass |
| s-ts-no-any | n/a | pass | n/a | n/a |
| s-ts-no-suppressions | n/a | pass | n/a | n/a |
| s-ts-no-star-reexport | n/a | pass | n/a | n/a |
| s-no-deep-relative-imports | n/a | pass | n/a | n/a |
| s-node-no-empty-catch | n/a | pass | n/a | n/a |
| s-py-no-bare-except | n/a | n/a | pass | n/a |
| s-py-no-mutable-default | n/a | n/a | pass | n/a |
| s-py-no-unsafe-execution | n/a | n/a | pass | n/a |
| s-node-no-dynamic-code | n/a | pass | n/a | n/a |
| s-no-wildcard-dependencies | pass | pass | n/a | FAIL |
| s-release-notes | n/a | FAIL | pass | n/a |
| s-task-states-proof | pass | pass | pass | pass |

FAIL cells per row: php=5, npm=5, py=3, ymir-row=5

A FAIL is a false red when the row satisfies what the record means and the record still fails. After this change: 0 false-red cells. Every FAIL is a real gap of the row:

- php, npm, py: as before (`s-test-command`, `s-php-composer-scripts`, `s-ci-runs-tests`, `s-linter-configured`, `s-readme-test-command`, `s-lockfile-committed` name settings the upstream repository lacks).
- ymir-row: `s-php-composer-lock` (no tracked composer.lock), `s-php-composer-scripts` (no test or lint script), `s-php-no-error-suppression` (two `@getimagesize` calls), `s-php-no-empty-catch` (empty catch in AbstractCloudStorageStreamWrapper and HealthCheckSubscriber).

The WordPress records are non-n/a on ymir-row: a plugin header in a top-level PHP file makes a repository WordPress. Its `ext-*: "*"` requirements and its nonce-checked `$_POST` handler are the traps the green fixtures hold: both pass. The `s-skill-*` records show `advisory` on ymir-row (they apply, and are never run); the other rows are not WordPress.
