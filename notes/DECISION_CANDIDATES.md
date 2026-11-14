# Decision Candidates

## Evidence pack path should be hash-based

**Candidate:** Use `<hostname-prefix>-<sha256-url-prefix>.md` for evidence filenames.

**Why:** URL-path-based naming leaks directory structure, causes collisions on long paths, and can be exploited with path traversal sequences (e.g. `../../etc/passwd`). Hash-based naming is collision-resistant and safe.

**Status:** Implemented in hardening pass.

## Query discovery should remain separate from ingestion

**Candidate:** The `fetch-url` primitive should remain standalone. Query/search discovery should be a separate layer above, not baked into the ingestion tool.

**Why:** URL-to-evidence is a single-responsibility primitive. Adding search introduces SearXNG, ranking, deduplication, and rate-limiting complexity that doesn't belong here.

**Status:** Not implemented. Design principle.

## final_url semantics require explicit redirect policy

**Candidate:** `final_url` must be null unless the tool actually followed a redirect to a final destination. Since MVP-0 does not follow redirects, `final_url` is null for all non-2xx responses.

**Why:** Claiming a final_url when no redirect was followed would be dishonest metadata.

**Status:** Implemented in hardening pass.

## Cache key should preserve query string

**Candidate:** Query strings are part of the resource identity. Different query params = different cache entries.

**Why:** `https://example.com/docs?page=1` and `?page=2` are different resources. Normalization must preserve this distinction.

**Status:** Implemented in hardening pass.

## Refresh bypasses cache but does not define object identity

**Candidate:** `--refresh` bypasses the cache but does not produce a different cache key. The same normalized URL + same config always maps to the same cache slot.

**Why:** Refresh means "re-fetch and overwrite the cached entry." It does not mean "create a separate cache entry."

**Status:** Implemented in hardening pass.

---

## SPA limitation is acceptable at MVP-0 scope

**Candidate:** Static HTML extraction is sufficient for MVP-0. Browser rendering (Playwright, Crawl4AI) is explicitly out of scope.

**Why:** 94% useful extraction on traditional docs (primary target). SPA provenance value is independent of extraction quality. Adding browser rendering would fundamentally change the tool's complexity, dependency profile, and trust model.

**Status:** Accepted. Noted in MVP0_DECISION_MEMO.

## Redirect following should be MVP-1, not MVP-0

**Candidate:** Follow 3xx redirects with a depth limit (suggested: 3) and policy-checked targets. Should be opt-in (`--follow-redirects` flag) or always-on with depth limit.

**Why:** httpx.org redirects to unstoppabledomains.com — this is a common pattern. Following redirects would recover ~1-2% of currently LOW-CONTENT URLs.

**Status:** Deferred to MVP-1. Noted in MVP0_DECISION_MEMO.

## Evidence provenance value is independent of extraction quality

**Candidate:** Even a LOW-CONTENT evidence pack has value because it records what URL was fetched, when, and what the server returned. This provenance is strictly better than copy-paste which provides no metadata.

**Why:** A failure pack proves the URL was attempted and why it failed. A truncated pack proves the content exceeded limits. This metadata has no equivalent in manual copy-paste.

**Status:** Confirmed by manual comparison in MVP0_DECISION_MEMO.

---

## Agent handoff docs are the source of truth before code exploration

**Candidate:** Handoff files (`CLAUDE.md`, `PROJECT_STATE.md`, `ACTIVE_TASK.md`, `AGENT_PROTOCOL.md`) must be read before any source code. Agents must not run broad repo exploration on startup.

**Why:** A previous agent session spent ~83k tokens and 28 tool calls exploring the repo before generating an implementation prompt. Handoff docs reduce this to under 5k tokens.

**Status:** Implemented.

## MVP-1A implementation must start from ACTIVE_TASK.md, not broad Explore

**Candidate:** When implementing fetch-list, the agent must read only the files listed in ACTIVE_TASK.md before writing code. Any broader exploration must be justified first.

**Why:** Handoff docs only reduce cost if agents actually follow them. The ACTIVE_TASK.md file lists the exact files relevant to fetch-list — no need for discovery.

**Status:** Documented in AGENT_PROTOCOL.md. Not yet tested with a real implementation session.

## Feature prompts are not the source of truth; repo handoff docs are

**Candidate:** When a user gives a feature instruction, the agent must cross-check it against the handoff docs. If the instruction conflicts with PROJECT_STATE.md non-goals or ACTIVE_TASK.md scope, the agent must stop and ask.

**Why:** Prevents scope creep from ambiguous feature requests. The repo documents what the project is and is not — that should override ad-hoc instructions.

**Status:** Documented in AGENT_PROTOCOL.md. Not yet tested.

## fetch-list manifest should not duplicate fetch-url pipeline

**Candidate:** `fetch-list` calls `fetch_url_to_evidence()` per URL and collects structured results. It does not re-implement the fetch/cache/extract/write pipeline.

**Why:** `fetch_url_to_evidence()` was extracted as a reusable helper in MVP-1A.0 specifically to avoid duplication. A separate pipeline would diverge over time and create subtle behavioral differences.

**Status:** Implemented in MVP-1A.1.

## fetch-list input contract errors should exit non-zero, not produce empty manifests

**Candidate:** Missing file, non-UTF-8 encoding, >50 URLs, and zero valid URLs all exit with code 1 and print to stderr. Per-URL failures still produce honest evidence packs and the batch continues.

**Why:** Input contract violations are user errors that should be caught early. Per-URL failures (blocked, DNS error, 404) are expected operational outcomes that should be recorded, not abort the batch.

