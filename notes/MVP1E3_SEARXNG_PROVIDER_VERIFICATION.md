# MVP-1E.3 SearXNG Provider Verification

## Baseline

`1a0a60d7b8f7195cc9167f9309d7935962e0bfff` — feat: add static discovery provider

## Purpose

Verify SearXNG as the first real network discovery provider candidate. Produce a design memo with verified API facts, threat model, provider contract mapping, and implementation plan. This is documentation only — no code changes.

## Docs access status

OK. All required SearXNG documentation pages fetched successfully from `docs.searxng.org`.

## Sources

| Source | URL |
|--------|-----|
| SearXNG Search API | https://docs.searxng.org/dev/search_api.html |
| SearXNG Settings — Search | https://docs.searxng.org/admin/settings/settings_search.html |
| SearXNG Settings — General | https://docs.searxng.org/admin/settings/settings.html |

## Verification summary

| Area | Status | Notes |
|------|--------|-------|
| Search API endpoint | VERIFIED | `/search` and `/` both accept GET/POST |
| Query parameter | VERIFIED | `q` |
| JSON output format | VERIFIED | `format=json`, must be enabled in `settings.yml` |
| Public instance caveat | VERIFIED | Public instances often disable API formats (403) |
| Query privacy | VERIFIED | `q` passed to external search services |
| Optional parameters | VERIFIED | categories, engines, language, pageno, time_range, safesearch |
| settings.yml formats | VERIFIED | Default is `html` only; `json` must be explicitly added |
| settings.yml location | VERIFIED | `SEARXNG_SETTINGS_PATH` env var or `/etc/searxng/settings.yml` |

## SearXNG API facts

### Endpoint

```
Fact: Search API endpoints
Status: VERIFIED
Source: https://docs.searxng.org/dev/search_api.html
Access date: 2026-05-10
Finding: Both / and /search accept GET and POST requests. POST is preferred for queries.
Impact: Provider must use POST to /search for query submission.
Action: Use POST /search in implementation.
```

### Query parameter

```
Fact: Query parameter name
Status: VERIFIED
Source: https://docs.searxng.org/dev/search_api.html
Access date: 2026-05-10
Finding: Query string is passed via the q parameter.
Impact: Provider must map user query to q parameter.
Action: Normalize query, then pass as q= parameter.
```

### JSON format

```
Fact: JSON output via format=json
Status: VERIFIED
Source: https://docs.searxng.org/dev/search_api.html
Access date: 2026-05-10
Finding: format=json returns JSON response. JSON format must be enabled in settings.yml under search.formats. Requesting an unset format returns 403.
Impact: Provider must handle 403 gracefully (expected failure if JSON is disabled on instance). Self-hosted instance must have json in formats list.
Action: Document 403 as expected failure. Include json format in settings.yml verification checklist.
```

### Public instances

```
Fact: Public instances often disable API formats
Status: VERIFIED
Source: https://docs.searxng.org/dev/search_api.html
Access date: 2026-05-10
Finding: Public instances may disable API formats for abuse prevention. 403 is the expected response when format is not enabled.
Impact: No public instance should be used as default. Self-hosted or private instance required.
Action: No public instance default. Provider should warn or error on 403 with clear message about format configuration.
```

### Query privacy

```
Fact: Query string is forwarded to external search services
Status: VERIFIED
Source: https://docs.searxng.org/dev/search_api.html
Access date: 2026-05-10
Finding: The q parameter is passed to configured search engines (Google, Bing, DuckDuckGo, etc.). SearXNG acts as a proxy/meta-search engine.
Impact: Query content is exposed to upstream engines. Query redaction (already implemented in discovery.py) is necessary but insufficient — redaction catches tokens, not semantic leakage. krn-ai-os must accept this privacy model before using the provider.
Action: Document that query privacy is limited. Query redaction is best-effort (already recorded as limitation in DiscoveryResult). krn-ai-os must make the privacy decision.
```

### Optional parameters

