---
name: plesk-deploy
description: Deploy this WordPress project to a Plesk server through GitHub Actions (atomic releases over SSH to a forced-command receiver, status, rollback), prepare a Plesk domain once, and diagnose a release that does not serve. Use when setting up deploy for a client, changing what a release ships, bumping the deploy tooling, or when a deployed site returns 403 or an empty page; local runtime lives in wp-runtime.
---

# Plesk deploy

GitHub Actions builds a release (`composer install --no-dev`, theme build),
packs it and sends it over SSH to a receiver behind a forced command; the
receiver switches `BASE/current` atomically. The tooling (PHP on both sides)
lives in the private repository `Rekurencja/rekurencja-deploy`; its
`deploy/README.md` owns the contract (`BASE` layout, permissions, key
commands, journal, rollback).

**Authority.** Every change on a Plesk server, in production, in GitHub
environments or secrets, and every credential needs an explicit grant from
the operator. Reading through an existing SSH alias is not a grant to write.

```text
push to main → Check green → Deploy: build → package → status (receiver hash)
             → send → receiver: unpack, link shared, switch current, prune
             → curl /.well-known/release.json == commit
```

## What a release ships

`config/release.php` declares it: `include` paths from the root
(`composer.json`, `composer.lock`, `config`, `vendor`, `web`, `wp-cli.yml`)
and `exclude` globs (`*` = one path segment): uploads, languages, upgrade,
cache, `debug.log` and the theme's dev files (`src`, `node_modules`, `hot`,
`main.js`, `package*.json`, `*.config.js`). The packager also drops secrets
and `.git`, and is byte-for-byte deterministic. The server links `.env`,
uploads and languages from `BASE/shared` into each release, and Plesk's
`web/.php-ini` and `web/.php-version` when `shared` holds them (receiver
`77e0ed7` or newer).

`web/.htaccess` (Apache rules for Plesk) is a project file; DDEV runs nginx
and never reads it.

## Release tooling pin

`.github/workflows/deploy.yml.example` checks the tooling out by commit SHA
into `.release-tooling` (outside `config/release.php`, so it never ships).
Bump the SHA deliberately, after reading the receiver's changes, and put the
same `receiver.php` into `BASE/.deploy/` on every server first: the
**Server status** step compares the receiver hash the server reports with
`sha256sum` of the pinned file and stops on a difference.

The receiver keeps the active release plus the four most recently active
ones (rollback targets); `--keep N` (2–99) after `--root BASE` changes that.

## One-time Plesk setup

Steps in [references/plesk-setup.md](references/plesk-setup.md): PHP 8.4,
document root on `BASE/current/web` and the symlink flag, database,
`shared/.env`, receiver and deploy key, TLS, first release, theme
activation, home page, front page and menu, Polish admin, permalinks. This
first run is manual wp-cli on the server, once per domain; there is no
provisioning tool for Plesk.

## GitHub

Copy `.github/workflows/deploy.yml.example` to `deploy.yml`. It runs after a
green `Check` on `main`, only for a push to this repository (a fork's pull
request can run `Check` on a branch named `main`), and sends exactly the
checked commit, then compares the public marker `/.well-known/release.json`
with the SHA. By hand (`workflow_dispatch`) pick `action`:

| `action` | Does |
|---|---|
| `deploy` | the selected ref, or the full SHA in `commit` |
| `status` | server state: active release, stored releases, journal |
| `rollback` | to a stored full SHA; code only, database and media stay |

Environment `production` (deployments only from `main`; needs repository
admin to create):

| Name | Kind | Value |
|---|---|---|
| `DEPLOY_SSH_KEY` | secret | private half of the deploy key |
| `DEPLOY_REPO_TOKEN` | secret | fine-grained token: only `Rekurencja/rekurencja-deploy`, Contents read |
| `ACF_PRO_LICENSE`, `ACF_PRO_COMPOSER_SITE_URL` | secret | as in CI (wp-runtime skill, ACF PRO access) |
| `DEPLOY_HOST`, `DEPLOY_USER` | variable | SSH host and the subscription's system user |
| `DEPLOY_PORT` | variable | SSH port when not 22 |
| `DEPLOY_KNOWN_HOSTS` | variable | verified host key (`ssh-keyscan`, checked out of band) |
| `DEPLOY_URL` | variable | `https://domain` without a trailing `/` |

Instead of the token a read-only deploy key on the tooling repository works:
`ssh-key: ${{ secrets.DEPLOY_TOOLING_KEY }}` in place of `token` in the
tooling checkout.

Staging: copy the workflow to a second file and change `environment`,
the `concurrency` group and the job name to `staging` (the example hardcodes
`production`); the server's `shared/.env` sets `WP_ENV=staging` (mail
blocked, no WP-Cron, no outbound HTTP; wp-runtime skill).

All actions stay pinned by SHA and deploy waits for `Check`;
`tests/workflows.test.mjs` enforces both. New action versions: only releases
older than two weeks.

## Diagnosing a deployed site

