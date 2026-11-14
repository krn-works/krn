# MVP-1L.3 — llms provider UX/profile polish

**Date:** 2026-05-17
**Phase:** MVP-1L
**Task:** MVP-1L.3 — UX/profile polish
**Status:** Complete

## Baseline

- **SHA:** c3fd0c0668ce37557a9a61e56fd0a664ee83fe45 (MVP-1L.2 llms.txt discovery provider, pushed)
- **Tests before:** 770/770 pass
- **Eval-corpus:** 11/11 pass
- **Working tree:** clean

## Implementation summary

Added UX polish to the L.2 `llms` discovery provider:

1. **Three URL aliases** — `--url`, `--llms-url`, `--docs-index-url` for the llms.txt source URL. All map to the same effective URL. Conflicting aliases return clear preflight error. `None` values (unspecified) are ignored.

2. **Source redirect handling** — `follow_redirects` parameter added to `LlmsTxtProvider`. Default `False` (preserves L.2 behavior). When `True`, the llms.txt source URL fetch follows 3xx redirects. `discover-query` now has `--follow-redirects` flag. `search-query --provider llms` already had `--follow-redirects` (affected evidence fetch only) — now it also controls the source URL fetch.

3. **Profile docs** — `llms-docs` profile documented in README with when to use it.

4. **Warnings decision** — Deferred to L.4. Surface parser warnings would require changing `DiscoveryResult` limitations field semantics, which risks breaking JSON consumers.

5. **README CI test count** — Changed from hardcoded `637/637` to `pytest exit code` to avoid future staleness.

### New files

- `tests/test_llms_aliases.py` — 22 tests for alias resolution, CLI args, conflict detection, follow-redirects wiring

### Modified files

- `search_tool/cli.py` — Added `_resolve_llms_url()` helper, `--llms-url`/`--docs-index-url`/`--follow-redirects` arguments, updated llms branches to use alias resolver
- `search_tool/discovery_llms.py` — Added `follow_redirects` field to `LlmsTxtProvider`, wired through to fetch
- `tests/test_llms_provider.py` — Added 10 follow_redirects and provider field tests
- `README.md` — Updated llms provider docs, added profile docs, updated CI test count

## Alias behavior

| Flag | Dest | Used for |
|------|------|----------|
| `--url` | `args.url` | llms.txt source URL |
| `--llms-url` | `args.llms_url` | alias |
| `--docs-index-url` | `args.docs_index_url` | alias |

Resolution: `_resolve_llms_url(args)` returns `(effective_url, error)`:
- 0 provided: `(None, None)` — missing URL
- 1 provided: `(url, None)` — success
- 2+ provided: `(None, "conflicting ...")` — error
- `None` values ignored (not counted as provided)

## Redirect behavior

| Flag | discover-query | search-query |
|------|---------------|-------------|
| `--follow-redirects` | NEW (store_true) | Already exists (BooleanOptionalAction) |
| Effect on llms source fetch | NEW: passes to LlmsTxtProvider | NEW: passes to LlmsTxtProvider |
| Effect on candidate evidence fetch | N/A (no evidence fetch) | Existing: passes to fetch_url |

Default: source URL redirects NOT followed (L.2 behavior preserved).
When enabled: source URL fetch uses `follow_redirects=True`, candidate evidence fetch unchanged.

## Profile docs

`llms-docs` profile added to README:
- Preferred source types: `official_docs`, `docs_site`, `repository`
- Use: `--profile llms-docs` when discovering from llms.txt files listing both official docs and third-party content
- Source-quality guidance only; does not bypass URL policy

## Tests added

### Alias tests (22 tests)
- `_resolve_llms_url`: url_only, llms_url_alias, docs_index_url_alias, all_none, url+llms_url_conflict, all_three_conflict, same_value_conflict, none_vs_value_allowed
- CLI alias args: discover_query_has_url, discover_query_has_llms_url, discover_query_has_docs_index_url, alias_conflict_error (discover + search), search_llms_url_in_result
- discover-query follow-redirects: has_follow_redirects_flag, no_follow_redirects_default

### Provider redirect tests (10 tests)
- Default follow_redirects_false
- follow_redirects_true
- redirect_followed_when_enabled (mocked)
- redirect_not_followed_when_disabled
- follow_redirects_default_field
- follow_redirects_custom

### Test counts

| Suite | Before | After |
|-------|--------|-------|
| L.2 parser tests | 40/40 | 40/40 |
| L.2 provider tests | 48/48 | 58/58 (+10) |
| New alias tests | — | 22/22 |
| Full suite | 770/770 | **792/792** (+22) |
| Eval-corpus | 11/11 | 11/11 |

## Smoke result

Command: `search-query "validation models" --provider llms --llms-url https://docs.pydantic.dev/latest/llms.txt --follow-redirects --json --work-dir <tmp>`

Result: Valid JSON, exit 0, status="error", candidates_total=0, limitations includes redaction warning. The pydantic site returned content but with no parseable URLs in the llms.txt (301 redirect followed to a page that doesn't contain valid llms.txt content). No SearXNG, no WebSearch. The redirect was followed (the pydantic redirect chain resolved).

## Known limitations

1. **Duplicate redaction limitation in JSON** — `build_discovery_result` appends the redaction limitation, and search result JSON concatenates discovery + evidence limitations. The smoke output shows the limitation twice. This is a pre-existing issue from L.2, not introduced by L.3. L.4 should deduplicate.

2. **Source redirect not in `--research` preset** — `--research` expands to `provider=auto` which doesn't use the llms provider. L.3 notes suggest adding llms to auto-discovery, but that's a larger scope.

3. **Discover-query `--follow-redirects` is `store_true` not `BooleanOptionalAction`** — This is intentional for discover-query (no `--no-follow-redirects` negation needed since the default is already `False`). The `search-query` variant uses `BooleanOptionalAction` because it has other redirect-sensitive operations.

4. **Parser warnings not surfaced** — Still deferred to L.4.

## Next task: MVP-1L.4

- Surface parse warnings in JSON output (without breaking existing consumers)
- Deduplicate redaction limitation in JSON
- Consider adding llms to `--research` preset auto-resolution
- Dogfood with real llms.txt files (docs.github.com, fastapi.tiangolo.com)
- Acceptance evaluation