```
Fact: Optional search parameters
Status: VERIFIED
Source: https://docs.searxng.org/dev/search_api.html
Access date: 2026-05-10
Finding: categories (comma-separated), engines (comma-separated), language (ISO-639-1), pageno (page number), time_range (None/Day/Week/Month/Year), safesearch (0/1/2).
Impact: Provider design should expose these as optional config fields. Not all are needed for MVP.
Action: Include language, categories, and safesearch as optional fields in provider dataclass. Defer engines/pageno/time_range to future iteration.
```

## Configuration requirements

```
Fact: settings.yml format configuration
Status: VERIFIED
Source: https://docs.searxng.org/admin/settings/settings_search.html
Access date: 2026-05-10
Finding: search.formats in settings.yml defaults to ['html']. Available formats: html, csv, json, rss. JSON must be explicitly added: search.formats: ['html', 'json'].
Impact: Self-hosted instance must be configured before provider can work. Missing json format causes 403.
Action: Include settings.yml checklist in implementation docs. Provider should detect 403 and report format misconfiguration.
```

```
Fact: settings.yml location
Status: VERIFIED
Source: https://docs.searxng.org/admin/settings/settings.html
Access date: 2026-05-10
Finding: Settings loaded from SEARXNG_SETTINGS_PATH env var, falling back to /etc/searxng/settings.yml. use_default_settings: true loads defaults from /usr/lib/searxng/settings.yml.
Impact: Instance operator must configure search.formats. Provider code does not manage SearXNG configuration.
Action: Document configuration prerequisite. No code changes needed for this.
```

## Query privacy analysis

Query privacy has three layers:

1. **Token redaction** (already implemented): `redact_query()` catches known token patterns (sk-*, ghp_*, gho_*, github_pat_*, Bearer, api_key=, token=, password=). This is best-effort and documented as a limitation in every `DiscoveryResult`.

2. **SearXNG host access**: The raw query is sent to the SearXNG instance. Self-hosted means this is under operator control. Third-party hosted means the host sees the query.

3. **Upstream engine access**: SearXNG forwards the query to configured engines (Google, Bing, DuckDuckGo, etc.). These engines see the raw query regardless of SearXNG hosting.

**Conclusion**: Query redaction catches accidental token pastes. It does not and cannot prevent semantic leakage of the query topic to upstream engines. This is inherent to any meta-search approach. krn-ai-os must accept this privacy model before enabling the provider.

## Security threat model

| # | Threat | Impact | Mitigation | Residual risk | Future test requirement |
|---|--------|--------|------------|---------------|------------------------|
| 1 | Query leakage to SearXNG host | Medium | Self-hosted instance under operator control | Third-party host sees queries | Test that base_url is documented, no public default |
| 2 | Query leakage from SearXNG to upstream engines | Medium | Inherent to meta-search; krn-ai-os privacy decision | Upstream engines always see query | Document in provider README; not testable |
| 3 | Accidental secret leakage in query | High | `redact_query()` applied before metadata storage | Best-effort; non-standard token formats not caught | Test that redacted query appears in DiscoveryResult; test known patterns |
| 4 | Public instance API disabled / 403 | Low | No public instance default; 403 returns honest error | User misconfiguration | Test 403 response produces DiscoveryResult with error |
| 5 | Public instance logging or rate limiting | Low | Self-hosted only; no public default | Operator logging policy unknown | Not testable in provider code |
| 6 | Result poisoning (malicious titles/snippets) | Medium | All content treated as untrusted metadata; never executed | Prompt injection in downstream consumers (krn-ai-os responsibility) | Test that title/snippet stored as-is; no parsing beyond JSON |
| 7 | Discovered unsafe URLs | High | All candidate URLs pass through `build_discovery_result()` → `check_url()` | None (existing policy is sufficient) | Test that blocked URLs appear with url_policy="blocked" |
| 8 | Redirect chains after fetch | Medium | Existing fetch pipeline handles redirects (MVP-1B) | None (existing pipeline) | Not a provider-level concern |
| 9 | Malformed JSON response | Low | Try/except on JSON parse; return error in DiscoveryResult | None | Test malformed JSON produces DiscoveryResult with error |
| 10 | Missing fields in JSON result | Low | Default to empty string for missing title/snippet; URL is required | None | Test missing title/snippet handled gracefully |
| 11 | Non-HTTP result URLs | Medium | `check_url()` blocks non-http/https schemes | None (existing policy) | Test file://, data:, javascript: URLs blocked |
| 12 | Duplicate URLs in results | Low | `build_discovery_result()` deduplicates by normalized URL | None (existing dedup) | Test duplicate result URLs produce single selected candidate |
| 13 | Homograph/lookalike domains | Low | Not mitigated at provider level; downstream consumer responsibility | Lookalike domains pass URL policy | Not testable without external domain knowledge |
| 14 | Provider downtime / timeouts | Low | Explicit timeout (default 10s); return error in DiscoveryResult | None | Test timeout produces DiscoveryResult with error |
| 15 | Malformed JSON | Low | Try/except on JSON parse; return error in DiscoveryResult | None | Test malformed JSON produces DiscoveryResult with error |
| 16 | Cache poisoning if query cache added later | Medium | No query cache in first implementation | Future risk if cache added without integrity checks | Not applicable for first implementation |