**Status:** Implemented in MVP-1A.1. Confirmed by evaluation — quality score appears only in manifest.

## fetch-list manifest accepted as evidence-set primitive

**Candidate:** The fetch-list command with Markdown manifest is useful, honest, repeatable, and ready to serve as the multi-source evidence primitive before MVP-1B.

**Why:** 3-scenario evaluation (static docs, mixed outcome, markdown safety) scored 3/3 across all metrics. 13/13 acceptance criteria met. Per-URL failures produce honest evidence packs. Duplicates are preserved. Cache bypass/hit transition is visible. Markdown table escaping holds for pipes, angle brackets, backslashes.

**Status:** Accepted. Evaluation at `notes/MVP1A_FETCH_LIST_EVALUATION.md`.

## Redirect following should be MVP-1B, not MVP-1A

**Candidate:** Follow 3xx redirects with a depth limit and policy-checked targets. Should be a separate MVP after fetch-list is accepted.

**Why:** Redirect following changes the fetch pipeline (multi-hop, recursive policy checks). It should not block the fetch-list primitive, which works correctly without it. The MVP-0 evaluation showed ~1-2% of URLs produce redirect-only packs.

**Status:** Implemented and accepted as MVP-1B. Evaluation at `notes/MVP1B_REDIRECT_FOLLOWING_EVALUATION.md`.

---

## Controlled redirect following must remain opt-in by default

**Candidate:** `--follow-redirects` is opt-in. Default behavior is no-follow (MVP-0 preserved). httpx `follow_redirects=False` remains enforced at the client level.

**Why:** Automatic redirect following increases SSRF surface. Per-hop policy checks mitigate but do not eliminate the risk. Users must explicitly opt in.

**Status:** Implemented. Default is `follow_redirects=False`. All 231 tests confirm.

## Redirect following increases SSRF surface and must stay policy-checked per hop

