# Search vs Research Architecture

## Scope

This note defines the architectural distinction between controlled search and controlled research in krn-search. It records current capabilities, a real-world failure mode discovered through dogfooding, and the staged roadmap toward iterative research.

## Search mode

Search is a single-pass discovery-and-ingest cycle:

1. Query → discovery provider (static, SearXNG, llms.txt)
2. Candidate URLs → canonical dedup
3. Fetch → extract → evidence pack
4. Final-URL dedup (mark, reference, skip)
5. Manifest + compact summary

Search answers: "What evidence exists for these URLs?"

It does not evaluate whether the evidence is *useful* for a research question. Success is measured mechanically: fetch completed, extraction succeeded, evidence written.

## Research mode

Research mode (`--research`) is a deterministic preset over search mode:

- `provider=auto`, `json=true`, `compact=true`, `profile=official-docs`
- `follow-redirects=true`, `work-dir=.local/krn-search-runs`

Research mode does not add a feedback loop, relevance scoring, or iterative refinement. It makes the single-pass search output easier to consume for Claude Code agents (JSON, compact index, quality metadata, profile-based ordering).

Research mode answers: "What evidence exists, structured for agent consumption?"

It does **not** answer: "Is this evidence useful for my question?"

## Current capabilities

| Capability | Status |
|---|---|
| URL-to-evidence-pack (fetch-list) | Stable |
| Discovery providers (static, SearXNG, llms.txt) | Stable |
| Canonical candidate dedup | Stable |
| Final-URL dedup (mark, reference, skip) | Stable |
| Deterministic source quality metadata | Stable |
| Compact evidence index | Stable |
| Query profiles (official-docs, github-repo, security-research) | Stable |
| Research mode preset | Stable |
| Claude Code skills/rules/bootstrap | Stable |
| CI gate (deterministic, network-free) | Stable |

## Failure mode: technically valid but low-usefulness evidence

**Dogfood finding (MVP-1P):** Real-world queries often produce evidence that passes all mechanical checks (fetch succeeded, extraction produced text, quality score assigned) but is low-usefulness for the actual research question.

Example: A query about "building AI coding-agent operating systems" returns successful fetches from official docs pages, but the pages are tangential (general tool-use docs, unrelated product pages) rather than directly relevant.

Root cause: The pipeline measures **fetch/extraction success**, not **source usefulness** or **research relevance**. There is no signal about whether a candidate URL is likely to answer the user's question before fetch, and no signal about whether the fetched content actually addresses the question after extraction.

This is the central gap between search and research.

## Non-goals

- LLM-based relevance scoring or synthesis
- WebSearch/WebFetch integration
- Browser rendering or JavaScript execution
- Database storage, SQLite, or persistent state
- MCP server or agent framework
- Frontend, dashboard, or API server
- Crawl4AI, Repomix, or SearXNG as required runtime dependency

## Staged roadmap

### MVP-1P.1 — Discovery diagnostics artifact

Produce a structured diagnostics artifact alongside evidence that records what the discovery layer returned, what was fetched, and what was skipped. This gives the caller (Claude Code agent) enough signal to decide whether to run a second pass with different candidates.

No relevance scoring. No LLM. Pure mechanical accounting of what happened at each pipeline stage.

### MVP-1Q — Deterministic relevance scoring

Add a deterministic (non-LLM) relevance signal: keyword overlap between query terms and extracted content, section heading matching, URL path relevance. This is a heuristic score, not AI ranking.

Does not change fetch or extraction behavior. Adds metadata only.

### MVP-1R — Research session skeleton

Support a research session that runs multiple search passes with different strategies (different providers, different candidate sets, different profiles) and accumulates evidence across passes.

Session state is a directory of evidence runs, not a database. No iterative refinement loop — the agent (Claude Code) drives the strategy.

### Later stages

- Iterative research waves: agent-driven query refinement based on evidence gaps
- Evidence ledger: append-only record of what was searched, what was found, what was rejected
- Evidence graph: cross-reference and citation tracking across sources
