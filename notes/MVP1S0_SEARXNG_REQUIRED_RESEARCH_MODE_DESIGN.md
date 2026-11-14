# MVP-1S.0 - SearXNG-Required Research Mode Design

**Date:** 2026-05-24
**Status:** Design complete
**Scope:** Research-mode resilience and operator ergonomics. No code changes.

## Problem

MVP-1R.3 dogfood proved that `krn-search search-query ... --research`
works for session artifacts, but the default provider path is confusing when
local SearXNG is unavailable:

```text
--provider auto: no candidate URLs provided and SearXNG unreachable (SearXNG URL: http://localhost:9999)
```

The failure is acceptable because research-mode discovery is SearXNG-required.
The operator problem is that the failure does not make the product contract,
next check, or manual override boundary clear enough.

## Product Decision

Research mode discovery requires SearXNG. `provider=auto` under `--research`
must not mean "try any provider that might work." It means "resolve the
required SearXNG endpoint and fail clearly if it is not usable."

Static provider remains an explicit known-URL/manual/test override. It is not
the automatic fallback for research mode.

## Current Code Reality

- `--research` expands to `provider=auto`, JSON, compact summary,
  `official-docs` profile, `.local/krn-search-runs`, and follow redirects.
- `_resolve_auto_provider()` currently does this for both research and
  non-research callers:
  - if `--candidate-url` is present, switch to `provider=static`;
  - else probe `SEARXNG_URL` or `http://localhost:9999`;
  - if reachable, switch to `provider=searxng`;
  - else return a provider-resolution error.
- `krn-search health` already exists, but its human wording treats SearXNG as
  optional for the general tool: "optional, static provider works."
- `SearxngDiscoveryProvider` itself is failure-honest and returns structured
  discovery errors for connection, timeout, 403, 429, 5xx, malformed JSON, and
  invalid response shapes.

## Selected Behavior

### 1. When SearXNG Is Unreachable

`krn-search search-query "<query>" --research` must fail before query
execution, fetching, session metadata append, or search-run artifact creation.
The command exits non-zero and, because research mode forces JSON, writes a
structured error JSON to stdout plus concise operator text to stderr.

No fallback provider is used. No public web search, arbitrary public search,
LLM-generated candidate URLs, or static-provider fallback is attempted.

### 2. Research-Mode Preflight

`--research` should preflight the required SearXNG endpoint before running the
actual query when the effective discovery path is SearXNG-required.

The endpoint source order stays simple:

1. explicit `--searxng-url`;
2. `SEARXNG_URL`;
3. default `http://localhost:9999`.

The preflight should use existing `httpx` and the existing SearXNG health
pattern. No dependency, browser, MCP, or provider refactor is needed.

### 3. `provider=auto` Under `--research`

`provider=auto` behaves differently when research mode is active:

- `--research` with no explicit provider resolves only to SearXNG.
- `--research --provider auto` resolves only to SearXNG.
- `--research --candidate-url <url>` with no explicit provider must not switch
  to static. It should fail with guidance to use `--provider static`.
- Non-research `--provider auto --candidate-url <url>` can keep the current
  static shortcut for backward compatibility.

This makes `auto` context-aware without refactoring providers.

### 4. Manual Known-URL Override

The supported manual/test override is explicit:

```bash
krn-search search-query "<query>" --research \
  --provider static \
  --candidate-url "<known-url>"
```

This path keeps research-mode output ergonomics while making it clear that
discovery did not happen through SearXNG. It is allowed only because the
operator supplied exact candidate URLs. It is not a fallback and must not be
suggested as "find something else on the web."

### 5. Health Command

Do not add a separate `doctor` command in MVP-1S. Extend existing `health`
instead.

Recommended operator surface:

```bash
krn-search health --research
```

Optional useful extension:

```bash
krn-search health --research --searxng-url "http://localhost:9999"
```

General `krn-search health` may continue to report SearXNG as optional for the
general tool. `krn-search health --research` must treat SearXNG absence or
unreachability as failure because research-mode discovery requires it.

### 6. Config Exposure

Do not add a new config file in MVP-1S. Make the existing URL sources explicit
in help text, error text, and health output:

- `--searxng-url` for a single command;
- `SEARXNG_URL` for the operator/session environment;
- default `http://localhost:9999` for local development.

Error and health output should say which source was used.

## Proposed Operator UX

### Human Error Text

```text
error: research mode requires SearXNG discovery, but SearXNG is unreachable.
SearXNG URL: http://localhost:9999 (source: default)
No fallback provider was used. Static provider is only an explicit known-URL override.

Check SearXNG:
  SEARXNG_URL=http://localhost:9999 krn-search health --research

Configure and retry:
  export SEARXNG_URL=http://localhost:9999
  krn-search search-query "<query>" --research

Manual known-URL override:
  krn-search search-query "<query>" --research --provider static --candidate-url "<url>"
```

If the URL came from the environment:

```text
SearXNG URL: http://search.local:8080 (source: SEARXNG_URL)
```

If the URL came from `--searxng-url`:

```text
SearXNG URL: http://search.local:8080 (source: --searxng-url)
```

### JSON Error Shape

Keep the existing top-level error structure. Use exact wording in the existing
fields; do not introduce a new evidence schema.

```json
{
  "status": "error",
  "failures": [
    {
      "stage": "provider_resolution",
      "reason": "research mode requires SearXNG discovery, but SearXNG is unreachable at http://localhost:9999 (source: default). No fallback provider was used."
    }
  ],
  "limitations": [
    "Research-mode discovery did not run because required SearXNG was unreachable.",
    "No public web search, arbitrary public search, LLM-generated candidates, or static-provider fallback was used."
  ],
  "recovery": {
    "next_action": "Run `SEARXNG_URL=http://localhost:9999 krn-search health --research`, then configure SearXNG and retry. For known URLs only, use `--research --provider static --candidate-url <url>`.",
    "websearch_allowed": false
  },
  "research_mode": {
    "enabled": true
  }
}
```

### Candidate URL Without Explicit Static Provider

```text
error: --candidate-url does not activate static provider in research mode.
Research mode auto-discovery requires SearXNG. For known URLs, retry with:
  krn-search search-query "<query>" --research --provider static --candidate-url "<url>"
