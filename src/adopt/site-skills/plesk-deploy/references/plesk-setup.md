# One-time Plesk setup

Done by the operator, or by an agent holding a separate grant for that
server. By convention note host, user and paths in the ignored local `.env`
as `DEPLOY_*` (no tool reads them; the workflow uses GitHub variables),
never in the repository. Pass any password through a file descriptor or
stdin, never as an argument; one attempt per credential, then stop (Plesk
hosts run fail2ban).

Before planning, read the domain's real state: is it its own subscription or
an additional domain in a shared one (shared system user, CageFS), what is
the current document root and PHP handler, which PHP CLI paths exist.

1. **PHP 8.4** for the domain (FPM). Read the CLI path from the server:
   Plesk builds `/opt/plesk/php/8.4/bin/php`, CloudLinux alt-PHP
   `/opt/alt/php84/usr/bin/php`. Do not assume either exists.
2. **Document root** `BASE/current/web` in the hosting settings, not a
   symlinked `httpdocs`. Keep the old docroot until the first release
   serves; switching back is the rollback. The web server must follow the
   `current` symlink; Plesk sets `Options -FollowSymLinks` by default and
   LiteSpeed then answers 403 on static files. Lift it for this domain only:

   ```bash
   plesk bin domain --update-web-server-settings <domain> -apache-restrict-follow-sym-links false
   ```

   `SymLinksIfOwnerMatch` in `vhost.conf` or `.htaccess` is not enough:
   Plesk appends `-FollowSymLinks` after it.
3. **Database** and its user inside the subscription; credentials only in
   `BASE/shared/.env`.
4. **`BASE`**, owned by the subscription's system user (the tooling README
   is the full contract):

   ```text
   BASE/
     current -> releases/<sha>   switched atomically by the receiver
     releases/<sha>/             immutable releases, activation order
     shared/        0755         you create it
       .env         0600         you create it
       uploads/     0755         you create it
       languages/   0755         receiver creates it
       .php-ini     0600         copy of Plesk's file, if Plesk wrote one
       .php-version 0600         copy of Plesk's file, if Plesk wrote one
     .deploy/       0700         receiver.php, wp-cli.phar 0600 (you install), journal
   ```

   The receiver links `.env`, `web/app/uploads` and `web/app/languages` from
   `shared` into each release, and `web/.php-ini` and `web/.php-version` when
   `shared` has them (Plesk writes both into `current/web` to pin the PHP
   that WP Toolkit and its CLI use; a release would otherwise drop them, so
   copy them to `shared` with `cp -p` once Plesk has written them); the packager writes the marker
   `web/.well-known/release.json` = `{"commit":"<sha>"}`. `BASE/shared/.env` holds
   `WP_ENV=production`, `WP_HOME` and `WP_SITEURL` as **full URLs**
   (`https://domain`, `https://domain/wp`; Bedrock does not expand `${…}`
   in single quotes), the database and fresh salts (`mise run env` on a
   scratch copy generates them).
5. **Receiver and key.** `receiver.php` from the pinned SHA into
   `BASE/.deploy/`, and the wp-cli phar (https://wp-cli.org/#installing) as
   `BASE/.deploy/wp-cli.phar` with mode 0600: the workflow's `acf-sync` step
   runs it in the active release to import ACF JSON after every deploy; the deploy public key in `authorized_keys` with a forced
   command on the PHP 8.4 CLI from step 1:

   ```text
   restrict,command="/opt/alt/php84/usr/bin/php BASE/.deploy/receiver.php --root BASE" ssh-ed25519 AAAA… deploy@<project>
   ```

6. **TLS**: Let's Encrypt and the HTTPS redirect; HSTS only after the domain
   is verified.
   - https://docs.plesk.com/en-US/obsidian/customer-guide/websites-and-domains/securing-connections-with-ssltls-certificates/securing-connections-with-the-ssl-it%21-extension.65160/
   - Document root: https://docs.plesk.com/en-US/obsidian/quick-start-guide/plesk-functionality-explained/managing-web-hosting.74401/
7. **First release**, then `wp core install` or `wp db import` in
   `BASE/current`. After a fresh install do what local `setup` does:

   ```bash
   wp theme activate rekurencja-theme
   wp plugin activate --all
   wp acf json sync --type=field-group
   ```

   Without the theme activation the default WordPress theme stays active;
   the release does not ship it, so the page is empty.

   Then the home page, front page and primary menu that local `provision`
   makes with `tools/provision-site.php` (the release does not ship `tools/`):

   ```bash
   home=$(wp post create --post_type=page --post_title=Home --post_name=home --post_status=publish --porcelain)
   wp option update show_on_front page
   wp option update page_on_front "$home"
   wp menu create Primary
   wp menu location assign Primary primary
   wp menu item add-post Primary "$home"
   ```

   Skip a command whose result already exists (`wp option get page_on_front`,
   `wp menu list`); content goes in through wp-admin (Flexible Content on
   the page), never as a template choice from the database. Done when
   `https://domain/` renders the theme header and the page sections, and
   `https://domain/.well-known/release.json` names the deployed commit.
8. **Polish admin**, once. `web/app/languages` is a symlink the WordPress
   translation installer cannot replace, so point it at the real directory:

   ```bash
   wp --exec="define('WP_LANG_DIR', 'BASE/shared/languages');" language core install pl_PL --activate
   ```

   Translations survive later releases. `--prompt=admin_password` echoes the
   whole command including the password; outside your own terminal set the
   password separately with `wp_set_password()` in `wp eval`, reading the
   value from stdin.
9. **Permalinks** `/%postname%/` (`wp rewrite structure '/%postname%/'`,
   without `--hard`: `web/.htaccess` from the repository already has the
   rules).
