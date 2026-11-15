# Data, environments and staging

## Local data

```bash
ddev export-db --file=.ddev/db_snapshots/local.sql.gz
ddev import-db --file=path/to/dump.sql.gz
ddev snapshot
```

Dumps stay out of git.

## Environments

`WP_ENV` in `.env` selects `config/environments/<env>.php`.

| Environment | Mail | WP-Cron | Outbound HTTP |
|---|---|---|---|
| `development` (DDEV) | blocked | runs | allowed |
| `staging` | blocked | `DISABLE_WP_CRON` | `WP_HTTP_BLOCK_EXTERNAL` |
| `production` | sent | runs | allowed |

`web/app/mu-plugins/environment-guards.php` blocks mail outside production
(`pre_wp_mail`); when `WP_DEBUG_LOG` is on (development) the attempt is
written to `debug.log`. The
whole table is a gate: `doctor` (`wp.guards`) runs `tools/wp-probe.php` under
each `WP_ENV` and compares the result with the table; CI runs it at the end
of `setup`.

## Pulling staging

`ddev pull staging` brings the staging database and uploads into local DDEV:

1. Copy `.ddev/providers/staging.yaml.example` to `staging.yaml`.
2. Fill the SSH alias, `BASE` (deploy layout: `BASE/current` is the release,
   `BASE/shared/uploads` the uploads; plesk-deploy skill), the staging host,
   the PHP handler path and WP-CLI path.
3. `ddev auth ssh`, then `ddev pull staging`.

The provider only reads staging. The import replaces URLs and leaves
plugins, theme and cron alone. There is no push: content flows staging →
local, code goes through deploy. A placeholder guard stops before any SSH
while the example values are still there.
