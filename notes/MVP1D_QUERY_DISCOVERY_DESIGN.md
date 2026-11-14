# MVP-1D Query Discovery Design

**Baseline:** `b845d69a77c55684cfcab5954e3c40dcf748fc67`
**Date:** 2026-05-08
**Scope:** Design/documentation only. No runtime source changes. No new dependencies. No implementation.

## Can this project replace WebSearch now?

**No, not yet.**

Current state:
- `fetch-url` and `fetch-list` provide controlled URL/list ingestion with evidence packs, caching, redirect following, and strong security posture.
- Query search is not supported. There is no `search-query` command, no search API integration, no discovery backend.
- A user who already knows which URLs to fetch can produce evidence packs. A user who has a question and needs the system to find relevant sources cannot.

Future target:
```
query -> discovery candidates -> fetch-list -> evidence manifest -> Claude reads evidence as untrusted data
```

This memo designs the missing `query -> discovery candidates` stage and defines the conditions under which this project could replace WebSearch.

## Context

MVP-0, MVP-1A (fetch-list manifest), MVP-1B (redirect following), and MVP-1C (dependency verification) are all accepted. 231 tests pass. The ingestion primitive is complete and verified:

- `fetch-url`: single URL to evidence pack, with cache, redirect control, and security policy
- `fetch-list`: batch ingestion with manifest, quality scoring, and per-URL failure honesty
- All dependency behavior verified against upstream documentation
- Strong security posture: SSRF mitigation, credential blocking, prompt injection fencing, untrusted content isolation

The README's architecture section already sketches the future:

```
query -> candidate URLs -> fetch-url for each URL -> evidence pack set -> synthesis
```

The missing piece is the `query -> candidate URLs` stage. This memo designs it.

## What "query discovery" actually means

There are four distinct capabilities that get conflated under "search":

| Capability | Description | Dependencies |
|---|---|---|
| **A. Query to URLs** | Turn a user query into a ranked list of candidate URLs | Search API (SearXNG, Google, Brave, etc.) |
| **B. URL filtering** | Filter candidate URLs against policy, deduplicate | Already exists (url_policy) |
| **C. Batch fetch** | Fetch all candidates, produce evidence set | Already exists (fetch-list) |
| **D. Synthesis** | Merge evidence packs into a coherent answer to the query | LLM, not this tool |

The ingestion pipeline (MVP-0 through MVP-1C) covers **B** and **C**. Query discovery adds **A**. Synthesis (**D**) is explicitly out of scope and should remain so — it belongs in krn-ai-os, not in an ingestion primitive.

## Options evaluated

### Option A: Stop spike, port lessons to krn-ai-os

Accept that this spike has proven its thesis. Move the verified ingestion layer and design lessons into krn-ai-os. Let krn-ai-os own query discovery and synthesis.

### Option B: Design-only query discovery contract

Write this document: describe the design space, constraints, tradeoffs, and a recommended architecture for the `query -> candidate URLs` stage. No implementation.

### Option C: Minimal `search-query` CLI command

Implement a `search-query <query>` command that queries a search API, gets candidate URLs, and pipes them through the existing `fetch-list` pipeline.

### Option D: SearXNG integration plan

Design and plan integration with SearXNG as the search backend.

| Criterion | Option A | Option B | Option C | Option D |
|---|---|---|---|---|
| Product value | High | Medium | High | High |
| Security risk | None | None | Medium | Medium |
| Complexity | Low | Low | Medium | High |
| Reduces uncertainty | Yes | Yes | Yes | Partial |
| Helps krn-ai-os | Yes | Yes | Yes | Yes (with infra cost) |
| Framework risk | None | Low if brief | Medium | High |

## Decision

**Recommended direction: Option B deliverable now, Option A next action.**

```
Decision: Complete design-only query discovery contract in krn-search.
          Do not implement query discovery in this repo yet.
          Stop the spike after this memo unless explicitly reopened.
          Port lessons/design to krn-ai-os.

Rationale:
The ingestion spike has proven its thesis. URL-to-evidence is useful, secure,
honest, and verified. The remaining work (query discovery implementation,
synthesis) depends on krn-ai-os architecture decisions that this spike
cannot make.

This memo (Option B) provides:
1. The proven architecture diagram (query -> URLs -> fetch-list -> evidence)
2. The discovery interface contract (produce URLs, let fetch-list handle the rest)
3. Security analysis confirming the existing posture is sufficient
4. A clear boundary: ingestion is done, discovery/synthesis belong elsewhere
5. Conditions that must be true before implementation can begin

Option A (stop spike, port to krn-ai-os) is the next action after this memo.
krn-ai-os must decide the discovery backend, integration pattern, and synthesis
architecture. Those decisions require krn-ai-os context that this spike does not
have.

Rejected alternatives:
- Option C (minimal search-query): Couples the spike to a specific search
  backend choice. krn-ai-os should own that choice. Risks scope creep.
- Option D (SearXNG integration): Infrastructure coupling in a disposable spike.
  SearXNG is one option among many. The choice depends on krn-ai-os deployment.
- Option A without Option B: Wastes the design analysis. This memo is cheap
  insurance against losing the architectural reasoning.
```