## Failure modes

Expected failures that should return `DiscoveryResult` with errors (not raise exceptions):

| Failure | Detection | Error code | Recovery |
|---------|-----------|------------|----------|
| Connection refused | httpx.ConnectError | `connection_error` | No recovery; report error |
| DNS resolution failure | httpx.ConnectError | `dns_error` | No recovery; report error |
| Timeout | httpx.TimeoutException | `timeout` | No recovery; report error |
| HTTP 403 | Response.status_code | `api_forbidden` | Likely format misconfiguration; suggest checking settings.yml |
| HTTP 429 | Response.status_code | `rate_limited` | Retry not implemented in first version; report error |
| HTTP 5xx | Response.status_code | `server_error` | No recovery; report error |
| Malformed JSON | json.JSONDecodeError | `malformed_response` | No recovery; report error |
| Empty results | Valid JSON, empty results list | No error; empty candidates list | Normal outcome; not a failure |

## Provider contract mapping

### Proposed class shape

```python
@dataclass(frozen=True)
class SearxngDiscoveryProvider:
    name: str = "searxng"
    base_url: str  # must be validated by URL policy
    timeout_seconds: float = 10.0
    default_language: str | None = None
    default_categories: tuple[str, ...] = ()
    safesearch: int | None = None  # 0, 1, or 2

    def discover(self, query: str, *, max_candidates: int = 10) -> DiscoveryResult:
        ...
```

### Why no `default_engines` field

The SearXNG `engines` parameter selects which engines to query. This is an instance-level concern (configured in settings.yml), not a per-query concern. Exposing it in the provider would create coupling between krn-search and the SearXNG instance configuration. If needed later, it can be added.

### Mapping SearXNG response to RawDiscoveryCandidate

SearXNG JSON response format:
```json
{
  "results": [
    {
      "url": "https://example.com/page",
      "title": "Page Title",
      "content": "Snippet from the page..."
    }
  ]
}
```

Mapping:
| SearXNG field | RawDiscoveryCandidate field | Notes |
|---------------|---------------------------|-------|
| `url` | `url` | Required. Must pass URL policy. |
| `title` | `title` | Optional. Missing → empty string. |
| `content` | `snippet` | SearXNG uses `content` for snippets. |
| — | `source_engine` | Set to `"searxng"`. |

### Processing pipeline

```
query → normalize_query() → POST /search → JSON parse → RawDiscoveryCandidate[] → build_discovery_result() → DiscoveryResult
```

All provider output flows through `build_discovery_result()` to ensure URL policy, dedup, normalization, and auditability.

## Implementation plan for future provider

### Phase 1: Core provider (MVP-1E.4)

