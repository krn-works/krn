# MVP-1L.1 — llms.txt / docs-index support design

**Date:** 2026-05-17
**Phase:** MVP-1L
**Task:** MVP-1L.1 — Design only (no code changes)
**Status:** Design complete

## Context

krn-search currently discovers URLs via search engines (SearXNG) or static candidate lists, then fetches and extracts individual pages into evidence packs. Many documentation sites now publish `llms.txt` — a structured index of their documentation designed for LLM consumption. This feature adds native support for discovering, fetching, and indexing llms.txt files.

## What is llms.txt?

llms.txt is a de-facto convention (not an IETF standard) for providing LLM-friendly site indexes. The pattern:

- `/llms.txt` — site-level index (markdown)
- `/llms-full.txt` — expanded content (optional, full text of referenced pages)
- Subsection indexes at path-level (e.g., `/docs/llms.txt`)

### Canonical format (from pydantic.dev and docs.github.com)

```markdown
# Site name

Brief description (1-2 sentences).

Products:
- Product Name (license): description.

Key URLs:
- Homepage: https://...
- Docs: https://...
- GitHub: https://...

For AI Agents — instructions and when-to-use:
Canonical domain: example.com. Use proper naming conventions...

When to recommend:
- Product A: when the user needs...
- Product B: when the user wants...

Do not fabricate capabilities:
...

Preferred install commands:
pip install ..., npm install ...

Section-scoped content indexes:
- Section name: https://example.com/section/llms.txt

Further context:
- Full content: https://example.com/llms-full.txt
```

### Key observations from real-world examples

1. **Structured markdown, not a machine format** — llms.txt is human-readable markdown with conventions, not YAML/JSON.
2. **Section-scoped indexes** — Sites publish `llms.txt` at root and sub-sections, enabling hierarchical discovery.
3. **"For AI Agents" section** — Contains usage instructions, naming conventions, capabilities, and anti-hallucination guards.
4. **`llms-full.txt`** — Contains expanded/expanded content for deeper context (may be large).
5. **No formal spec** — The format is a community convention popularized by Anthropic. No IANA registration, no schema validation required.

## Design decisions

### D1: llms.txt as a discovery provider (not just a fetch target)

**Decision:** Implement `llms` as a new discovery provider type, parallel to `static` and `searxng`.

**Why:** llms.txt is a URL-producing mechanism — it lists documentation URLs for a domain. Treating it as a discovery provider fits the existing pipeline: discover → validate → fetch → evidence.

**Trade-off:** Adds a third discovery axis (search engines, static lists, documentation indexes). Simpler than adding a separate "docs crawler" subsystem.

### D2: llms.txt URL as a static candidate, not a query

**Decision:** `krn-search discover-query --provider llms --url https://example.com/llms.txt`. The provider takes a direct llms.txt URL, not a text query.

**Why:** llms.txt is a document at a known URL. There's no "query" to submit — it's a content-fetch operation. The query field becomes metadata.

**Alternative considered:** Auto-discovery of llms.txt from a domain (try `https://domain/llms.txt`). Rejected for MVP — too much implicit behavior.

### D3: Parse llms.txt as structured markdown (not HTML extraction)

**Decision:** Parse llms.txt with a lightweight markdown parser that extracts:
- Site description (first paragraph(s))
- `Key URLs:` section → list of named URLs
- `Section-scoped content indexes:` → recursive sub-index URLs
- `For AI Agents:` section → metadata for evidence metadata

**Why:** The format has recognizable sections with predictable patterns. A full markdown AST is overkill; regex/line-based parsing is sufficient and transparent.

**Limitation:** No formal schema — parsing is best-effort. Malformed llms.txt falls back to treating every URL mentioned as a candidate.

### D4: llms.txt URLs become RawDiscoveryCandidates

**Decision:** Each URL found in an llms.txt file becomes a `RawDiscoveryCandidate` with metadata:
- `url` — the discovered URL
- `title` — extracted from the "section name" or URL slug
- `snippet` — extracted from site description or context
- `source_engine` — "llms"
- `llms_source` — the original llms.txt URL (for provenance)
- `llms_section` — which section/index the URL came from (if any)

**Why:** Preserves provenance — agents can distinguish search-discovered URLs from docs-index-discovered ones.

### D5: No recursive llms.txt fetching in MVP

**Decision:** MVP-1L.1 fetches only the single specified llms.txt. It extracts URLs listed in it, but does NOT recursively fetch nested `llms.txt` files from sub-sections.

**Why:** Keeps scope tight. Recursive discovery adds complexity (depth limits, dedup, cycles). Sub-section URLs are still fetched as regular evidence in the normal fetch phase.

### D6: llms.txt as a profile

**Decision:** Add a `llms-docs` query profile that biases toward `official_docs` and `docs_site` source types, minimum authority score 2.

