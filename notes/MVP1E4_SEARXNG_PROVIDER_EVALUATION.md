# MVP-1E.4 SearXNG Provider Evaluation

## Baseline

`aaa35aa8b274b5bd0a39e8592caa0eb7f8855e64` — fix: harden searxng failure honesty

## Implementation commits

| Short | Full | Message |
|-------|------|---------|
| `fb2e24e` | `fb2e24ebd66187f6ee28e0e7aa0bb68dd0813310` | feat: add searxng discovery provider |
| `aaa35aa` | `aaa35aa8b274b5bd0a39e8592caa0eb7f8855e64` | fix: harden searxng failure honesty |

## Purpose

Evaluate `SearxngDiscoveryProvider` as the first real network discovery provider. Verify implementation against the design contract defined in `notes/MVP1E3_SEARXNG_PROVIDER_VERIFICATION.md`. Confirm security posture, failure honesty, test coverage, and non-goal preservation.

## Scope

- `search_tool/discovery.py` — SearxngDiscoveryProvider implementation
- `tests/test_discovery.py` — 45 SearXNG provider tests (all mocked, no live internet)

## Acceptance verdict

**ACCEPT_MVP1E4**

## What was implemented

- `SearxngDiscoveryProvider` frozen dataclass added to `search_tool/discovery.py`
- `base_url` required, no public default — must be explicitly provided
- `base_url` validated by URL policy before any HTTP request
- POST /search with format=json, q parameter, optional language/categories/safesearch
- httpx client with `trust_env=False`, explicit `timeout`, `follow_redirects=False`
- Response parsed from JSON: results array → RawDiscoveryCandidate list
- Title mapped from `title` field, snippet mapped from `content` field
- All result URLs flow through `build_discovery_result()` for URL policy, dedup, normalization
- Expected provider failures return DiscoveryResult errors (not exceptions)
- Unexpected exceptions return `unexpected_error` in DiscoveryResult
- `_empty_result()` helper for consistent empty failure results
- `_client` private field for test injection via MockTransport
- 45 new tests in 8 test classes (TestSearxngConfig, TestSearxngRequestFormation, TestSearxngResponseParsing, TestSearxngMissingFields, TestSearxngFailureHonesty, TestSearxngInvalidResponseShape, TestSearxngUnexpectedException, TestSearxngQueryPrivacy, TestSearxngNoLiveInternet)
- Hardening commit (`aaa35aa`): added TestSearxngUnexpectedException, separated invalid response shape tests, confirmed connection_error and unexpected_error are distinct

## What was not implemented

- No query cache
- No retry logic for transient failures
- No page navigation (pageno)
- No time_range filtering
- No engine selection per-query
- No CLI changes
- No new dependencies (httpx was already in project)
- No evidence schema changes
- No manifest schema changes
- No pyproject.toml changes

## Contract verification

Implementation matches the design contract from `notes/MVP1E3_SEARXNG_PROVIDER_VERIFICATION.md`:

| Contract requirement | Implemented | Verified by |
|---|---|---|
| Frozen dataclass with required base_url | Yes | Type error on construction without base_url |
| No public default base_url | Yes | `base_url: str` has no default |
| URL policy check before HTTP | Yes | `check_url(self.base_url)` called before client creation |
| POST /search | Yes | `client.post(endpoint, data=data)` |
| format=json | Yes | `data = {"q": norm_q, "format": "json"}` |
| trust_env=False | Yes | `httpx.Client(trust_env=False, ...)` |
| Explicit timeout | Yes | `timeout=self.timeout_seconds` (default 10.0) |
| No redirect following | Yes | `follow_redirects=False` |
| All output through build_discovery_result() | Yes | Raw candidates delegated to `build_discovery_result()` |
| Honest error handling | Yes | All failure modes return DiscoveryResult with error tuples |
| source_engine set to "searxng" | Yes | `source_engine="searxng"` in RawDiscoveryCandidate |

## Security verification

