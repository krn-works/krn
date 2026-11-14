# MVP-1E.5 Discover Query CLI Evaluation

## Baseline

`72160d83b5d0c93d761dcd9d1356545ea1721c4e` — feat: add discover-query cli

## Implementation commit

`72160d83b5d0c93d761dcd9d1356545ea1721c4e`

## Purpose

Evaluate the `discover-query` CLI command as the user-facing entry point for query discovery. Verify CLI contract, JSON output schema, exit codes, provider selection, security posture, and non-goal preservation.

## Scope

- `search_tool/cli.py` — discover-query subcommand and helpers
- `tests/test_cli_smoke.py` — 21 new CLI smoke tests (all mocked, no live internet)

## Acceptance verdict

**ACCEPT_MVP1E5**

## What was implemented

- `discover-query` subcommand added to `main()` argparse configuration
- Static provider: `--candidate-url` (required, repeatable), `--candidate-title`, `--candidate-snippet`, `--candidate-engine` (repeatable, index-mapped to URLs)
- SearXNG provider: `--searxng-url` (required), `--language`, `--category` (repeatable), `--safesearch` (0/1/2), `--timeout` (default 10.0)
- `--max-candidates` (default 10) caps output across both providers
- JSON output to stdout via `_discovery_result_to_json_dict()` + `_print_discovery_result()`
- JSON fields: `schema_version`, `query` (original/normalized/redacted), `provider` (name), `summary` (candidates_total/selected_for_fetch/blocked/duplicates/errors), `urls_for_fetch`, `candidates` (rank/url/normalized_url/title/snippet/source_engine/url_policy/blocked_reason/selected_for_fetch/duplicate_of), `errors` (code/message), `limitations`
- Exit 0 for valid DiscoveryResult (including provider operational failures)
- Exit 1 for CLI/input contract errors
- 21 new CLI smoke tests in 7 test classes

## What was not implemented

- No fetching of discovered URLs
- No evidence packs created by discover-query
- No fetch-list integration (manual workflow)
- No search-query composition
- No synthesis
- No query cache
- No live internet tests
- No dependency changes
- No pyproject.toml changes
- No evidence schema changes
- No manifest schema changes
- No public SearXNG default URL

## CLI contract verification

| Feature | Present | Verified by |
|---|---|---|
| `discover-query` subcommand | Yes | argparse `add_parser("discover-query")` |
| `--provider static\|searxng` required choice | Yes | `choices=["static", "searxng"], required=True` |
| `--max-candidates` int with default 10 | Yes | `type=int, default=10` |
| `--candidate-url` repeatable | Yes | `action="append", default=[]` |
| `--candidate-title` repeatable | Yes | `action="append", default=[]` |
| `--candidate-snippet` repeatable | Yes | `action="append", default=[]` |
| `--candidate-engine` repeatable | Yes | `action="append", default=[]` |
| `--searxng-url` | Yes | present, validated at runtime |
| `--language` | Yes | passed through to provider |
| `--category` repeatable | Yes | `action="append", default=[]` |
| `--safesearch` int | Yes | validated 0/1/2 at runtime |
| `--timeout` float default 10.0 | Yes | `type=float, default=10.0` |

## JSON output verification

JSON output contains all required fields from the discovery contract:

| Field | Present | Verified by |
|---|---|---|
| `schema_version` | Yes | `"0.1"` |
| `query.original` | Yes | Test: spaced query preserved |
| `query.normalized` | Yes | Test: whitespace normalized |
| `query.redacted` | Yes | Test: key present |
| `provider.name` | Yes | `"static"` or `"searxng"` |
| `summary` | Yes | candidates_total, selected_for_fetch, blocked, duplicates, errors |
| `urls_for_fetch` | Yes | List of safe normalized URLs |
| `candidates` array | Yes | Full candidate objects with all fields |
| `errors` array | Yes | Code/message tuples |
| `limitations` array | Yes | Provider limitations |

## Exit-code verification

| Condition | Exit code | Verified by |
|---|---|---|
| Valid static result | 0 | `test_static_one_safe_url_prints_json_exits_zero` |
| SearXNG valid result | 0 | `test_searxng_with_mock_prints_valid_json` |
| SearXNG 403 (provider failure) | 0 | `test_searxng_403_exits_zero_with_api_forbidden` |
| Empty query | 1 | `test_empty_query_exits_one` |
| Static without --candidate-url | 1 | `test_static_without_candidate_url_exits_one` |
| Metadata count mismatch | 1 | `test_metadata_count_mismatch_exits_one` |
| SearXNG without --searxng-url | 1 | `test_searxng_without_url_exits_one` |
| Invalid --max-candidates (-1) | 1 | `test_invalid_max_candidates_exits_one` |
| Invalid --safesearch (3) | 1 | `test_invalid_safesearch_exits_one` |
| Invalid --timeout (-5) | 1 | `test_invalid_timeout_exits_one` |