| Symptom | Cause | Fix |
|---|---|---|
| 403 on static files, `error_log` says "Found symbolic link, or owner of symbolic link and link target does not match" (LiteSpeed/CloudLinux) | Plesk's `<Directory …> Options -FollowSymLinks` on the webspace, even when owners match | `plesk bin domain --update-web-server-settings <domain> -apache-restrict-follow-sym-links false` (undo: `true`) |
| Same 403 after adding `SymLinksIfOwnerMatch` to `vhost.conf`, `vhost_ssl.conf` or `.htaccess` | Plesk appends `-FollowSymLinks` after the include | do not retry these; use the flag above |
| New or changed fields missing after a deploy | field groups live in the database; the release ships only ACF JSON | the `Import ACF field groups` step (`deploy.php control HOST acf-sync`) needs receiver `6e12b79` or newer and `BASE/.deploy/wp-cli.phar` with mode 0600 |
| Home page 200 with 0 bytes | `wp core install` left a default WordPress theme active, which the release does not ship | `wp theme activate rekurencja-theme`, `wp plugin activate --all`, `wp acf json sync --type=field-group` in `BASE/current` |
| Deploy stops at **Server status** | server receiver differs from the pinned one | update `BASE/.deploy/receiver.php` to the pinned SHA |
| Marker check fails | docroot does not point at `BASE/current/web`, or a cache in front | check the docroot, then `curl -s https://domain/.well-known/release.json` |
| WP Toolkit shows `Broken` after a deploy, `web/.php-ini` and `web/.php-version` missing in `current/web` | Plesk wrote them into one release; the next release lacks them | copy both to `BASE/shared` (`cp -p`, mode 0600); receiver `77e0ed7`+ links them into every release |
| WP Toolkit shows `Broken`, WP-CLI says "does not seem to be a WordPress installation" | the WP Toolkit record points at `current/web`, but Bedrock's core is in `current/web/wp` | re-register the record on `web/wp`, see "WP Toolkit shows Broken" |
| WP Toolkit shows the instance `Broken`, the site still answers 200 | WP-CLI prints `PHP Warning: Module "mysqli" is already loaded` on the alt-PHP the domain uses (`nd_mysqli.so` loaded from the domain `php.ini` and again from the alt-PHP scan dir), so WP Toolkit cannot parse the output | see "WP Toolkit shows Broken" below |

### WP Toolkit shows Broken

1. Read-only state: `plesk ext wp-toolkit --info -instance-id <ID>` (`State`).
2. Reproduce the warning with the domain's PHP: the domain `php.ini` is
   `/var/www/vhosts/system/<domain>/etc/php.ini`; run the alt-PHP CLI from the
   domain's handler (`plesk bin php_handler --list`, `php-cli` column) with
   `-c <that php.ini> -m`. A warning on stderr with a module listed twice is the cause.
3. Find the duplicate: the domain `php.ini` `extension=` lines against
   `/opt/alt/phpXX/etc/php.d/*.ini` and `/opt/alt/phpXX/link/conf/*.ini`.
4. Fix (preferred, Plesk KB): in the Plesk panel enable `mbstring`, `json`, `mysqli`
   and disable `nd_mysqli` for the domain's PHP version (WP Toolkit bug
   EXTWPTOOLK-10849 workaround). A hand edit of the domain `php.ini` is overwritten
   the next time Plesk rewrites it (it does on subscription sync), so it is not durable.
5. Verify: `-m` reproduces no warning; `plesk ext wp-toolkit --info` state is `OK`.
   Changing the production PHP config needs a grant of its own.

Bedrock path mismatch: WP Toolkit must point at the core directory
`BASE/current/web/wp`, not the docroot `BASE/current/web`; with `web` WP-CLI
sets `ABSPATH` there and finds no core. A record cannot change its path, so
replace it (files and database stay; the record gets a new ID):

1. Save `plesk ext wp-toolkit --info -instance-id <ID>` on the host.
2. `plesk ext wp-toolkit --detach -instance-id <ID> -path <old path>`.
3. `plesk ext wp-toolkit --register -main-domain-id <domain ID> -path /<BASE under httpdocs root>/current/web/wp`.
   If it fails, register the old path again so the site stays managed.
4. Verify: state `Working`, `wp --path=BASE/current/web/wp core is-installed`
   exit 0, `siteurl` ends in `/wp`. WP-CLI with `--path=…/web` never works
   here; on the host run it as root with `--allow-root`.
5. `plesk ext wp-toolkit --clear-cache` takes the new ID; the old one is gone.

Done on `boilerplate.rekurencja.com` (2026-11-14): record 433 on
`/boilerplate-release/current/web` became 604 on `…/current/web/wp`, `Working`.

Shared alt-PHP handler, `nd_mysqli`: `plesk bin php_handler --extension-disable
nd_mysqli` can hang in `php_modules_ctl` (`find_config` loops on an absolute
`extension=/opt/alt/…/nd_mysqli.so` line in the handler `php.ini`). Do not
retry it; comment that line by hand after a copy and check
`<php-cli> -c /var/www/vhosts/system/<domain>/etc/php.ini -m` for warnings
after every Plesk rewrite of the domain `php.ini`.

Sources checked (2026-11-13): Plesk KB "WordPress installation or Cloning fails in
Plesk: Unable to load dynamic library 'mysqli.so'" (support.plesk.com article
15124297249431); CloudLinux KB "PHP Warning: Module mysqli is already loaded"
(7265550053660); CloudLinux "Missing MySQL extension or MySQL_ND vs MySQL"
(115004347574).

Verify a deploy from your own machine, not from the server (a `--resolve` to
127.0.0.1 on the server misses the vhost): the marker equals the commit, the
home page answers 200 with `lang="pl-PL"`, CSS and SVG answer 200.
