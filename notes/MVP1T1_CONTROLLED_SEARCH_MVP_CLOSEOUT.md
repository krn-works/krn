# MVP-1T.1 — Controlled Search MVP Closeout

**Date:** 2026-05-25  
**Status:** Accepted  
**Scope:** Docs-only closeout. No code changes, no runtime dogfood rerun.

## Final Decision

**`ACCEPT_CONTROLLED_SEARCH_MVP`**

The repository is good enough to use as a Claude Code `/search`-style evidence-pack tool for controlled web ingestion, with the important constraint that it produces evidence artifacts, not answers. Operators and agents must still inspect source quality, blocked pages, snippets, relevance, and limitations before making claims.

## Accepted Capabilities

- Controlled URL-to-evidence-pack ingestion with URL policy enforcement and untrusted-source handling.
- SearXNG-required research discovery for `search-query --research` when provider auto-resolution is used.
- No silent static fallback in research mode.
- Explicit known-URL static override via `--provider static --candidate-url`.
- Research health checks through `krn-search health --research`.
- Readiness polling through `krn-search health --research --wait <seconds>`.
- Session directories and deterministic session metadata.
- Session summaries with run history, unique sources, source snippets, relevance, overlap, statistics, and limitations.
- Real dogfood sessions through `provider=searxng`, without manual candidate URLs.

## Evidence

MVP-1T.0 completed the live controlled-search dogfood and accepted the decision `ACCEPT_CONTROLLED_SEARCH_DOGFOOD`.

The accepted dogfood covered three real research sessions:

| Session | Provider | Candidates | Evidence packs | Summary |
|---|---:|---:|---:|---|
| `t0 requests docs` | `searxng` | 10 | 9 | generated |
| `t0 package ambiguity` | `searxng` | 10 | 9 | generated |
| `t0 searxng runbook` | `searxng` | 10 | 8 | generated |

Additional accepted evidence:

- `health --research --wait 30` succeeded against reachable local SearXNG at `http://localhost:9999`.
- `health --research --json --wait 30` returned `overall: ok`.
- All three dogfood sessions resolved through `provider=searxng`.
- All three dogfood sessions selected 10 candidates for fetch.
- Evidence packs were generated without `--candidate-url`.
- Session summaries were generated and useful for source triage.
- Runtime baseline after MVP-1S.6/T.0 remains `1069/1069` tests and `11/11` eval-corpus.

## Known Limitations

- Source quality metadata is useful but noisy; some useful official/docs pages are not always classified as official.
- `403`, blocked, and JavaScript-heavy pages still occur during live ingestion.
- Official/docs bias can be improved, especially for documentation-oriented research.
- Broad ambiguous queries can pull mixed sources and require agent-side triage.
- SearXNG runtime remains environment-sensitive; the local runbook is known-good for this host path but can drift with Docker/image/config changes.
- `.tmp_searxng/` can become a root-owned local runtime artifact and must remain uncommitted. It may be hidden through `.git/info/exclude`.

## Non-Goals Preserved

- No native/public web fallback.
- No LLM-generated URL candidates.
- No browser automation, stealth browser tooling, or rendered-page extraction.
- No database or SQLite storage.
- No MCP requirement.
- No schema churn in this closeout.
- No AI synthesis or inference inside evidence generation.

## Claude Code `/search` Readiness

The tool is ready for controlled `/search`-style use when the operator accepts these rules:

- Use `krn-search search-query "<query>" --research` with reachable SearXNG for discovery.
- Use static provider only for exact known URLs.
- Treat generated artifacts as evidence containers, not final answers.
- Inspect snippets, relevance, source quality, blocked pages, and limitations before making factual claims.
- Keep generated `.local/` and host runtime artifacts untracked.

This is not a general search engine and should not be widened into one. The accepted value is controlled evidence acquisition with explicit provenance and honest failure reporting.

## Recommended Next Phase

**`STOP_AND_USE` first.**

Pause feature expansion and use the tool on real Claude Code tasks. Only implement source-quality or filtering improvements after concrete pain appears in real usage.

If real usage confirms the current T.0 pain points, the likely next development track is **MVP-1U — source quality and result filtering**, focused on docs/official-source bias and noisy-domain handling. Operator packaging/smoke scripts remain useful but should follow real operational friction, not precede it.

## Verification for This Slice

Required docs-only verification:

- `git diff --check`
- `git status --short --branch`
- `git ls-files --others --exclude-standard`

No full pytest, eval-corpus rerun, or runtime dogfood rerun is required for this docs-only closeout.

## Verdict

`ACCEPT_CONTROLLED_SEARCH_MVP`

MVP-1T closes the controlled-search MVP: the repository now has controlled ingestion, SearXNG-required research discovery, explicit known-URL override, readiness checks, sessions, summaries, snippets, relevance, run history, and accepted real dogfood proof through `provider=searxng`.