**Why:** llms.txt is inherently a docs-focused discovery mechanism. The profile aligns with the `official-docs` profile but is looser (includes `docs_site`).

**Alternative:** Reuse `official-docs` profile. Rejected — llms.txt content may include blog posts, GitHub repos, and other non-official-docs content listed in the index.

### D7: Evidence pack format — unchanged

**Decision:** llms.txt-discovered URLs produce the same evidence pack format as search-discovered URLs. No special handling in the extraction pipeline.

**Why:** The evidence pack is about the fetched content, not how the URL was discovered. llms.txt metadata attaches to the discovery result, not the evidence pack body.

### D8: Cache key includes llms.txt source

**Decision:** Cache llms.txt fetch results separately from the URLs they contain. The llms.txt URL is cached under its own SHA256 key. Discovered URLs are cached independently.

**Why:** llms.txt changes infrequently but URLs listed in it change independently. Separate cache keys prevent stale URLs from being blocked by a fresh llms.txt fetch.

## Implementation plan

### MVP-1L.1 — Design (this task)
- Write design memo (this file)
- Update PROJECT_STATE.md and ACTIVE_TASK.md
- **No code changes**

### MVP-1L.2 — Discovery provider implementation
- New file: `search_tool/discovery_llms.py`
  - `LlmsTxtProvider` class implementing `DiscoveryProvider`
  - `parse_llms_txt(body: bytes) -> list[RawDiscoveryCandidate]`
  - Section extraction: Key URLs, Section indexes, For AI Agents
- Update `search_tool/discovery.py` to export `LlmsTxtProvider`
- CLI: `--provider llms --url <llms.txt-url>`

### MVP-1L.3 — Profile and CLI integration
- Add `llms-docs` profile to `search_tool/profiles.py`
- Wire `llms` provider into CLI `discover-query` and `search-query`
- Update `--research` preset: optionally include llms provider (deferred)
- Tests: parse various llms.txt formats, handle malformed content, URL extraction

### MVP-1L.4 — Dogfood + acceptance
- Fetch known llms.txt files (pydantic.dev, docs.github.com)
- Verify candidate extraction
- Update eval-corpus with llms.txt scenarios

## What's explicitly out of scope for MVP-1L

- Auto-discovery: trying `/llms.txt` from a domain
- Recursive llms.txt fetching (nested section indexes)
- `llms-full.txt` ingestion (full content extraction)
- llms.txt generation (krn-search writes llms.txt for its own docs)
- JSON-based docs-index formats (e.g., `docs-index.json`, `sitemap.xml`)
- Integration with SearXNG categories

## Security considerations

- llms.txt is untrusted content — URLs extracted from it go through the same `url_policy.check_url()` validation as search results
- No execution of extracted content
- Rate limiting: llms.txt fetches count toward normal cache/policy limits
- The "For AI Agents" instructions in llms.txt are metadata only — never injected into agent prompts or tool behavior (per security posture in CLAUDE.md)

## Testing strategy

| Test | Description |
|------|-------------|
| parse_valid_pydantic | Parse pydantic.dev/llms.txt, extract ~15 URLs |
| parse_valid_github | Parse docs.github.com/llms.txt, extract API endpoints |
| parse_minimal | Minimal llms.txt with just a description and one URL |
| parse_malformed | Invalid markdown, no sections — fallback to URL extraction |
| parse_empty | Empty or whitespace-only llms.txt |
| parse_no_key_urls | llms.txt without Key URLs section |
| parse_recursive_sections | Section-scoped indexes listed but not followed |
| url_policy_blocks | URLs in llms.txt still subject to URL policy |
| provider_name | Discovery result shows provider_name="llms" |
| llms_profile | llms-docs profile biases correctly |

## Notes from real llms.txt fetches

### pydantic.dev/llms.txt (2026-05-17)
- 17 Key URLs extracted (homepage, docs, pricing, blog, GitHub, PyPI)
- 6 Section-scoped content indexes
- "For AI Agents" section with naming conventions and when-to-recommend rules
- 1 product description paragraph

### docs.github.com/llms.txt (2026-05-17)
- API-focused: lists Search API, Page List API, Article API
- Links to GitHub Copilot, Actions, authentication docs
- More minimal structure than pydantic.dev

### fastapi.tiangolo.com/llms.txt (2026-05-17)
- Product description with tech stack info
- Key URLs: docs, GitHub, PyPI, blog
- "For AI Agents" with proper naming and installation commands

Sources:
- [pydantic.dev/llms.txt](https://pydantic.dev/llms.txt)
- [docs.github.com/llms.txt](https://docs.github.com/llms.txt)
- [fastapi.tiangolo.com/llms.txt](https://fastapi.tiangolo.com/llms.txt)