## Provider verification

| Provider | Supported | Details |
|---|---|---|
| static | Yes | Requires `--candidate-url`. Metadata mapped by index. No network. |
| searxng | Yes | Requires explicit `--searxng-url`. Language, category, safesearch, timeout passed through. |

No public SearXNG default. `--searxng-url` is required — missing it exits 1.

## Security / non-goal verification

| Non-goal | Preserved |
|---|---|
| No SearXNG, Crawl4AI, Repomix | Yes — SearXNG is a provider, not the tool itself |
| No SQLite, database storage, synthesis | Yes |
| No browser automation (Playwright, Crawl4AI) | Yes |
| No MCP server, agent frameworks, hooks | Yes |
| No frontend, dashboard, API server | Yes |
| No live internet tests | Yes — all 21 tests use mocks |
| No public SearXNG default | Yes — `--searxng-url` required |
| No fetching discovered URLs | Yes — discover-query outputs JSON only |
| No evidence packs created | Yes |
| No dependency changes | Yes |
| No pyproject.toml changes | Yes |
| No evidence schema changes | Yes |
| No manifest schema changes | Yes |

## Test coverage

21 new CLI smoke tests in 7 test classes:

| Class | Tests | Area |
|---|---|---|
| TestDiscoverQueryStatic | 8 | Static provider: JSON output, query fields, urls_for_fetch, blocked URLs, duplicates, metadata, max-candidates, empty query |
| TestDiscoverQueryStaticInputErrors | 3 | Missing candidate URL, metadata mismatch, invalid max-candidates |
| TestDiscoverQuerySearxng | 8 | Missing URL, mock output, JSON validation, 403 handling, language, category, safesearch, invalid safesearch, invalid timeout |
| TestDiscoverQueryHelp | 1 | Help text includes discover-query |

371/371 tests pass total (350 baseline + 21 new).

## Known limitations

- discover-query does not fetch URLs — it only discovers candidates
- discover-query does not create evidence packs
- No integration with fetch-list yet (manual workflow: pipe urls_for_fetch to fetch-list)
- Static provider is for tests and manual use only
- SearXNG provider requires explicit --searxng-url (no public default)
- No query cache
- No search-query composition

## Decision

**ACCEPT_MVP1E5** — discover-query CLI is implemented, tested, and verified. Static and searxng providers wired. JSON output contains all discovery contract fields. Exit codes correctly distinguish operational failures (exit 0) from CLI misuse (exit 1). Security posture intact. All non-goals preserved.

## Next recommended task

MVP-1E.6 — search-query composition design or evaluation corpus. Design the bridge between discover-query output (JSON `urls_for_fetch`) and fetch-list input (URLs file). Alternatively, build an evaluation corpus to exercise the full discover → fetch → evidence pipeline manually.

## Evaluation checklist

| # | Check | Status |
|---|---|---|
| 1 | discover-query subcommand exists | PASS |
| 2 | --provider static\|searxng exists | PASS |
| 3 | --max-candidates exists | PASS |
| 4 | static --candidate-url repeatable | PASS |
| 5 | static --candidate-title | PASS |
| 6 | static --candidate-snippet | PASS |
| 7 | static --candidate-engine | PASS |
| 8 | searxng --searxng-url required | PASS |
| 9 | searxng --language supported | PASS |
| 10 | searxng --category repeatable | PASS |
| 11 | searxng --safesearch supported | PASS |
| 12 | searxng --timeout supported | PASS |
| 13 | JSON schema_version present | PASS |
| 14 | JSON query.original/normalized/redacted present | PASS |
| 15 | JSON provider.name present | PASS |
| 16 | JSON summary present | PASS |
| 17 | JSON urls_for_fetch present | PASS |
| 18 | JSON candidates present | PASS |
| 19 | JSON errors present | PASS |
| 20 | JSON limitations present | PASS |
| 21 | exit 0 for valid static result | PASS |
| 22 | exit 0 for provider operational failure | PASS |
| 23 | exit 1 for empty query | PASS |
| 24 | exit 1 for static without candidate URL | PASS |
| 25 | exit 1 for searxng without --searxng-url | PASS |
| 26 | exit 1 for invalid max-candidates | PASS |
| 27 | exit 1 for invalid safesearch | PASS |
| 28 | exit 1 for invalid timeout | PASS |
| 29 | no live internet tests | PASS |
| 30 | no public SearXNG default | PASS |
| 31 | no fetching URLs | PASS |
| 32 | no evidence packs | PASS |
| 33 | no dependency changes | PASS |
| 34 | no schema changes | PASS |

**Result: 34/34 PASS**
