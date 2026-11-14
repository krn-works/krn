# AGENTS.md

This repository owns the reusable Rekurencja WordPress anti-spam plugin.

## Product boundary

- Protect inbound WordPress comments and Contact Form 7 submissions.
- Never inspect or block generic outbound `wp_mail` traffic.
- Keep scoring deterministic and local by default. Optional reputation checks
  must fail open, be explicitly enabled, cached, and bounded by time/host count.
- Do not persist full form content, email addresses, IP addresses, Turnstile
  tokens, request headers, or mail arguments in diagnostic logs.
- A safe/observe mode must never change delivery behavior.
- Preserve upstream spam decisions from CF7 and other integrations.

## Implementation

- Runtime PHP supports PHP 8.0+ and WordPress 6.4+.
- `antispam-lite.php` is the plugin bootstrap and activation owner.
- `inc/rules.php` owns pure normalization and scoring policy.
- `inc/hooks.php` adapts scoring to WordPress/CF7 and owns privacy-safe logs.
- Tests must exercise the public scoring seam with known spam and legitimate
  PL/EN contact examples. Avoid tests that freeze file topology or prose.
- Keyword files are optional data. A missing file must not break submissions.

## Delivery

- Do not commit `vendor/`, IDE stubs, build archives, or runtime logs.
- Run focused tests and PHP syntax checks before publication.
- Commit messages use Conventional Commits.
- Deployment to consumer sites is a separate authorized action; publishing the
  plugin repository never implies activation or release on Hasmed.

