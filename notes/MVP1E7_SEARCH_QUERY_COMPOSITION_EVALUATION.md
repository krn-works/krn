# MVP-1E.7 Search Query Composition Evaluation

## Baseline

`69ec4600fb8801bcd2d08eced97114985b05247a` — docs: fix search-query handoff metadata

## Implementation commits

- `ecca5fd470d6c81f63e088dbc1c944df140bc917` — feat: add search-query composition
- `69ec4600fb8801bcd2d08eced97114985b05247a` — docs: fix search-query handoff metadata

## Purpose

Evaluate the `search-query` CLI command that composes discover-query + fetch-list into a single command. Verify architecture, composition logic, CLI contract, output contract, artifact production, exit codes, security posture, and test coverage against the MVP-1E.6 design memo.

## Scope

- `search_tool/search.py` — new. SearchRunResult dataclass, search_query() composition function
- `search_tool/cli.py` — search-query subcommand, _run_search_query() runner
- `tests/test_search.py` — new. 13 unit tests for search_query()
- `tests/test_cli_smoke.py` — 14 new CLI tests for search-query

## Acceptance verdict

**ACCEPT_MVP1E7**

## What was implemented

- `search_tool/search.py` exists as a separate composition module (Architecture B from MVP-1E.6 design)
- `SearchRunResult` frozen dataclass with fields: discovery, evidence_results, manifest_path, limitations
- `search_query()` function taking provider, query, max_candidates, refresh, follow_redirects, fetcher callable, manifest_writer callable
- `search-query` CLI subcommand wired via `_run_search_query()` in cli.py
- Provider options mirror discover-query: `--provider static|searxng`, `--candidate-url`, `--candidate-title`, `--candidate-snippet`, `--candidate-engine`, `--searxng-url`, `--language`, `--category`, `--safesearch`, `--timeout`, `--max-candidates`
- Fetch options include `--refresh` and `--follow-redirects`
- Evidence packs produced through existing `fetch_url_to_evidence` pipeline
- Fetch-list manifest produced through existing `_write_manifest` writer
- Stdout is fetch-list-like TSV (per-URL lines) + `Manifest:\t<path>` line
- Stderr has compact discovery/fetch summaries: `[discovery]` and `[fetch]` lines
- Exit 1 for CLI misuse (empty query, missing required options, invalid values)
- Exit 0 for all operational outcomes (provider errors, zero URLs, fetch failures)
- 27 new tests (13 unit + 14 CLI), 398/398 total pass

## What was not implemented

- No search-run manifest (deferred to MVP-1E.8+)
- No discovery JSON file persistence (deferred)
- No `--output-dir` option (deferred)
- No `--save-discovery-json` option (deferred)
- No synthesis, ranking, or content filtering
- No new dependencies
- No pyproject.toml changes
- No evidence schema changes
- No manifest schema changes
- No generated files committed

## Architecture verification

`search_tool/search.py` is a separate module following Architecture B from the MVP-1E.6 design memo.

| Check | Status | Evidence |
|---|---|---|
| Module exists | PASS | `search_tool/search.py` — 69 lines |
| SearchRunResult dataclass exists | PASS | `@dataclass(frozen=True) class SearchRunResult` at line 17 |
| search_query() function exists | PASS | `def search_query(provider, query, *, max_candidates, refresh, follow_redirects, fetcher, manifest_writer)` at line 24 |
| CLI wires through _run_search_query() | PASS | `search_tool/cli.py` line 604: `def _run_search_query(args)`, wired at line 278 |
| No framework/plugin/registry abstraction | PASS | No registry, plugin system, middleware, or class hierarchy. One function, one dataclass. |

## Composition verification

`search_query()` calls `provider.discover()` to get a `DiscoveryResult`, extracts `urls_for_fetch()`, then iterates each URL through the injected `fetcher` callable. Finally calls the injected `manifest_writer`.

| Check | Status | Evidence |
|---|---|---|
| provider.discover called | PASS | `search.py` line 34: `discovery = provider.discover(query, max_candidates=max_candidates)` |
| urls_for_fetch used | PASS | `search.py` line 35: `fetch_urls = urls_for_fetch(discovery)` |
| blocked candidates not fetched | PASS | `urls_for_fetch()` returns only `selected_for_fetch=True` candidates. Blocked URLs have `selected_for_fetch=False`. |
| duplicate candidates not double-fetched | PASS | `urls_for_fetch()` deduplicates by `normalized_url`. Duplicates get `duplicate_of` set. |
| fetch_url_to_evidence path used via injected fetcher | PASS | `cli.py` line 656: `fetcher=fetch_url_to_evidence` |
| refresh passed through | PASS | `search.py` line 54: `result = fetcher(url, refresh, follow_redirects)`. `cli.py` line 652: `refresh=args.refresh` |
| follow_redirects passed through | PASS | Same path as refresh. `cli.py` line 653: `follow_redirects=args.follow_redirects` |
| manifest writer used | PASS | `search.py` lines 58-61: `manifest_path = manifest_writer(evidence_results, "search-query", refresh)`. `cli.py` line 657: `manifest_writer=_write_manifest` |
| zero URLs produces honest result/manifest | PASS | `search.py` lines 37-50: early return with empty evidence_results and manifest from writer. `test_manifest_writer_called_for_zero_urls` confirms. |