**Candidate:** Every redirect target is URL-policy checked before fetch. Unsafe targets (file://, localhost, private IPs, credentials) are blocked and recorded with `blocked_reason`.

**Why:** A malicious server can redirect to internal services. Without per-hop policy checks, this becomes an SSRF vector. The existing URL policy is sufficient — no new checks needed.

**Status:** Implemented. `_fetch_with_redirects()` calls `check_url()` on every hop. Tests verify unsafe targets are never fetched.

## Query discovery should remain deferred until ingestion primitives are stable

**Candidate:** Query/search discovery should not be implemented until the ingestion primitives (fetch-url, fetch-list, redirect following) are stable and accepted.

**Why:** Adding search before ingestion is validated would create coupling. The evidence-set primitive (MVP-1A) and redirect following (MVP-1B) are now accepted. Query discovery can proceed as a future design task.

**Status:** Not implemented. Design principle. Both MVP-1A and MVP-1B accepted.

**Candidate:** The fetch-list manifest provides the evidence-set primitive. Query/search discovery should be layered above it, but only after the evidence-set workflow is proven.

**Why:** Adding search before the ingestion primitive is validated would create coupling. The evidence-set evaluation (MVP-1A) is now accepted, so query discovery can proceed as a future layer.

**Status:** Not implemented. Design principle. Evidence-set primitive is now accepted.

**Candidate:** A 0-3 quality score is computed per-URL and recorded in the fetch-list manifest. Individual evidence pack schema is unchanged.

**Why:** Individual evidence packs are self-contained records of what happened for a single URL. A quality score is a relative assessment that only makes sense in a batch context. Adding it to evidence packs would change the schema without adding per-pack value.

**Status:** Implemented in MVP-1A.1.

## Dependency documentation must be verified before discovery design

**Candidate:** All UNVERIFIED dependency entries in README must be resolved (VERIFIED, DOCUMENTED_DISCREPANCY, or BLOCKED_UNVERIFIED) before query discovery design work begins. Verification is conditional on docs access — if unavailable, the task is marked INCONCLUSIVE, not silently switched to a different task.

**Why:** A discovery layer designed on top of unverified assumptions inherits those risks. krn-ai-os needs trusted ingestion layer documentation.

**Status:** Not implemented. Design principle adopted in MVP-1C direction.

## Version constraint changes are findings, not verification actions

**Candidate:** If dependency verification reveals a need for version constraint changes, record as a finding/decision candidate. Do not change pyproject.toml during the verification task.

**Why:** Verification is docs-only. Mixing version bumps into a docs task conflates two concerns and risks introducing regressions without test justification.

**Status:** Not implemented. Scope constraint for MVP-1C.

---

## Query discovery is a krn-ai-os decision, not an ingestion spike decision

**Candidate:** The spike should stop after producing a design memo. Query discovery (search API selection, result count, caching, synthesis) depends on krn-ai-os deployment model and privacy requirements that this spike cannot decide.

**Why:** The ingestion spike has proven its thesis. URL-to-evidence is useful, secure, and verified. Query discovery requires choosing a search backend (SearXNG, Brave, Google, DuckDuckGo, or none), which is an infrastructure and privacy decision. Prolonging the spike past this point introduces framework risk without reducing krn-ai-os's actual uncertainty.

**Status:** Design memo written. Spike recommended to stop.

## MVP-1D decision: Option B deliverable now, Option A next action

**Candidate:** Complete design-only query discovery contract (Option B), then stop the spike and port lessons to krn-ai-os (Option A). Do not implement query discovery in this repo.

**Why:** Option B produces the discovery interface contract, security analysis, and conditions checklist that krn-ai-os needs. Option A is the natural next action — the spike has proven its thesis, and remaining decisions (backend, privacy, integration) require krn-ai-os context.

**Status:** Design memo complete. Spike stopped unless explicitly reopened.

## Discovery interface should be a thin URL list boundary

**Candidate:** The discovery layer produces a list of candidate URLs that feeds directly into the existing `fetch-list` input contract. No new abstractions, no ranking in the ingestion layer, no dedup beyond what fetch-list already handles.

**Why:** `fetch-list` already handles batch ingestion, failure isolation, manifest generation, and quality scoring. The discovery layer should be a URL source, not a search engine. Adding ranking or dedup logic to the ingestion tool conflates two separate concerns.

**Status:** Design principle. Not implemented.

## Existing security posture is sufficient for query discovery

**Candidate:** No new security mechanisms are needed in the ingestion layer for query discovery. The existing URL policy (private IP blocking, scheme restrictions, credential rejection) already handles malicious URLs from any source, including search results. Evidence packs already mark content as untrusted.

**Why:** A search API returning malicious URLs is the same threat model as a user providing a malicious URL directly. The URL policy and evidence fencing handle both cases. The new trust boundary (search API) is a privacy concern, not a security vulnerability that requires new ingestion-layer mechanisms.

**Status:** Security analysis in design memo. No code changes needed.

## "Search" conflates four distinct capabilities that should remain separate

**Candidate:** Query-to-URLs, URL filtering, batch fetch, and synthesis are four distinct capabilities. The ingestion spike covers URL filtering and batch fetch. Query-to-URLs is the discovery layer. Synthesis is krn-ai-os's domain. These should not be merged into a single "search" abstraction.

**Why:** Merging these creates coupling and framework risk. The ingestion tool should remain a single-responsibility primitive. Discovery and synthesis should be layered above it by krn-ai-os.

**Status:** Design principle documented in MVP-1D direction memo.

---

## krn-search remains the implementation home for controlled search/ingestion

**Candidate:** krn-search is the right place to implement the search/ingestion primitive. krn-ai-os consumes the capability later rather than owning the low-level implementation.

**Why:** Keeping implementation in krn-search maintains a clean boundary, allows independent testing of ingestion behavior, and prevents krn-ai-os from growing a dependency-heavy ingestion layer. The discovery interface contract defined in MVP-1D maps cleanly onto the existing fetch-list pipeline.

**Status:** Decided in MVP-1E.0 reopen.

## Project skills should hold reusable workflow, not CLAUDE.md

**Candidate:** Procedural workflow instructions (next-task, implementation, review, acceptance) should live in `.claude/skills/` as version-controlled project files. CLAUDE.md should stay concise and point to skills.

**Why:** CLAUDE.md is loaded into every conversation. Long workflow instructions waste context. Skills load on demand. Keeping CLAUDE.md concise reduces onboarding cost while skills provide detailed instructions when needed.

**Status:** Implemented in MVP-1E.0. Four skills created.

## Hooks deferred until a specific enforcement need exists

**Candidate:** Do not add Claude Code hooks until a concrete pattern emerges that would benefit from automatic enforcement. The current workflow is enforced through ACTIVE_TASK.md scope and skill instructions.

**Why:** Hooks run code with local credentials. Adding hooks before a specific need risks unintended side effects. The constraint system (handoff docs, agent protocol, skills) has proven effective at preventing scope creep without hooks.

**Status:** Decided in MVP-1E.0. Deferred.

## Subagents used only for isolated review/research, not as swarm orchestration

**Candidate:** Project subagents (krn-security-reviewer, krn-test-reviewer, krn-docs-reviewer) should be deferred until a concrete need exists. When created, they should be used for isolated context review only — not as a swarm orchestration pattern.

**Why:** Skills are sufficient for the current workflow. Adding subagents before they're needed is premature. Subagents are useful when a review task benefits from a separate context window (e.g., security review of a large diff).

**Status:** Decided in MVP-1E.0. Deferred.

---

## Discovery candidates are audit records, not evidence

**Candidate:** Discovery candidates (blocked, duplicate, and selected) remain visible in `DiscoveryResult.candidates` for provenance. They are not filtered out.

**Why:** Blocked candidates prove policy enforcement happened. Duplicate candidates prove deduplication happened. Removing them would lose the audit trail. krn-ai-os synthesis can use this metadata to understand why some URLs were not fetched.

**Status:** Implemented in MVP-1E.1.

## Blocked and duplicate discovery candidates remain visible for provenance

**Candidate:** `build_discovery_result()` never removes candidates — blocked ones get `url_policy="blocked"` and `selected_for_fetch=False`, duplicates get `duplicate_of` set and `selected_for_fetch=False`.

**Why:** Auditable provenance is more valuable than compact results. A future provider or krn-ai-os can see exactly what was rejected and why.

**Status:** Implemented in MVP-1E.1.

## Query redaction is best-effort and not a security boundary

**Candidate:** `redact_query()` uses regex patterns to redact obvious token-like segments (sk-*, ghp_*, github_pat_*, Bearer, api_key=, token=, password=). This is recorded as a limitation in every `DiscoveryResult`.

**Why:** Prevents accidental secret leakage in stored metadata without pretending to be a security mechanism. The redaction patterns cover common token formats but cannot guarantee all secrets are caught. The limitation is always recorded so consumers know not to trust `query_redacted` for security.

**Status:** Implemented in MVP-1E.1.

## URL policy remains the only authority for fetch eligibility

**Candidate:** `build_discovery_result()` calls `check_url()` for every candidate. Only candidates that pass URL policy get `selected_for_fetch=True`. The discovery layer does not add its own URL filtering — it delegates entirely to `url_policy.check_url()`.

**Why:** Single source of truth for URL safety. The discovery layer is a transformation/pipeline, not a policy authority. If URL policy changes (new block rules, new schemes), discovery automatically inherits those changes.

**Status:** Implemented in MVP-1E.1.

---

## Static provider is a test/evaluation fixture, not a search backend

**Candidate:** `StaticDiscoveryProvider` returns predefined candidates. It exists for testing the provider -> DiscoveryResult -> urls_for_fetch pipeline, fixtures, and local evaluation. It is not a search backend.

**Why:** Separating the provider interface from any specific backend allows testing the discovery pipeline independently. Network providers (SearXNG, Brave, etc.) will implement the same protocol.

**Status:** Implemented in MVP-1E.2.

## Provider interface should stay thin: discover(query) -> DiscoveryResult

**Candidate:** `DiscoveryProvider` Protocol defines only `name` and `discover(query, *, max_candidates) -> DiscoveryResult`. No registry, no plugin system, no middleware.

**Why:** The provider is a URL source. Adding abstraction beyond what tests require creates framework risk. The protocol is sufficient for static, mocked, and future network providers.

**Status:** Implemented in MVP-1E.2.

## Provider output must always flow through build_discovery_result()

**Candidate:** All providers (static and future network) delegate to `build_discovery_result()`. This ensures URL policy, dedup, normalization, and auditability are always applied.

**Why:** Single processing path prevents policy bypass. If a provider returns a malicious URL, `build_discovery_result()` catches it. Providers cannot skip policy checks.

**Status:** Implemented in MVP-1E.2.

## Network providers require separate docs/security verification

**Candidate:** Before adding a network provider (SearXNG, Brave, etc.), a separate docs task must verify the provider's API contract, authentication, rate limits, and privacy implications.

**Why:** Network providers introduce external dependencies, privacy concerns, and operational risks that the static provider does not have. Each requires its own verification pass.

**Status:** Completed for SearXNG in MVP-1E.3. Design principle remains for future providers.

---

## SearXNG provider requires self-hosted/private instance by default

**Candidate:** No public SearXNG instance may be used as the default provider target. The implementation targets a self-hosted or private instance where the operator controls configuration (JSON format enabled) and logging policy.

**Why:** Public instances often disable API formats (return 403 on `format=json`). Public instances may log queries. The operator has no control over rate limiting, uptime, or configuration changes. Self-hosted gives the operator full control over `search.formats`, `safesearch`, engine selection, and privacy.

**Status:** Accepted in MVP-1E.3 verification. Documented as constraint #1 in verification memo.

## Public SearXNG instances are not acceptable as default provider targets

**Candidate:** `SearxngDiscoveryProvider` must not ship with a default `base_url` pointing to a public instance. The user must explicitly provide a base_url. A missing or invalid base_url is a configuration error.

**Why:** Public instances disable API formats (403), may log queries, have unpredictable rate limits, and can change configuration without notice. Embedding a public instance URL as default would create a hidden external dependency and privacy risk.

**Status:** Accepted in MVP-1E.3. Provider dataclass has no default for `base_url`.

## Provider failures should return honest DiscoveryResult errors, not exceptions

**Candidate:** Expected HTTP/API failures (403, 429, 5xx, timeout, malformed JSON, connection error) must return a `DiscoveryResult` with error records, not raise exceptions. Only unexpected programming errors should propagate as exceptions.

**Why:** A provider failure (e.g., SearXNG down, JSON format disabled) is an expected operational outcome, not a bug. The discovery pipeline should continue processing and report what happened. krn-ai-os synthesis can decide how to handle partial results.

**Status:** Design principle accepted in MVP-1E.3. To be implemented in MVP-1E.4.

## Network provider tests must mock httpx at transport level, no live internet

**Candidate:** All tests for `SearxngDiscoveryProvider` (and future network providers) must mock httpx at the transport level. No live internet tests in the test suite.

**Why:** Live internet tests are flaky, slow, and depend on external service availability. A self-hosted SearXNG instance may not be available in CI. Mocking at the transport level allows testing all response shapes (normal, error, malformed) without network access.

**Status:** Accepted in MVP-1E.3. To be enforced in MVP-1E.4 test implementation.

## Query privacy policy must be accepted by krn-ai-os before provider call

**Candidate:** The SearXNG provider forwards queries to upstream search engines (Google, Bing, DuckDuckGo, etc.) via the SearXNG instance. This is inherent to meta-search and cannot be mitigated at the provider level. krn-ai-os must explicitly accept this privacy model before enabling the provider.

**Why:** `redact_query()` catches accidental token pastes but cannot prevent semantic leakage of the query topic. Every query sent to SearXNG reaches upstream engines. This is a privacy decision that belongs to the consuming system (krn-ai-os), not the ingestion tool.

**Status:** Accepted in MVP-1E.3. Documented as constraint #8. krn-ai-os must accept before integration.

---

## SearXNG provider has no public default base_url

**Candidate:** `SearxngDiscoveryProvider.base_url` is a required field with no default. Users must explicitly provide a self-hosted or private instance URL.

**Why:** Public instances disable API formats, log queries, and have unpredictable availability. Requiring explicit configuration prevents hidden external dependencies.

**Status:** Implemented in MVP-1E.4. `base_url` is the first positional argument with no default.

## Provider failures are represented as DiscoveryResult errors

**Candidate:** Expected HTTP/API failures (403, 429, 5xx, timeout, connection error, malformed JSON) return a `DiscoveryResult` with error tuples, not raised exceptions. The provider always returns a `DiscoveryResult`.

**Why:** A provider failure is an expected operational outcome, not a bug. The consumer can inspect `errors` and `limitations` to decide what to do. Exceptions are reserved for unexpected programming errors.

**Status:** Implemented in MVP-1E.4.

## No live internet tests for network providers

**Candidate:** All `SearxngDiscoveryProvider` tests use `httpx.MockTransport` to simulate HTTP responses. No test makes a live network call.

**Why:** Live internet tests are flaky, slow, and depend on external service availability. Mocking at the transport level allows testing all response shapes without network access.

**Status:** Implemented in MVP-1E.4. 45 tests, all mocked.

## All network discovery output flows through build_discovery_result()

**Candidate:** `SearxngDiscoveryProvider.discover()` parses the SearXNG JSON response into `RawDiscoveryCandidate` objects, then delegates to `build_discovery_result()` for URL policy, dedup, normalization, and auditability.

**Why:** Single processing path prevents policy bypass. If the SearXNG response contains a malicious URL, `build_discovery_result()` catches it.

**Status:** Implemented in MVP-1E.4.

---

## discover-query produces JSON discovery result, not evidence

**Candidate:** The `discover-query` CLI command prints a structured JSON DiscoveryResult to stdout. It does not fetch URLs, create evidence packs, or write files. The `urls_for_fetch` list is available for downstream piping.

**Why:** Discovery and ingestion are separate phases. discover-query is a URL discovery primitive; fetch-url and fetch-list handle ingestion. Mixing them would create coupling and hide the discovery pipeline from inspection.

**Status:** Implemented in MVP-1E.5.

## Provider operational failures exit 0 when represented in DiscoveryResult

**Candidate:** SearXNG provider failures (403, timeout, connection error, malformed response) produce a DiscoveryResult with error records and exit code 0. Only CLI misuse (missing required args, invalid values) exits 1.

**Why:** A provider failure is an expected operational outcome, not a user error. The JSON output contains error details so the consumer can decide what to do. CLI misuse should be caught early with a non-zero exit code.

**Status:** Implemented in MVP-1E.5.

## CLI misuse exits 1 for discover-query

**Candidate:** Empty query, missing --candidate-url for static, missing --searxng-url for searxng, invalid --safesearch, invalid --timeout, invalid --max-candidates, and metadata count mismatches all exit with code 1 and print to stderr.

**Why:** Input contract violations are user errors detectable before any provider work. Separating them from operational failures (exit 0) makes the CLI composable and scriptable.

**Status:** Implemented in MVP-1E.5.

## SearXNG requires explicit base URL, no public default

**Candidate:** The `--searxng-url` option is required when using `--provider searxng`. No public SearXNG instance URL is provided as default. The CLI validates this before contacting any provider.

**Why:** Public instances disable API formats (403), log queries, and have unpredictable availability. Requiring explicit configuration prevents hidden external dependencies and privacy risks.

**Status:** Implemented in MVP-1E.5. Consistent with MVP-1E.3 verification and MVP-1E.4 provider design.

## search-query composition should use a separate module, not inline CLI logic

**Candidate:** `search-query` should be implemented as a thin composition in `search_tool/search.py` with `SearchRunResult` dataclass and `search_query()` function. CLI wires via `_run_search_query()` in cli.py. Not inline in cli.py.

**Why:** cli.py is already 580+ lines. A separate module provides a clean unit-test boundary, makes krn-ai-os integration straightforward (import the function), and keeps CLI argparse handling thin. The module stays small (~50-80 lines) — one function, one result dataclass, calls existing discovery and fetch functions.

**Status:** Implemented in MVP-1E.7. `search_tool/search.py` module with `SearchRunResult` dataclass and `search_query()` function. CLI wired via `_run_search_query()` in cli.py.

## search-query MVP artifacts should be evidence packs + manifest only

**Candidate:** MVP-1E.7 should produce only individual evidence packs (existing schema) and a fetch-list manifest (existing schema). No search-run manifest, no discovery JSON file. These can be added later without breaking the CLI contract.

**Why:** Adding a search-run manifest before the basic composition works is premature. The fetch-list manifest already records all evidence packs. Search-run manifest and discovery JSON persistence are useful end-state artifacts but should be deferred until the basic composition is proven.

**Status:** Implemented in MVP-1E.7. Evidence packs + fetch-list manifest produced. Option 3 (search-run manifest) is the planned end-state for a future task.

## search-query exit codes inherit from discover-query and fetch-list

**Candidate:** CLI misuse (invalid args, empty query, missing required options) exits 1. All operational outcomes — including provider failures, zero URLs, all fetches failed — exit 0 with honest artifacts. The manifest is the authoritative record.

**Why:** Consistent with existing exit-code conventions. A provider failure or empty result is an expected operational outcome, not a user error. The manifest and evidence packs record what happened. Separating misuse (exit 1) from operational failure (exit 0) makes the CLI composable and scriptable.

**Status:** Implemented in MVP-1E.7. CLI misuse exits 1. All operational outcomes exit 0 with honest artifacts.

---

## Hybrid Evaluation Corpus (Strategy C)

**Candidate:** Use a hybrid corpus strategy: a JSON-based deterministic corpus for CI, plus an optional live profile for integration verification.

**Why:** CI must be fast, network-free, and deterministic. A mocked corpus provides this. However, verifying compatibility with real SearXNG instances is also valuable. Strategy C provides the best of both worlds without making CI flaky or dependent on external services.

**Status:** Recommended for MVP-1E.11. Design memo in MVP-1E.10.

## JSON for corpus fixtures

**Candidate:** Use JSON for corpus fixture files instead of YAML.

**Why:** The project currently depends on YAML (via frontmatter) but does not have a general-purpose YAML writing dependency (it uses manual string concatenation). Using JSON avoids adding a `PyYAML` dependency for tests/tooling while still being human-editable and machine-parsable.

**Status:** Recommended in MVP-1E.10.

## Structural assertions only for live evaluation

**Candidate:** Live evaluation (against real SearXNG) should only assert on structural and metadata outcomes (e.g., "was a manifest written?", "are error counts recorded?"), not on exact URL content or snippet text.

**Why:** Real search results are dynamic and non-deterministic. Asserting on exact URLs or content would lead to brittle tests. Structural assertions verify that the *pipeline* works without being sensitive to changing web content.

**Status:** Recommended in MVP-1E.10.

---

## Stop MVP-1E feature expansion after final report unless explicit next goal selected

**Candidate:** Feature work in the `krn-search-lab` spike should stop after the MVP-1E.12 final evaluation report. Remaining work (integration, CI gate, live smoke profile, relevance corpus) should only proceed if explicitly chosen as a next phase.

**Why:** The core pipeline is complete, deterministic, and safe. Continuing to add features casually risks scope creep and framework bloat. The spike has served its purpose as a verified ingestion primitive.

**Status:** Recommended in MVP-1E.12.

## Prefer krn-ai-os integration adapter before more standalone features

**Candidate:** The next priority should be building an adapter for `krn-ai-os` to consume `krn-search` CLI artifacts.

**Why:** Proving the value of the tool in its intended host environment is more important than adding more standalone search features (like multi-provider fallback or synthesis).

**Status:** Recommended in MVP-1E.12.

## Live SearXNG smoke profile must be opt-in/manual only

**Candidate:** If a live SearXNG evaluation profile is implemented, it must be opt-in via environment variables or CLI flags and must not run in default CI.

**Why:** Live tests are flaky and require external setup. Keeping them manual/opt-in prevents CI degradation while still allowing for integration smoke testing.

**Status:** Recommended in MVP-1E.12.

---

## UI search diagnostics should show status breakdown

**Candidate:** The UI search summary should show a detailed breakdown of discovery (candidates, selected, blocked, duplicates, errors) and ingestion (extracted, truncated, redirects, failed, blocked, skipped).

**Why:** A simple "X evidence packs created" is misleading when some are success and some are failure/redirect packs. The detailed breakdown provides better visibility into the pipeline's outcome.

**Status:** Implemented in MVP-1F.1.

## UI search should use run-specific isolation

**Candidate:** Every UI search run should use a unique subdirectory under `work-dir/runs/`.

**Why:** Prevents artifact name collisions between runs and ensures each search run's evidence is clearly isolated. Helps in browsing artifacts without a flat list of hundreds of files.

**Status:** Implemented in MVP-1F.1.

## UI search should redact SearXNG credentials before display

**Candidate:** Any SearXNG URL provided in the UI should be sanitized to remove credentials and paths before being returned in the API response or manifest.

**Why:** Prevents accidental leakage of instance credentials or private search queries in the browser's UI or local artifacts.

**Status:** Implemented in MVP-1F.1.

---

## Claude Code skills should wrap search-query, not replace it

**Candidate:** A Claude Code skill should invoke `search-query` CLI with SearXNG provider and read evidence packs. No synthesis in the skill — the agent reads evidence directly.

**Why:** The CLI contract is stable and well-tested. Wrapping it preserves the existing audit trail (manifests, evidence packs). Synthesis is the agent's job, not the skill's. The skill adds convenience (SearXNG URL, default flags, evidence parsing).

**Status:** Recommended by MVP-1F.2 dogfooding. Not implemented.

## WebSearch prevention hook should be deferred until skill-based workflow proves comfortable

**Candidate:** Do not create a Claude Code hook that prevents WebSearch usage. WebSearch and krn-search serve different purposes. A hook would be premature.

**Why:** krn-search is a local ingestion primitive. WebSearch is a general web search for the model. They can coexist. A hook should only be created if dogfooding shows that the skill workflow naturally replaces WebSearch use cases.

**Status:** SUPERSEDED by MVP-1G.0. Hook implemented as deny-with-recovery after skill workflow proved sufficient. Dogfooding confirmed that soft policy text alone was not enforcement enough.

## Skills/rules should be created before hooks

**Candidate:** Create Claude Code skills/rules for krn-search usage before any hook implementation. The skill teaches the workflow; hooks enforce it later if needed.

**Why:** A skill that no one finds comfortable is a bigger problem than a hook that doesn't exist. Skills can be iterated quickly. Hooks require more caution. Getting the workflow right first reduces the risk of premature enforcement.

**Status:** Implemented in MVP-1F.3.

## WebSearch fallback should be explicit/user-approved when krn-search evidence is insufficient

**Candidate:** When krn-search produces insufficient evidence, the agent should report the limitation and ask the user whether to fall back to WebSearch. No automatic fallback, no blocking.

**Why:** The user should control whether their research uses local evidence (krn-search) or general web search (WebSearch). Automatic fallback would undermine the controlled ingestion model. Blocking would be premature.

**Status:** SUPERSEDED by MVP-1G.0. WebSearch/WebFetch are now mechanically blocked by hook policy. Agent must report limitation honestly; user must explicitly request WebSearch if needed (hook blocks it).

---

## CLAUDE.md SearXNG hard non-goal wording is misleading

**Candidate:** CLAUDE.md lists "SearXNG" as a hard non-goal, but the tool ships `SearxngDiscoveryProvider` and the skill documents `--provider searxng`. The non-goal likely meant "SearXNG as a required runtime dependency" or "SearXNG as the project's primary architecture." The wording should be clarified to avoid contradiction.

**Why:** A hard non-goal that directly contradicts implemented functionality undermines trust in the project documentation. New contributors or agents reading CLAUDE.md may incorrectly believe SearXNG is not supported.

**Status:** Fixed in MVP-1F.4.1. Wording changed to "SearXNG as a required runtime dependency; optional explicit provider allowed only through ACTIVE_TASK.md-scoped work."

---

## First WebSearch guard should use ask/coach mode, not hard deny

**Candidate:** The first WebSearch/WebFetch PreToolUse hook implementation should return `ask` with a coaching message, not `deny`. Hard deny should only be considered after dogfooding ask mode.

**Why:** Starting with the most restrictive option (deny) risks blocking legitimate work and causing users to disable the hook entirely. Ask mode forces conscious decision while preserving the escape hatch. If ask mode proves too noisy, downgrade to warn-only. If too permissive, escalate to deny — but this requires evidence from dogfooding.

**Status:** SUPERSEDED. Initially implemented as ask-mode in MVP-1F.6, then upgraded to deny-with-recovery in MVP-1G.0 after dogfooding confirmed ask mode was insufficient enforcement.

## Hook must not auto-run krn-search

**Candidate:** The WebSearch guard hook should suggest krn-search in its coaching message but must never execute krn-search or any other tool. Hooks are guards, not orchestrators.

**Why:** Auto-running krn-search from a hook creates unexpected side effects, changes the tool call sequence, and could produce artifacts the user didn't request. The hook's job is to pause and inform — the user or agent decides what to do.

**Status:** Designed in MVP-1F.5. Not implemented.

## First hook implementation should be local-only in settings.local.json

**Candidate:** The first WebSearch guard implementation should be configured in `.claude/settings.local.json` (not committed), not `.claude/settings.json` (committed and shared). Only promote to project settings after explicit user approval.

**Why:** A hook that pauses every WebSearch/WebFetch call can significantly disrupt workflow. Starting local-only lets the user dogfood without affecting other contributors. If the hook is too noisy, the user can remove it without a commit. Promotion to project settings requires confidence from dogfooding.

**Status:** Designed in MVP-1F.5. Not implemented.

## WebSearch usage during design confirmed need for hook

**Candidate:** During the first attempt at MVP-1F.5 design, Claude Code attempted to use WebSearch to research hook documentation — the exact behavior the hook is designed to prevent. This proves that CLAUDE.md policy text and skill instructions alone are insufficient enforcement mechanisms.

**Why:** Soft guidance (CLAUDE.md, skills, commands) relies on the model following instructions. A hook provides a mechanical checkpoint that the model cannot bypass. The trigger incident is direct evidence that both mechanisms are needed.

**Status:** Recorded in MVP-1F.5 design memo trigger incident section.

---

## WebSearch/WebFetch guard hook uses deny-with-recovery mode with hookSpecificOutput.permissionDecision

**Candidate:** The implemented hook returns `{"hookSpecificOutput": {"permissionDecision": "deny", "permissionDecisionReason": "..."}}` for WebSearch/WebFetch, and produces no output for other tools. It uses the current Claude Code hook schema, not the deprecated `decision`/`reason` fields. The reason includes krn-search recovery commands and instructs Claude not to retry WebSearch/WebFetch.

**Why:** The `hookSpecificOutput` schema with `permissionDecision` is the current Claude Code hook contract. Using deprecated fields would silently fail or produce unexpected behavior. Fail-open on malformed input ensures the hook never blocks legitimate work. Upgraded from ask-mode to deny-with-recovery in MVP-1G.0 after dogfooding confirmed that soft guidance was insufficient.

**Status:** Implemented in MVP-1F.6 (ask-mode), upgraded to deny-with-recovery in MVP-1G.0. Hook script at `.claude/hooks/websearch_krn_search_guard.py`, config at `.claude/settings.local.json` (not committed).

## Hook tests use importlib for direct function import

**Candidate:** Unit tests import the hook script via `importlib.util.spec_from_file_location` rather than requiring a package structure. Integration tests run the script as a subprocess via stdin/stdout.

**Why:** The hook script lives in `.claude/hooks/`, not in the Python package tree. Using `importlib` avoids adding `__init__.py` files or modifying `sys.path` in tests. Subprocess tests validate the actual hook entry point.

**Status:** Implemented in MVP-1F.6. 14 tests (8 unit + 6 integration).

## Source quality is deterministic metadata, not AI ranking or answer synthesis

**Candidate:** Source quality metadata (source_type, authority_score, is_official) is computed from URL/domain/title using deterministic heuristics only. No LLM scoring, no network lookup, no content analysis.

**Why:** Adding AI-based ranking would make krn-search non-deterministic, add latency, create a dependency on model availability, and undermine the "web evidence compiler" identity. Deterministic metadata is reproducible, testable, and predictable — exactly what Claude needs to decide which evidence packs to inspect first.

**Status:** Implemented in MVP-1H.1. `search_tool/source_quality.py` with `classify_source_quality()`.

## Compact evidence index is a deterministic mechanical summary, not AI synthesis

**Candidate:** The compact summary (`--compact` flag) produces a Markdown index with source table, mechanical snippets, and failure/limitation sections. No AI summarization, no LLM ranking, no synthesis. Reading order is by authority_score desc, quality desc, rank asc — labeled as mechanical ordering, not AI judgment.

**Why:** The compact index lets Claude decide which evidence packs to read without loading everything into context. It must be deterministic and reproducible so tests can verify exact output. AI summarization would undermine this goal by introducing non-deterministic content that can't be asserted on.

**Status:** Implemented in MVP-1H.2. `search_tool/compact.py` with `write_compact_summary()`.

## Research mode preset should be a flag on search-query, not a new subcommand
**Candidate:** `--research` flag on `search-query` expands to deterministic defaults (provider=auto, json=true, compact=true, profile=official-docs, work-dir=.local/krn-search-runs, follow-redirects=true). Explicit flags override defaults. JSON includes `research_mode` object with expanded_defaults and effective_values.
**Why:** A new `research-query` subcommand would duplicate CLI surface and create maintenance burden. A documented-only preset is fragile (Claude forgets flags). Slash-command-only is not scriptable. A single flag on `search-query` is the smallest surface that solves the problem while preserving backward compatibility.
**Status:** Implemented in MVP-1H.5. `--research` flag on `search-query` with `--no-compact` and `--no-follow-redirects` negation. `--provider` is now optional. 637/637 tests pass.

---

## Query profiles are deterministic presets, not AI ranking

**Candidate:** Profiles (`--profile`) bias source ordering toward preferred source types (e.g., official-docs prefers official_docs, standards, repository). Selection policy is `prefer_not_require` — preferred sources sort first but no results are hidden. Profiles affect ordering, metadata, and compact summary only — they do not alter evidence pack content or discovery behavior.

**Why:** Claude Code needs a way to bias research toward better source classes without LLM ranking or synthesis. Deterministic profiles are reproducible, testable, and predictable. Hard filtering would hide evidence and reduce transparency. `prefer_not_require` ensures failure honesty is preserved.

**Status:** Implemented in MVP-1H.3. `search_tool/profiles.py` with three profiles: official-docs, github-repo, security-research.

---

## Relevance scoring interpretation guide bands should match observed score ranges

**Candidate:** Update the score interpretation guide to reflect observed evidence relevance clustering in 30-65% range for useful content. Current "strong overlap" (0.6-0.8) and "very strong overlap" (0.8-1.0) bands are rarely achievable. Suggested: 0.25-0.50 moderate, 0.50-0.65 strong, 0.65+ very strong.

**Why:** 6-scenario dogfood showed highest evidence relevance was 66%. Heading_match is often 0.0 and exact_phrase_in_text rarely triggers, capping the weighted formula. The current guide creates false expectations of score ranges that don't occur in practice.

**Status:** Recommended by MVP-1Q.4 dogfood. Not yet implemented.

## Evidence relevance may need package/entity-name disambiguation

**Candidate:** Both candidate and evidence relevance use `_token_overlap()` with `_text_tokens()` whole-token membership — the same matching strategy at both stages. There is no substring matching anywhere in the scoring pipeline. The issue is entity/package-name ambiguity: query token `requests` (the Python package) cannot be distinguished from the generic HTTP term `request` in `urllib.request` documentation. A future improvement could add package/entity-name awareness (e.g., exact package-name boosting or partial entity overlap penalty), but this requires a known-entities dictionary or heuristics beyond current scope.

**Why:** The "HTTP client python requests library" dogfood scenario showed urllib docs scoring 66% vs requests docs at 60% — the wrong library ranked higher because whole-token matching correctly treats `requests` and `request` as different tokens, but the scoring does not know that `requests` is the intended package/entity and can still be dominated by other overlapping generic tokens (`HTTP`, `client`, `python`, `library`).

**Status:** Recommended by MVP-1Q.4 dogfood. Medium priority. Not yet implemented.

## Official source_quality_modifier should have a minimum relevance floor

**Candidate:** The `source_quality_modifier` +0.1 for official sources should only apply when `base_score > 0.05`. This prevents irrelevant official docs from getting a free boost.

**Why:** Dogfood scenario 4 showed Python docs scoring 10% for a Rust query (base 0.0 + 0.1 official modifier). While 10% is still very low, it's conceptually wrong for completely irrelevant content to get a boost.

**Status:** Recommended by MVP-1Q.4 dogfood. Low priority. Not yet implemented.

## Generic page penalty may need strengthening for exact-phrase listings

**Candidate:** The -0.15 generic page penalty may be insufficient for SEO listings that have exact phrase matches in titles. Consider increasing to -0.20 or adding an additional exact-phrase-in-listing penalty.

**Why:** Dogfood scenario 2 showed the realpython listing still scoring 55% candidate relevance after penalty (from ~70%). It outscored Django official docs (49%) despite being a listing/comparison page.

**Status:** Recommended by MVP-1Q.4 dogfood. Low-medium priority. Not yet implemented.

## Heading match weight may be inefficient

**Candidate:** `heading_match` was 0.0 in 5 of 6 dogfood scenarios. Headings use structural vocabulary that doesn't overlap with query terms. Consider reducing the 0.15 weight and redistributing to `early_content_overlap` or `text_overlap`.

**Why:** The heading_match component effectively contributes nothing in most cases, wasting 15% of the scoring formula. Evidence relevance ceiling is partly caused by this dead weight.

**Status:** Informational finding from MVP-1Q.4 dogfood. Not yet recommended for change.