## Architecture: query -> candidate URLs

The design space for the discovery layer is straightforward because the downstream primitive is already built. The question is: what sits to the left of `fetch-list`?

```
User query
    |
    v
[Discovery backend]  <-- the missing piece
    |
    v
List of candidate URLs (discovery candidate contract)
    |
    v
fetch-list (existing)  --> evidence pack set --> manifest
    |
    v
krn-ai-os synthesis    --> Claude reads evidence as untrusted data
```

### Discovery backend options

| Backend | Self-hosted? | Privacy | JSON API? | Rate limits? | Latency |
|---|---|---|---|---|---|
| SearXNG | Yes | Full | Yes | Self-imposed | ~1-5s |
| Brave Search API | No | Moderate | Yes | API key required | ~200ms |
| Google Custom Search | No | Low | Yes | 100/day free | ~200ms |
| DuckDuckGo (unofficial) | N/A | High | Unofficial | Unknown | ~1s |
| None (manual URLs) | N/A | Full | N/A | N/A | N/A |

### Discovery candidate contract

Whatever the backend, the discovery layer produces a simple output that feeds into the existing `fetch-list` input contract:

```
Input:  a user query string
Output: a list of candidate URLs

Constraints:
- Each URL must pass url_policy.check_url() — policy rejection is a failure,
  not a silent skip. The discovery layer must validate before returning.
- URLs are deduplicated after normalization (normalize_url applied).
- Maximum N URLs per query (configurable, suggested default: 10).
- URLs are ordered by the backend's relevance ranking.
  The ingestion layer preserves this ordering; it does not re-rank.
- Each URL includes its source metadata: title (if available), snippet (if
  available), rank position, discovery backend name.
```

This is deliberately thin. The discovery layer is a URL source, not a search engine. It does not synthesize — it produces candidates that the existing ingestion pipeline handles.

### Integration with fetch-list / evidence packs

The discovery candidate contract maps directly onto the existing `fetch-list` input contract:

1. Discovery produces a URL list.
2. That list is written to a temporary URLs file (or passed in-memory if krn-ai-os uses the library).
3. `fetch-list` processes each URL through the full pipeline: policy check, fetch, cache, extract, evidence pack.
4. Manifest is produced with quality scores and per-URL status.
5. krn-ai-os reads the manifest and evidence packs as untrusted data.

No changes to fetch-list, evidence pack schema, or manifest schema are required. The discovery layer is upstream of the ingestion pipeline, not part of it.

### Ranking and deduplication policy

