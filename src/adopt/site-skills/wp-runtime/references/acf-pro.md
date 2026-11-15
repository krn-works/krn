# ACF PRO access

ACF PRO is a Composer dependency installed into
`web/app/plugins/advanced-custom-fields-pro` (a normal plugin, not an
MU-plugin, so Bedrock and WordPress handle it without an MU loader).

## Composer credentials

Composer downloads it from `connect.advancedcustomfields.com` with HTTP
Basic: username = licence key, password = a site URL of the project. Locally
they live in the ignored `auth.json` at the repository root:

```json
{
  "http-basic": {
    "connect.advancedcustomfields.com": {
      "username": "<licence key>",
      "password": "<site URL>"
    }
  }
}
```

The source is the Bitwarden item "ACF PRO", read with the bw-creds skill of
the agent's host (not part of this repository). Without that skill or vault
access, the operator writes the file. Write it from the password manager or
an editor; the key never goes into chat, logs
or command arguments. `doctor` (`files.auth`) checks that `auth.json` has the
ACF entry; without it a fresh `mise run install` cannot fetch the plugin.

## CI

`.github/workflows/build.yml` and `deploy.yml.example` write no file. They
build `COMPOSER_AUTH` (the same JSON as `auth.json`) from the GitHub Actions
secrets `ACF_PRO_LICENSE` and `ACF_PRO_COMPOSER_SITE_URL`, only in the
install step. `build.yml` defines it once as the YAML anchor
`&composer-auth` and reuses it as `*composer-auth`.

## Licence in the admin

Optional, in the local `.env`:

```dotenv
ACF_PRO_LICENSE='<licence key>'
```

`config/application.php` maps it to the constant `ACF_PRO_LICENSE`, so the
licence is active without typing it in the admin. The key never enters the
repository, `composer.json`, the lockfile or CI logs.

Without an active licence existing fields and data still read, but creating
new PRO fields and Options Pages needs the key.

## Verify

```bash
mise run install
mise run doctor               # files.auth, wp.acf, wp.acf-sync
ddev wp plugin status advanced-custom-fields-pro
ddev wp acf json status
```

Sources:

- https://www.advancedcustomfields.com/resources/installing-acf-pro-with-composer/
- https://www.advancedcustomfields.com/resources/how-to-activate/
- https://getcomposer.org/doc/articles/authentication-for-private-packages.md