1. Add `SearxngDiscoveryProvider` frozen dataclass to `search_tool/discovery.py`
2. Implement `discover()`: POST to base_url/search with format=json, q, and optional params
3. Use httpx with `trust_env=False`, explicit timeout, no redirect following
4. Parse JSON response into `RawDiscoveryCandidate` list
5. Delegate to `build_discovery_result()` for policy/dedup/normalization
6. Return honest errors via `DiscoveryResult.errors` for all failure modes

### Phase 2: Tests (MVP-1E.4)

1. Mock httpx at transport level (no live internet)
2. Test normal response parsing
3. Test failure modes (403, 429, 5xx, timeout, malformed JSON, connection error)
4. Test URL policy enforcement on results
5. Test query normalization before submission
6. Test metadata preservation (title, snippet, source_engine)

### Phase 3: CLI integration (future, not MVP-1E.4)

1. Wire provider into `discover-query` or `search-query` CLI command
2. Output discovery results in structured format
3. Pipe into `fetch-list` for batch ingestion

## Test plan for future provider

### 1. Provider config validation

- base_url must pass URL policy before use
- No public SearXNG instance as default (no default base_url)
- Invalid base_url (file://, credentials, private IP) blocked at construction

### 2. HTTP request formation

- POST to `/search`
- `format=json` always included
- `q` parameter matches normalized query
- `language` included if configured
- `categories` included if configured
- `safesearch` included if configured
- `trust_env=False`
- Timeout matches `timeout_seconds`
- No automatic redirect following

### 3. Response parsing

- Normal result object → RawDiscoveryCandidate with url, title, snippet
- Missing title → empty string
- Missing content/snippet → empty string
- Non-HTTP URL in result → passed to build_discovery_result() which blocks it
- Duplicate result URLs → deduplicated by build_discovery_result()
- `source_engine` set to "searxng"

### 4. Failure honesty

- HTTP 403 → DiscoveryResult with error code `api_forbidden`
- HTTP 429 → DiscoveryResult with error code `rate_limited`
- HTTP 5xx → DiscoveryResult with error code `server_error`
- Timeout → DiscoveryResult with error code `timeout`
- Malformed JSON → DiscoveryResult with error code `malformed_response`
- Connection error → DiscoveryResult with error code `connection_error`
- DNS error → DiscoveryResult with error code `dns_error`
- Empty results → DiscoveryResult with empty candidates, no error

### 5. Security

- Snippets remain untrusted metadata (stored as-is, never executed)
- Unsafe URLs in results blocked by build_discovery_result()
- Query redaction appears in result metadata (query_redacted field)
- Raw query not logged by provider code
- base_url validated by URL policy before first use

## Non-goals

- No query caching in first implementation
- No retry logic for transient failures
- No engine selection per-query
- No page navigation (pageno)
- No time_range filtering
- No public SearXNG instance support
- No SearXNG instance provisioning or configuration management
- No changes to existing discovery contract types
- No changes to evidence schema or manifest schema
- No CLI changes in this verification phase
- No new dependencies (httpx already available)

## Decision

**ACCEPT_SEARXNG_PROVIDER_CANDIDATE** under these constraints:

1. Self-hosted or private instance required. No public instance default.
2. JSON format must be enabled in `settings.yml` (`search.formats: ['html', 'json']`).
3. All HTTP calls via httpx with `trust_env=False`, explicit timeout, no automatic redirect following.
4. All provider output flows through `build_discovery_result()`. No URL bypasses URL policy.
5. Expected provider failures (403, 429, 5xx, timeout, malformed JSON) return honest `DiscoveryResult` errors.
6. Tests must mock httpx at transport level. No live internet tests.
7. No query cache in first implementation.
8. Query redaction is best-effort. krn-ai-os must accept privacy model before enabling provider.
9. Snippets and titles are untrusted metadata. Never executed or interpreted.
10. base_url must pass URL policy before provider construction/use.

## Next recommended task

MVP-1E.4 — Implement `SearxngDiscoveryProvider` with mocked HTTP tests. No live internet. No CLI changes. No public instance default.