| Concern | Policy | Rationale |
|---|---|---|
| Ranking | Accept the backend's ranking as-is. Do not re-rank in the ingestion layer. | Ranking is the backend's job. Re-ranking requires understanding content relevance, which is synthesis (krn-ai-os's domain). |
| Deduplication | Deduplicate by normalized URL after discovery. Do not deduplicate by content. | Content deduplication requires understanding text similarity, which is synthesis. URL-level dedup is sufficient and cheap. |
| Result count | Default 10, configurable by krn-ai-os. | 10 results fit comfortably in an LLM context window after extraction. krn-ai-os may want fewer for speed or more for coverage. |
| Domain diversity | No domain-level diversity enforcement in the ingestion layer. | Domain diversity is a ranking concern, not an ingestion concern. krn-ai-os can filter by domain in synthesis. |

### Cache semantics for discovery

Discovery introduces caching at a new layer that the current URL cache does not address:

| Cache layer | What it caches | TTL concern |
|---|---|---|
| URL cache (existing) | Fetched page body and metadata | None implemented. Content is assumed stable for the spike's lifetime. |
| Discovery cache (new) | Query -> URL list mapping | High. Search results decay in relevance within hours to days. |

**Policy:** Do not cache discovery results at the URL cache layer. Discovery caching is krn-ai-os's concern. If krn-ai-os wants to cache `query -> URL list` mappings, it should do so at the discovery layer, not by injecting search result URLs into the fetch cache.

Rationale: A cached discovery result returns stale URLs. A cached fetch result returns the page as it was when fetched. These are different staleness profiles. Conflating them would produce confusing behavior where a "cached" search returns URLs whose page content has been updated.

### Failure honesty for discovery

The ingestion layer's failure honesty principle extends to discovery:

| Failure mode | Behavior |
|---|---|
| Search API unreachable | Return empty URL list with error metadata. Do not silently retry. |
| Search API returns 0 results | Return empty URL list. Record the query and backend name. |
| Search API returns only policy-blocked URLs | Return empty URL list. Record how many URLs were blocked and why. |
| Search API returns partial results | Return what passes policy. Record how many were blocked. |
| Query is empty or malformed | Reject before hitting the API. Return input error. |

All failures are recorded in metadata. The manifest records which URLs were attempted and what happened. krn-ai-os sees the full picture, including what failed and why.

### Threat model expansion

The current threat model has one attacker: any HTTP server on the public internet. Query discovery expands the threat model:

| Threat | Current mitigation | Sufficient? |
|---|---|---|
| Malicious URL in search results | `url_policy.check_url()` blocks private IPs, credentials, blocked schemes | Yes — same as user-provided URLs |
| Malicious page content from search result | Evidence safety notice, adaptive fencing, untrusted content isolation | Yes — same as user-provided URLs |
| Search API reads user queries (privacy) | None — queries are sent to the API | Mitigation: self-hosted backend (SearXNG), or explicit user consent. This is a privacy concern, not a security vulnerability. |
| Compromised search API returns poisoned URLs | Same as "malicious URL in search results" — policy check handles it | Yes |
| Search API rate limits or blocks the client | No mitigation needed — honest failure reporting | Yes — failure is recorded |
| Search API returns钓鱼 URLs with convincing titles | Evidence packs record the title but mark content as untrusted. Title is metadata, not trusted content. | Partial — krn-ai-os synthesis must treat titles skeptically. This is synthesis's job, not ingestion's. |

**Conclusion:** The existing security posture is sufficient for query discovery. No new security mechanisms are needed in the ingestion layer. The one new concern (query privacy) is krn-ai-os's domain: it decides which backend to use and whether to inform the user.

### Query privacy policy

Query privacy is not an ingestion-layer concern. The ingestion layer treats all URLs the same regardless of how they were obtained (manual entry, search API, file, etc.). Query privacy is krn-ai-os's responsibility:

1. **Which backend to use.** Self-hosted (SearXNG) provides full query privacy. Proprietary APIs (Brave, Google) leak queries to third parties.
2. **Whether to inform the user.** krn-ai-os should disclose when queries are sent to external services.
3. **Whether to log queries.** This is krn-ai-os's operational decision.

The ingestion layer's role: receive a URL list, fetch each URL, produce evidence packs. It does not know or care where the URLs came from.

### What must be true before implementation

Query discovery implementation should not begin until all of these are true:

| # | Condition | Who decides | Current status |
|---|---|---|---|
| 1 | krn-ai-os architecture is stable enough to accept an ingestion library | krn-ai-os | Unknown |
| 2 | Discovery backend is chosen (SearXNG, Brave, Google, DuckDuckGo, or other) | krn-ai-os | Not decided |
| 3 | Privacy policy for query handling is defined | krn-ai-os | Not decided |
| 4 | Integration pattern is decided (CLI tool, Python library, or daemon) | krn-ai-os | Not decided |
| 5 | Result count and latency budget are defined | krn-ai-os | Not decided |
| 6 | Evidence pack schema is stable and accepted by krn-ai-os | This spike | Stable at v0.1 |
| 7 | All ingestion tests pass | This spike | 231/231 |
| 8 | All dependency behavior is verified | This spike | 7/7 VERIFIED |

Conditions 1-5 are krn-ai-os decisions. Conditions 6-8 are already met. This spike cannot make progress on 1-5.

### Evaluation plan for query discovery

If and when krn-ai-os decides to implement query discovery, the evaluation should cover:

| Scenario | What it tests |
|---|---|
| A — Simple factual query | "What is the Python GIL?" — discovery returns relevant docs URLs, fetch-list produces evidence packs, manifest records quality scores |
| B — Multi-source query | "Compare httpx and requests" — discovery returns URLs from multiple domains, fetch-list handles mixed outcomes |
| C — Ambiguous query | "Python logging" — discovery returns broad results, quality scores help krn-ai-os prioritize |
| D — No results | Query that returns 0 results — honest failure reporting |
| E — All results blocked | Query where all returned URLs fail policy check — honest failure reporting |
| F — Privacy | Verify query is not logged or leaked beyond the configured backend |

Acceptance criteria for the evaluation:
- Each scenario produces honest metadata (no false success, no silent failure)
- Evidence packs are indistinguishable from manually-sourced ones (same schema, same safety notice)
- URL policy blocks are recorded in manifest
- Quality scores reflect fetch/extraction outcome, not search ranking

### Non-goals for query discovery

- **No synthesis.** Merging evidence packs into a coherent answer is krn-ai-os's job.
- **No relevance ranking in the ingestion layer.** The discovery backend ranks; the ingestion layer preserves order.
- **No content deduplication.** URL-level dedup only. Content dedup is synthesis.
- **No query understanding or rewriting.** The user's query goes to the search API as-is.
- **No search API abstraction layer.** One backend, one integration. Backend swapping is krn-ai-os's problem.
- **No persistent query history.** Query logging is krn-ai-os's operational concern.
- **No browser rendering for discovery.** Discovery returns URLs; ingestion fetches them. If a URL requires JS rendering, the existing extraction limitation applies (low information density for SPAs).

### Impact on krn-ai-os

This spike provides krn-ai-os with:

1. **A verified ingestion layer.** URL-to-evidence is proven, tested (231 tests), and documented. Every dependency claim is verified against upstream docs.
2. **A clear architecture boundary.** Ingestion (this repo) ends at evidence pack production. Discovery and synthesis (krn-ai-os) sit above and below respectively.
3. **A discovery interface contract.** The candidate URL list format, constraints, and failure modes are defined. krn-ai-os can implement the discovery layer knowing exactly what the ingestion layer expects.
4. **A security analysis.** The existing URL policy and evidence fencing handle all discovery-related threats. No new ingestion-layer security mechanisms are needed.
5. **A conditions checklist.** 5 items that krn-ai-os must decide before implementation begins.

krn-ai-os does NOT get from this spike:
- A working search command
- A selected search backend
- A synthesis architecture
- A deployment plan
- Any new dependencies

### Recommended next prompt

For krn-ai-os, when ready to implement query discovery:

```
Based on the krn-search MVP-1D design memo, implement the discovery layer
as a Python library function that:

1. Accepts a query string and configuration (backend URL, max results).
2. Queries the chosen discovery backend (decide: SearXNG, Brave, or other).
3. Validates each returned URL against search_tool.url_policy.check_url().
4. Deduplicates by normalized URL.
5. Returns a DiscoveryResult with candidate URLs, titles, snippets, and metadata.
6. Feeds the URL list into the existing fetch-list pipeline.

Use the verified ingestion layer from krn-search as-is. Do not modify
the evidence pack schema, manifest schema, or URL policy.
```

## Deliverables for this task

1. `notes/MVP1D_QUERY_DISCOVERY_DESIGN.md` — this file
2. `notes/PROJECT_STATE.md` — update phase to MVP-1D complete
3. `notes/ACTIVE_TASK.md` — update with findings
4. `notes/EXPERIMENT_LOG.md` — add session entry
5. `notes/DECISION_CANDIDATES.md` — add durable candidates from this analysis

## Acceptance criteria

- Memo answers "Can this replace WebSearch now?" explicitly: No
- Memo covers current state vs future target
- Memo covers the four conflation-breaking capabilities
- Memo defines discovery candidate contract (input, output, constraints)
- Memo defines ranking/deduplication policy
- Memo defines cache semantics for discovery
- Memo defines failure honesty for discovery
- Memo includes threat model expansion table
- Memo includes query privacy policy
- Memo defines integration with fetch-list / evidence packs
- Memo lists what must be true before implementation (8 conditions)
- Memo includes evaluation plan (6 scenarios)
- Memo includes non-goals
- Memo includes impact on krn-ai-os
- Memo includes recommended next prompt
- 231/231 tests still pass (confirmation — no source changed)
- All notes files updated
- Docs-only commit

## Explicit non-goals (for this task)

- No implementation of query discovery
- No `search-query` CLI command
- No SearXNG integration
- No new dependencies
- No evidence schema changes
- No fetch-list manifest schema changes
- No source code changes
- No scripts
- No docs/ directory creation
- No generated evidence/cache/tmp files
- No framework spec or architecture document beyond this memo
