---
name: wp-runtime
description: Run, set up, diagnose and verify this WordPress project locally (Bedrock on DDEV, mise tasks, Vite with CSS HMR and PHP morph, doctor, browser gate, data, staging pull, ACF PRO access). Use when starting the project, when something local is broken, before handing over runtime or theme work, or when pulling staging data; deploying to Plesk lives in plesk-deploy.
---

# WordPress runtime

Bedrock on DDEV. The task descriptions in `mise.toml` are the source of
truth; `mise tasks` lists them. Never mutate production, remote files,
databases or credentials from here.

| Layer | Runs in | Role |
|---|---|---|
| nginx + PHP-FPM 8.4, MariaDB 11.8 | DDEV container | serves only `web/`; WordPress in `web/wp`, content in `web/app` |
| Vite (node pinned in `mise.toml`) | host, `127.0.0.1`, first free port from 5173 | CSS HMR; a `*.php` or `acf-json` change morphs `<body>` and `<title>` (Idiomorph) |
| `hot` file in the theme | host → container | tells PHP where Vite runs; Vite removes it on Ctrl+C |
| `mise run check` | host or CI | every gate that needs no container |

DDEV mounts the repository at `/var/www/html`. Host PHP (from mise) runs
only the tooling: Composer, Mago, PHPStan.

## Requirements

- DDEV with Docker, mise, `jq`.
- Host PHP with `iconv`; `mise run doctor` reports missing extensions.
- Optional `mkcert -install` (the operator runs it in a real terminal; `sudo`
  has no TTY from an agent) for trusted HTTPS; without it use `http://`.
- `auth.json` with ACF PRO Composer credentials: see
  [references/acf-pro.md](references/acf-pro.md). The key comes from the
  team's password manager (Bitwarden item "ACF PRO", read with the host's
  **bw-creds** skill); without that skill or access, ask the operator to
  write `auth.json` themselves.
- Optional **agent-browser** (a skill of the agent's host, not of this
  repository) to look at pages and wp-admin. Without it: the screenshots of
  `mise run check:browser` in `.cache/browser-check/`, or a short Node
  script with the project's pinned `playwright`, kept in the ignored
  `.cache/` so that `import 'playwright'` resolves from the repository.

## First run

```bash
mise install
mise run setup
```

`setup` runs, in order:

1. `mise run env`: creates the private `.env` (mode 600) only if missing:
   DDEV database `db`/`db`/`db` on host `db`, `WP_ENV=development`, explicit
   `WP_HOME=http://<name>.<project_tld>` from `.ddev/config.yaml`
   (`project_tld: localhost`), `WP_SITEURL=<WP_HOME>/wp`, fresh salts.
   `config/application.php` loads an optional `.env.local` over `.env`.
2. `ddev start`, then `mise run install` (`composer install`, `npm ci`,
   Playwright Chromium for `check:browser`).
3. `wp core install` if WordPress is missing. The admin password comes from
   stdin (`--prompt=admin_password`), because DDEV prints the whole command
   on failure; never pass a password as an argument.
4. Activates `rekurencja-theme` and all plugins, imports `acf-json`, runs
   `mise run provision` and `mise run doctor`.

`WP_HOME` and `WP_SITEURL` in `.env` are **full URLs**. Bedrock's env loader
does not expand `${…}` inside single quotes, and an empty `siteurl` shows a
database error on every page. `doctor` rejects such a `.env`.

`mise run provision` installs and activates `pl_PL` for the admin, creates
the Home page with a demo hero, sets it as front page and builds the menu.
`--force` replaces an existing front page.

## Daily work

```bash
ddev start
mise run dev            # Vite: CSS HMR + PHP morph
ddev wp …               # WP-CLI inside the container
mise run check          # all container-free gates
mise run check:browser  # rendered pages
```

- Without Vite the site loads built assets from `assets/dist` and makes no
  request to a dev server. A leftover `hot` file without Vite is a defect;
  `doctor` (`dev.vite`) reports it.
