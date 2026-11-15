# Standards coverage

Area by stack matrix of `standards/records.json`. A cell lists the record ids (without the `s-` prefix) that apply to that area on that stack; `*` marks a record added by the coverage pass, `(a)` an advisory record with no check, `-` an uncovered cell. Regenerate by grouping the pack on `area` and `applies.stacks`.

Before the pass the pack held 39 records: 26 executable (mostly hygiene, four PHP), 7 advisory without a check and 6 WordPress or frontend skill pointers. Nothing covered task quality, architecture, error handling, releases or non-PHP security, and Python and TypeScript had one record each.

After: 52 records, 43 enforced. Thirteen records are new, each with a red and a green fixture in `test/cli/standards-coverage.test.ts` run through the real `krn standards check --record`. Five advisory records became enforced (`no-shared-stash`, `secrets-redacted`, `exit-codes`, `role-names`, `ticket-trailer`), leaving 3 advisory outside the need-scoped skill pointers (`regression-lowest-layer`, `plainest-input`, `receiver-evidence`: each is a judgement about test content that no grep can decide).

Narrowing of the five converted records: a check is the mechanical shape of the sentence, not the whole sentence. `exit-codes` fails a caught error that ends in `exit(0)`; `secrets-redacted` fails a log call whose argument is an identifier named password, secret, api key or token; `role-names` fails a tracked code file named by phase, round, task id, date or version; `ticket-trailer` fails a `Ticket:` or `Refs:` trailer since adoption that names no `tasks/<id>.json`; `no-shared-stash` fails a stash push, pop, apply, drop or bare stash in a script, workflow or Makefile. `release-notes` is tier finish (reported only); the converted `exit-codes`, `secrets-redacted`, `role-names` and `ticket-trailer` stay finish as before, and `no-shared-stash` is reflex.

| area | any stack | node | python | php | go | site (WordPress, frontend) |
| --- | --- | --- | --- | --- | --- | --- |
| agent-state | agent-state | - | - | - | - | - |
| architecture | - | ts-no-star-reexport *<br>no-deep-relative-imports * | - | - | - | - |
| commit | ticket-trailer | - | - | - | - | - |
| commits | semantic-commits<br>no-whitespace-errors | - | - | - | - | - |
| dependencies | no-dependency-dirs-tracked | lockfile-committed<br>gitignore-deps<br>no-wildcard-dependencies * | gitignore-deps | php-composer-lock<br>no-wildcard-dependencies * | lockfile-committed | - |
| docs | readme-test-command | - | - | - | - | - |
| error-handling | - | node-no-empty-catch * | py-no-bare-except * | - | - | - |
| finish-gate | finish-gate | - | - | - | - | - |
| frontend | - | - | - | - | - | (a) skill-cube-css<br>(a) skill-cube-review<br>(a) skill-design-to-build |
| hardening | exit-codes<br>secrets-redacted | - | - | - | - | - |
| instructions | one-instruction-file | - | - | - | - | - |
| integration | ci-runs-tests<br>no-conflict-markers | - | - | - | - | - |
| lanes | no-shared-stash | - | - | - | - | - |
| naming | role-names | - | - | - | - | - |
| py-specifics | - | - | py-no-mutable-default * | - | - | - |
| releases | - | release-notes * | release-notes * | - | - | - |
| scripts | noninteractive-remote-commands | - | - | - | - | - |
| secrets | no-secrets-tracked<br>no-private-key-tracked * | - | - | php-no-tracked-salts | - | - |
| security | - | node-no-dynamic-code * | py-no-unsafe-execution * | php-no-raw-request-output | - | - |
| style | linter-configured | - | - | - | - | - |
| task-quality | task-states-proof * | - | - | - | - | - |
| tests | tests-tracked<br>test-command<br>test-exit-code<br>clean-checkout-tests<br>(a) regression-lowest-layer<br>(a) plainest-input<br>(a) receiver-evidence<br>repo-contract | - | - | php-composer-scripts | - | - |
| tracker | task-records | - | - | - | - | - |
| types | - | typescript-strict<br>ts-no-any *<br>ts-no-suppressions * | - | - | - | - |
| wordpress | - | - | - | - | - | (a) skill-acf-component<br>(a) skill-plesk-deploy<br>(a) skill-wp-runtime |

52 records, 43 enforced; advisory outside need-scoped skills: s-regression-lowest-layer, s-plainest-input, s-receiver-evidence

Remaining gaps, by cell: Go has only the lockfile record; PHP has no error-handling, architecture or release record; Python and TypeScript have no dependency-pinning record beyond the wildcard check; the site column holds only advisory skill pointers.