## CLI contract verification

| Check | Status | Evidence |
|---|---|---|
| search-query subcommand exists | PASS | `cli.py` line 250: `subparsers.add_parser("search-query")` |
| static provider supported | PASS | `cli.py` lines 613-626: static provider with `--candidate-url` validation |
| searxng provider supported | PASS | `cli.py` lines 627-646: SearxngDiscoveryProvider construction |
| no public SearXNG default | PASS | `cli.py` line 628: `if not args.searxng_url` — required, no default |
| --max-candidates supported | PASS | `cli.py` line 253: `--max-candidates`, validated at line 609 |
| --refresh supported | PASS | `cli.py` line 266: `--refresh`, passed to `search_query()` at line 652 |
| --follow-redirects supported | PASS | `cli.py` line 267: `--follow-redirects`, passed at line 653 |
| stdout machine-parseable | PASS | TSV per-URL lines + `Manifest:\t<path>` line. `test_static_prints_tsv_and_manifest` confirms. |
| stderr summaries present | PASS | `[discovery]` and `[fetch]` lines printed to stderr. `test_stderr_contains_discovery_and_fetch_summary` confirms. |

## Output contract verification

**stdout:** Per-URL tab-separated lines (`url\tstatus\tcache\tquality\tpath`) followed by `Manifest:\t<path>`. Identical format to fetch-list output. Verified by `TestSearchQueryStaticHappy.test_static_prints_tsv_and_manifest`.

**stderr:** Two summary lines:
- `[discovery] provider=<name> candidates=N selected=N blocked=N duplicates=N errors=N`
- `[fetch] urls=N evidence=N manifest=<path>`

This matches the design proposal in MVP-1E.6 section "Output contract proposal".

## Artifact verification

| Check | Status | Evidence |
|---|---|---|
| evidence packs existing schema | PASS | Produced via `fetch_url_to_evidence()` — unchanged schema |
| fetch-list manifest existing schema | PASS | Produced via `_write_manifest()` — unchanged schema |
| no search-run manifest | PASS | No new manifest type. Only fetch-list manifest produced. |
| no discovery JSON | PASS | No JSON file written. Discovery result exists only in memory and stderr summary. |
| no generated files committed | PASS | `git show --stat` for implementation commits shows no evidence/cache/tmp files |

## Exit-code verification

| Condition | Expected | Actual | Verified by |
|---|---|---|---|
| CLI misuse (empty query) | 1 | 1 | `test_empty_query_exits_one` |
| CLI misuse (static no candidate-url) | 1 | 1 | `test_static_without_candidate_url_exits_one` |
| CLI misuse (searxng no url) | 1 | 1 | `test_searxng_without_url_exits_one` |
| CLI misuse (invalid max-candidates) | 1 | 1 | `test_invalid_max_candidates_exits_one` |
| CLI misuse (invalid safesearch) | 1 | 1 | `test_invalid_safesearch_exits_one` |
| CLI misuse (invalid timeout) | 1 | 1 | `test_invalid_timeout_exits_one` |
| Operational outcome (static happy) | 0 | 0 | `test_static_happy_path_exits_zero` |
| Operational outcome (searxng mock) | 0 | 0 | `test_searxng_with_mock_exits_zero` |
| Zero URLs (all blocked) | 0 | 0 | `test_all_blocked_exits_zero_with_manifest` |
| Fetch options passed through | 0 | 0 | `test_refresh_passed_through`, `test_follow_redirects_passed_through` |

## Security / non-goal verification

| Non-goal | Preserved |
|---|---|
| No synthesis | Yes — search_query produces evidence packs and manifest only |
| No query cache | Yes — no caching at composition level |
| No retry logic | Yes — provider errors and fetch failures are recorded, not retried |
| No browser automation | Yes — static HTML extraction only |
| No MCP/hooks/plugins | Yes — no new config, hooks, or plugins |
| No new dependencies | Yes — only existing httpx, beautifulsoup4, pytest |
| No pyproject.toml changes | Yes — verified in commit stats |
| No evidence schema changes | Yes — same fetch_url_to_evidence pipeline |
| No manifest schema changes | Yes — same _write_manifest function |
| No public SearXNG default | Yes — --searxng-url required |

## Test coverage

27 new tests (13 unit + 14 CLI), 398/398 total pass.

### Unit tests (tests/test_search.py) — 13 tests