- The morph does not re-run JS. After a morph `document` receives the event
  `rekurencja:morphed`; listen to it when a script must re-bind. The morph
  client sets `<html data-php-morph="ready">`.
- Several projects share this host and may own port 5173. Stop only your own
  Vite: find the listening PID with `ss -ltnp` (not `$!`, which is the
  `mise` wrapper), confirm `readlink /proc/<pid>/cwd` is the theme directory
  of this repository, then `kill -INT <pid>`. Never `pkill -f` a pattern.
- `.ddev/php/opcache.ini` sets `revalidate_freq=0`; the default `2` served
  stale HTML to the morph after a quick save. If morph flakes return, find
  the cause before retrying.
- ACF fields: `ddev wp acf json status` compares the database with
  `acf-json`; `ddev wp acf json sync --type=field-group` imports it. After a
  hand edit bump `"modified"` first (the acf-component skill owns this).
- Composer changes run in the container (`ddev composer require|update …`)
  so the lock matches PHP 8.4.

## Doctor

`mise run doctor` checks host tools (pinned node, PHP extensions, composer,
mago, ddev, mkcert), private files (`.env`, `auth.json`), dependencies, the
`hot` file, HTTP and HTTPS answers, that `.env` and logs are not public, and
WordPress: install, theme, ACF PRO, `acf-json` content equal to the database
(`wp.acf-sync`), Polish admin strings (`wp.locale`) and environment guards
(`wp.guards`). `mise run doctor -- --json` prints the report for an agent.

| Exit | Meaning |
|---|---|
| 0 | everything works (warnings may remain) |
| 1 | a defect to fix; `checks[].detail` says how |
| 2 | no defect, but some checks could not run (e.g. DDEV stopped) |

Fix broken host things instead of working around them when the fix is local
and reversible; ask for a grant when it needs root, the firewall, the Docker
daemon or a system package.

## Browser gate

`mise run check:browser` builds the theme and opens, in Playwright Chromium,
the front page, pages from the navigation and every published page from the
REST API (at most 12 pages) at 320, 390 and 1280 px. It fails on horizontal
overflow, a console error, a failed request or an HTTP status ≥ 400, a
request to a foreign origin (Vite, CDN), or a serious/critical axe WCAG 2.2
AA issue (axe at 390 and 1280). `source.no-cdn` also fails when a tracked
file names the CDN host it greps for (see that check in
`tools/browser-check.mjs`); the template's notes and the gate itself are
excepted.
A load aborted with `net::ERR_NETWORK_CHANGED` (another project's Docker
network changed the host's interfaces) is retried once; any other load
error fails.
Screenshots at 390 and 1280 go to `.cache/browser-check/`.
`BROWSER_CHECK_URL` overrides the site URL.

The `hot` file picks the mode:

- **without Vite**: built assets only;
- **with `mise run dev`**: also edits `footer.php` and `global-styles.css`
  for a moment (restored, also on Ctrl+C) and proves that the PHP morph and
  CSS HMR keep scroll position, typed text and focus.

Runtime or theme work is done only after `mise run check` and
`mise run check:browser` pass **both** with and without `mise run dev`.
Exit codes as in `doctor` (2 = site does not answer). CI runs both modes on a
fresh DDEV.

## Logging into wp-admin from an agent browser

Generate a cookie inside the container (`wp_generate_auth_cookie(1, …)` via
`ddev wp eval`) into a file in your scratchpad, load it with the browser's
cookie command for the site URL, delete the file. Never print the value.
Use your own browser session name, not the shared default.

## Data, environments, staging

See [references/environments.md](references/environments.md): database
export and import, the environment table enforced by `wp.guards`, and
`ddev pull staging`.

## Files that never enter git

`.env`, `auth.json`, `vendor/`, `node_modules/`, uploads, `web/app/languages`
and database dumps.
