# MVP-1E.12 Final Search Pipeline Evaluation Report

## Baseline
- **Commit:** `b45ad682cceeafd3494e76130514d8d28a8ded1f`
- **Status:** Clean working tree, all tests passing.

## Executive verdict
krn-search is now a usable deterministic local search/ingestion pipeline MVP, but not yet a full WebSearch replacement. It can replace URL/list ingestion and controlled query-to-evidence workflows where the discovery backend is static or self-hosted SearXNG. It cannot yet replace broad web search in production because live search profile, quality/relevance evaluation, ranking policy, and answer synthesis remain out of scope.

## Current capability summary
- `fetch-url`: Single URL ingestion with security policy.
- `fetch-list`: Batch URL ingestion (up to 50 URLs).
- `discover-query`: URL discovery via Static or SearXNG providers.
- `search-query`: End-to-end query-to-manifest pipeline.
- `eval-corpus`: Deterministic pipeline verification runner.
- **Providers:** SearXNG (explicit self-hosted URL only), Static (manual candidates).
- **Artifacts:** Evidence packs (Markdown), fetch-list manifest (Markdown), search-run manifest (Markdown).
- **Security:** Strict URL policy, redirect following controls, secret redaction.

## Pipeline architecture
The pipeline follows a modular, composition-based approach:
1.  **Query:** User input query.
2.  **Discovery:** `DiscoveryProvider` (Static/SearXNG) returns candidates.
3.  **Selection:** candidates are filtered by `URLPolicy` and deduplicated.
4.  **Fetch:** `httpx`-based fetcher retrieves content (honors cache, follows redirects if opted-in).
5.  **Evidence:** `EvidencePack` generated for each result.
6.  **Manifests:** `fetch-list` manifest tracks URLs; `search-run` manifest tracks the full search context.

## CLI surface
- `krn-search fetch-url <url> [--refresh] [--follow-redirects]`
- `krn-search fetch-list <urls.txt> [--refresh] [--follow-redirects]`
- `krn-search discover-query "<query>" --provider static|searxng [options]`
- `krn-search search-query "<query>" --provider static|searxng [provider options] [--refresh] [--follow-redirects]`
- `krn-search eval-corpus <corpus.json> [--work-dir <dir>]`

## Artifact chain
`query -> discovery result -> selected URLs -> evidence packs -> fetch-list manifest -> search-run manifest -> eval-corpus JSON summary`

## Evidence and manifest model
- **Evidence packs:** Individual Markdown files per URL containing metadata and extracted text.
- **Fetch-list manifest:** Markdown file with YAML frontmatter summarizing a batch of fetches.
- **Search-run manifest:** Root artifact tying the query/provider context to the fetch results.

## Discovery model
- **Contract-based:** `DiscoveryProvider` interface ensures consistent candidate output.
- **Static:** Deterministic candidates for testing and known-URL workflows.
- **SearXNG:** Integration with self-hosted SearXNG instances for live discovery.

## Search-run manifest model
- **Version 0.1:** Markdown with YAML frontmatter.
- **Privacy-first:** Stores query hash and redacted query; omits snippets.
- **Auditability:** Links to `fetch-list` manifest; records provider config (sanitized).

## Evaluation corpus results
- **Full pytest suite:** 420/420 passed.
- **eval-corpus scenarios:** 11/11 passed.
- **JSON stdout:** Verified valid and machine-parseable.
- **Coverage:** Includes safe, duplicate, blocked, mixed, provider error, zero candidates, fetch failure, blocked redirect, extraction truncated, query redaction, and provider redaction scenarios.

## Security posture
- **URL policy:** Blocks unsafe targets (private IPs, restricted schemes).
- **Redirect policy:** Controlled, per-hop security checks.
- **SearXNG:** Explicit URL only; no public defaults; `trust_env=False`.
- **Isolation:** No browser automation; no MCP/hooks/plugins.
- **Manifests:** Secret redaction via blacklist in YAML frontmatter.

## Privacy posture
- **Query Protection:** Raw original query not stored in manifests; SHA256 + redacted query used instead.
- **Sanitization:** SearXNG URLs sanitized to host/port only in manifests.
- **Snippets:** Omitted from search-run manifest to reduce data duplication and exposure.
- **Corpus:** Uses fake secrets only; mocks network/DNS for total isolation.

## Failure honesty model
- Errors (404, 500, timeouts, policy blocks) are recorded as failure evidence packs.
- Discovery errors are summarized in stderr and captured in manifests.
- Exit codes distinguish CLI misuse (1) from operational success/failure (0).

## Determinism and CI readiness
- `eval-corpus` provides a 100% deterministic, network-free verification path.
- Deep mocking of `httpx` and `socket.getaddrinfo` ensures no leakage to real network/DNS.
- Stable fixture-based scenarios make the pipeline suitable for CI regression testing.

## What this can replace today
- Controlled URL ingestion for RAG or analysis.
- Batch URL ingestion for corpus building.
- Deterministic artifact creation for known queries/providers.
- Local CI regression testing for search safety.
- `krn-ai-os` ingestion primitive once wrapped in an adapter.

## What this cannot replace yet
- General-purpose WebSearch UX.
- Robust live result ranking/relevance.
- Multi-provider fallback.
- Live SearXNG reliability evaluation.
- Answer synthesis and direct citation management.
- Large-scale crawling or freshness guarantees.

## Integration guidance for krn-ai-os
- Wrap `krn-search` as a CLI-based provider.
- Consume the `search-run manifest` to identify evidence packs.
- Use the evidence packs as the primary source for LLM context.
- Maintain the security boundary by letting `krn-search` handle all network I/O.

## Known limitations
- Redaction is blacklist-based and best-effort.
- No JavaScript rendering (static HTML only).
- No query cache or retry logic.
- Max redirects fixed at 3.
- No search quality/relevance labeling.

## Recommended next decisions
- Whether MVP-1E is complete enough to stop feature work.
- Whether to implement a live SearXNG smoke profile or move integration to `krn-ai-os`.
- Whether to add GitHub Actions CI for the deterministic corpus.
- Whether to expose `krn-search` as an importable package or keep it CLI-only.

## Recommended next tasks
1.  **Stop / Integrate:** Proceed to `krn-ai-os` integration.
2.  **CI Gate:** Add GitHub Actions for the 420 tests + 11 corpus scenarios.
3.  **Smoke Profile:** Design an opt-in manual live SearXNG smoke test.
4.  **Relevance Corpus:** Add a corpus for quality/relevance labeling (not just structural passing).

## Stop / continue recommendation
**STOP** feature expansion in `krn-search-lab` after MVP-1E.12. The core pipeline is verified, deterministic, and safe. Further work (like relevance evaluation or synthesis) is better handled at the agent/OS layer or through a dedicated integration adapter. Proceed to `krn-ai-os` integration or CI stabilization.

## Final decision
**ACCEPT** MVP-1E.12. Pipeline is fully evaluated, documented, and ready for integration.