| Class | Tests | Area |
|---|---|---|
| TestSearchRunResultDataclass | 2 | Frozen immutability, field access |
| TestSearchQuerySuccess | 2 | Returns discovery + evidence, manifest writer called |
| TestSearchQueryMaxCandidates | 1 | max_candidates passed to provider |
| TestSearchQueryFetchOptions | 2 | refresh and follow_redirects passed to fetcher, defaults |
| TestSearchQueryProviderError | 1 | Provider errors with zero URLs — no fetch attempted |
| TestSearchQueryPartialFetch | 1 | Partial failure returns all results |
| TestSearchQueryDuplicateUrls | 1 | Duplicates fetched once |
| TestSearchQueryBlockedUrls | 1 | Blocked URLs not fetched |
| TestSearchQueryEmptyManifest | 2 | No writer returns None, writer called for zero URLs |

### CLI tests (tests/test_cli_smoke.py) — 14 tests

| Class | Tests | Area |
|---|---|---|
| TestSearchQueryStaticHappy | 2 | Happy path exits 0, TSV + manifest stdout |
| TestSearchQuerySearxngHappy | 1 | SearXNG mock exits 0 |
| TestSearchQueryStderr | 1 | Discovery + fetch summary in stderr |
| TestSearchQueryInputErrors | 6 | Empty query, no candidate-url, no searxng-url, invalid max-candidates/safesearch/timeout |
| TestSearchQueryFetchOptions | 2 | --refresh and --follow-redirects passed through |
| TestSearchQueryZeroUrls | 1 | All blocked exits 0 with manifest |
| TestSearchQueryHelp | 1 | Help text includes search-query |

All tests use mocked HTTP. No live internet.

## Known limitations

- No search-run manifest (deferred to MVP-1E.8+)
- No discovery JSON file persistence (deferred)
- No `--output-dir` option (deferred)
- No retry logic for transient provider failures
- No query cache
- Manifest `source_file` field shows "search-query" string, not a real file path
- No `--save-discovery-json` for debugging intermediate discovery results

## Decision

**ACCEPT_MVP1E7** — search-query composition is implemented, tested, and verified against the MVP-1E.6 design memo. Architecture B (separate `search_tool/search.py` module) is correct. Composition logic is thin: discover → urls_for_fetch → fetch per URL → manifest. Provider options mirror discover-query. Fetch options pass through. Evidence packs and manifest use existing schemas unchanged. Exit codes correctly distinguish CLI misuse (1) from operational outcomes (0). Security posture intact. All non-goals preserved. 398/398 tests pass.

## Evaluation checklist

| # | Category | Check | Status |
|---|---|---|---|
| 1 | Architecture | search_tool/search.py module exists | PASS |
| 2 | Architecture | SearchRunResult dataclass exists | PASS |
| 3 | Architecture | search_query() function exists | PASS |
| 4 | Architecture | CLI wires through _run_search_query() | PASS |
| 5 | Architecture | no framework/plugin/registry abstraction | PASS |
| 6 | Composition | provider.discover called | PASS |
| 7 | Composition | urls_for_fetch used | PASS |
| 8 | Composition | blocked candidates not fetched | PASS |
| 9 | Composition | duplicate candidates not double-fetched | PASS |
| 10 | Composition | fetch_url_to_evidence path used via injected fetcher | PASS |
| 11 | Composition | refresh passed through | PASS |
| 12 | Composition | follow_redirects passed through | PASS |
| 13 | Composition | manifest writer used | PASS |
| 14 | Composition | zero URLs still produces honest result/manifest when writer available | PASS |
| 15 | CLI | search-query subcommand exists | PASS |
| 16 | CLI | static provider supported | PASS |
| 17 | CLI | searxng provider supported with explicit --searxng-url | PASS |
| 18 | CLI | no public SearXNG default | PASS |
| 19 | CLI | --max-candidates supported | PASS |
| 20 | CLI | --refresh supported | PASS |
| 21 | CLI | --follow-redirects supported | PASS |
| 22 | CLI | stdout machine-parseable | PASS |
| 23 | CLI | stderr summaries present | PASS |
| 24 | Artifacts | evidence packs existing schema | PASS |
| 25 | Artifacts | fetch-list manifest existing schema | PASS |
| 26 | Artifacts | no search-run manifest | PASS |
| 27 | Artifacts | no discovery JSON | PASS |
| 28 | Artifacts | no generated files committed | PASS |
| 29 | Exit codes | CLI misuse exits 1 | PASS |
| 30 | Exit codes | operational outcomes exit 0 | PASS |
| 31 | Exit codes | provider errors exit 0 | PASS |
| 32 | Exit codes | zero URLs exits 0 | PASS |
| 33 | Exit codes | fetch failures exit 0 | PASS |
| 34 | Security | no synthesis | PASS |
| 35 | Security | no query cache | PASS |
| 36 | Security | no retry logic | PASS |
| 37 | Security | no browser automation | PASS |
| 38 | Security | no MCP/hooks/plugins | PASS |
| 39 | Security | no new deps | PASS |
| 40 | Security | no schema drift | PASS |

**Result: 40/40 PASS**

## Next recommended task

MVP-1E.8 — search-run manifest design or evaluation corpus. The search-run manifest (Option 3 from MVP-1E.6 design) would tie discovery metadata to fetch results in a single artifact. Alternatively, build an evaluation corpus to exercise the full search-query pipeline with a real SearXNG instance.