| Check | Status |
|---|---|
| base_url validated by URL policy before HTTP | PASS |
| No public default base_url | PASS |
| file:// base_url blocked | PASS |
| localhost base_url blocked | PASS |
| Private IP base_url blocked | PASS |
| Credentials in base_url blocked | PASS |
| trust_env=False (no proxy leakage) | PASS |
| follow_redirects=False (no SSRF via redirect) | PASS |
| Result URLs through build_discovery_result() → check_url() | PASS |
| Unsafe result URLs blocked (file://, javascript:, etc.) | PASS |
| Snippets stored as untrusted metadata, never executed | PASS |
| Query redaction applied before metadata storage | PASS |
| No live internet tests (no accidental external calls) | PASS |

## Failure honesty verification

| Failure mode | Error code | Returns DiscoveryResult | Test covers |
|---|---|---|---|
| Empty query | empty_query | Yes | Yes |
| Invalid base_url | invalid_base_url | Yes | Yes |
| HTTP 403 | api_forbidden | Yes | Yes |
| HTTP 429 | rate_limited | Yes | Yes |
| HTTP 5xx | server_error | Yes | Yes |
| HTTP 3xx | redirect_not_followed | Yes | Yes |
| Timeout | timeout | Yes | Yes |
| Connection error | connection_error | Yes | Yes |
| Malformed JSON | malformed_response | Yes | Yes |
| Invalid response (not dict) | invalid_response | Yes | Yes |
| Invalid response (no results list) | invalid_response | Yes | Yes |
| Missing URL in result | skipped_result | Yes | Yes |
| Unexpected exception | unexpected_error | Yes | Yes |

All failure modes return `DiscoveryResult` (never raise). Error tuples contain code and descriptive message. Limitations field includes provider-specific context.

## Test coverage

- 45 new SearXNG provider tests across 9 test classes
- 350 total tests pass (301 baseline + 49 discovery: 45 SearXNG + 4 pre-existing)
- All tests use `httpx.MockTransport` — no live internet
- DNS mocked via `unittest.mock.patch("search_tool.url_policy.socket.getaddrinfo")`

Test classes:

| Class | Tests | Area |
|---|---|---|
| TestSearxngConfig | 6 | base_url validation, policy check, trailing slash |
| TestSearxngRequestFormation | 12 | POST method, endpoint, form data, optional params, httpx config |
| TestSearxngResponseParsing | 8 | Normal result, title/content mapping, unsafe URLs, duplicates |
| TestSearxngMissingFields | 4 | Missing title, missing content, missing/invalid URL |
| TestSearxngFailureHonesty | 8 | 403, 429, 5xx, timeout, connection error, malformed JSON, redirect |
| TestSearxngInvalidResponseShape | 3 | JSON array, JSON string, results not list |
| TestSearxngUnexpectedException | 1 | RuntimeError → unexpected_error |
| TestSearxngQueryPrivacy | 4 | Query normalization, redaction, empty query skips HTTP |
| TestSearxngNoLiveInternet | 3 | MockTransport used, no real calls, DNS mocked |

## Known limitations

- No retry logic for transient failures (429, 5xx, timeout)
- No query cache (every call hits the SearXNG instance)
- No page navigation (pageno parameter not exposed)
- No time_range filtering
- No engine selection per-query
- `_client` field is private and undocumented (test-only injection point)
- Query redaction is best-effort, not a security boundary
- Query content is forwarded to upstream search engines via SearXNG

## Non-goals preserved

| Non-goal | Preserved |
|---|---|
| No SearXNG, Crawl4AI, Repomix | Yes — SearXNG is a provider, not the tool itself |
| No SQLite, database storage, synthesis | Yes |
| No browser automation (Playwright, Crawl4AI) | Yes |
| No MCP server, agent frameworks, hooks | Yes |
| No frontend, dashboard, API server | Yes |
| No live internet tests | Yes |
| No CLI changes | Yes |
| No new dependencies | Yes |
| No pyproject.toml changes | Yes |
| No evidence schema changes | Yes |

## Decision

**ACCEPT_MVP1E4** — SearxngDiscoveryProvider is implemented, tested, and verified. All contract requirements met. Security posture intact. Failure honesty confirmed. No non-goals violated.

## Next recommended task

MVP-1E.5 — discover-query CLI with provider selection. Wire `SearxngDiscoveryProvider` (and `StaticDiscoveryProvider`) into the CLI via a `discover-query` or `search-query` command. Output discovery results in structured format. No new evidence schema changes.

## Evaluation checklist

| # | Check | Status |
|---|---|---|
| 1 | base_url required | PASS |
| 2 | no public default | PASS |
| 3 | base_url policy check before HTTP | PASS |
| 4 | invalid base_url no HTTP | PASS |
| 5 | private/localhost base_url blocked | PASS |
| 6 | credentials base_url blocked | PASS |
| 7 | POST /search | PASS |
| 8 | q included | PASS |
| 9 | format=json included | PASS |
| 10 | language/categories/safesearch supported | PASS |
| 11 | trust_env=False | PASS |
| 12 | timeout explicit | PASS |
| 13 | redirects not followed | PASS |
| 14 | normal response parsed | PASS |
| 15 | title/content mapped | PASS |
| 16 | unsafe result URLs blocked | PASS |
| 17 | duplicates visible but not selected | PASS |
| 18 | empty results valid | PASS |
| 19 | 403 api_forbidden | PASS |
| 20 | 429 rate_limited | PASS |
| 21 | 5xx server_error | PASS |
| 22 | timeout | PASS |
| 23 | connection_error | PASS |
| 24 | malformed_response | PASS |
| 25 | invalid_response | PASS |
| 26 | redirect_not_followed | PASS |
| 27 | skipped_result | PASS |
| 28 | unexpected_error | PASS |
| 29 | no live internet tests | PASS |
| 30 | no CLI changes | PASS |
| 31 | no deps/pyproject changes | PASS |
| 32 | no schema changes | PASS |

**Result: 32/32 PASS**