```

## Rejected Options

### Silent Static Fallback

Rejected. It violates the product decision and makes the operator believe
research discovery happened when the run actually used manually supplied URLs.

### Public Web Search Fallback

Rejected. It violates the repo contract and the no-WebSearch/no-WebFetch
operating model.

### Arbitrary Public Search Provider

Rejected. It weakens controlled ingestion and creates a new runtime trust
boundary.

### LLM-Generated Candidates

Rejected. It creates synthesis/inference inside candidate generation and
breaks the evidence-pack contract.

### New `doctor` Command

Rejected for MVP-1S. Existing `health` already owns runtime checks. Adding
`doctor` would duplicate CLI surface before a real need exists.

### New Config File

Rejected. `--searxng-url`, `SEARXNG_URL`, and the existing local default are
enough. The gap is visibility and enforcement, not configuration storage.

### Provider Refactor

Rejected for MVP-1S. The behavior can be implemented by making provider
resolution research-aware and by reusing the existing SearXNG probe.

## Deterministic Test Plan

All tests should be network-free. Patch `check_searxng_reachable()` or inject
`httpx.MockTransport`; do not require live SearXNG in CI.

### Research Mode Provider Resolution

- `--research` with no provider and unreachable SearXNG exits non-zero,
  emits JSON on stdout, sets failure stage `provider_resolution`, includes
  "research mode requires SearXNG", includes the effective URL and source, and
  keeps `recovery.websearch_allowed` false.
- `--research --provider auto` with unreachable SearXNG behaves the same.
- `--research --candidate-url <url>` with no explicit provider exits non-zero
  and says candidate URLs do not activate static provider in research mode.
- `--research --provider static --candidate-url <url>` still succeeds as the
  explicit known-URL override.
- Non-research `--provider auto --candidate-url <url>` remains unchanged and
  still resolves to static.
- Reachable SearXNG under `--research` resolves to `provider=searxng` and
  preserves the current research-mode JSON shape.

### Health

- `krn-search health` unchanged: default SearXNG unreachable can remain
  informational for the general tool.
- `krn-search health --research` with no reachable SearXNG returns non-zero
  and marks the SearXNG check as `fail`.
- `krn-search health --research` with reachable SearXNG returns zero.
- `krn-search health --research --json` includes the same status in JSON.
- If `--searxng-url` is added to `health`, tests prove CLI arg precedence over
  `SEARXNG_URL`.

### Error Wording

- Stderr includes the exact health command template.
- JSON `limitations` include "No public web search" and "No fallback provider".
- Error output does not mention WebSearch approval.
- Error output does not suggest `--provider static` without also requiring
  explicit `--candidate-url`.

### Artifact Hygiene

- Provider-resolution failure does not create run/session artifacts.
- Generated `.local` artifacts remain untracked in docs-only or test runs.

## Implementation Slices

### MVP-1S.1 - Research Provider Resolution and Error UX

- Add a research-aware branch around `_resolve_auto_provider()`.
- Preserve non-research `auto` behavior.
- Require explicit `--provider static` for known-URL research override.
- Add exact stderr and JSON wording.
- Add deterministic tests in `tests/test_research_mode.py` and
  `tests/test_search_json.py`.

### MVP-1S.2 - Research Health Check and Docs Sync

- Extend `krn-search health` with `--research`.
- Optionally add `--searxng-url` to `health`.
- Update health tests.
- Update Claude/Codex research surfaces and packaged templates so they stop
  saying SearXNG is optional for research discovery.
- Update `CLAUDE.md` only with scoped wording: SearXNG is not a global runtime
  dependency for all commands, but it is required for research-mode discovery.

## Risks

- Existing habit `--research --candidate-url <url>` without
  `--provider static` will break. This is intentional but needs a clear error
  and migration text.
- `provider=auto` becomes context-aware. Tests must lock non-research behavior
  so old scripts do not regress.
- Preflight can add one extra SearXNG request before the real query. Keep it
  small and reuse existing timeout behavior.
- Current docs/templates contain older wording that calls SearXNG optional.
  S.2 must sync those surfaces after the design is accepted.
- If SearXNG is reachable but misconfigured for JSON, the probe must preserve a
  useful diagnosis instead of collapsing everything into "unreachable."

## Reversibility

The design is reversible because it does not require schema, dependency, or
provider architecture changes. The behavior is isolated to CLI provider
resolution, error wording, health status interpretation, and documentation.

To revert, restore research-mode `auto` to the old generic branch where
`--candidate-url` switches to static and SearXNG absence is only one provider
resolution failure. No evidence packs or stored run artifacts require migration.

## Out of Scope

- New search providers.
- Native WebSearch/WebFetch fallback.
- Public web search fallback.
- LLM-generated URL candidates.
- AI synthesis or answer generation.
- Evidence schema changes.
- Search-run manifest schema changes.
- Session metadata schema changes.
- Database or SQLite storage.
- Browser automation.
- MCP server or agent framework.
- Provider ranking, retry orchestration, or broad provider refactor.
- Live SearXNG requirement in CI.
- Solving research completeness or next-query strategy.

## Verdict

`DESIGN_MVP1S0_SEARXNG_REQUIRED_RESEARCH_MODE`

Proceed to MVP-1S.1 only after design review approval.
