# MVP-1E.6 Search Query Composition Design

## Baseline

`bffca046130c796e587e8540785b5551f9d9fc17` — docs: evaluate discover-query cli

## Purpose

Design the composition layer that bridges `discover-query` output and `fetch-list` input into a single `search-query` command. This is docs/design only — no implementation.

The goal: one command that takes a query and produces evidence packs + manifest, without hiding failures, weakening URL policy, or creating schema drift.

## Current primitives

| Command | Input | Output | Artifact |
|---|---|---|---|
| `fetch-url <url>` | Single URL | Evidence pack path (stdout) | `.md` evidence pack |
| `fetch-list <urls.txt>` | URL file (one per line) | Per-URL TSV lines + manifest path | Individual `.md` packs + manifest `.md` |
| `discover-query <q>` | Query string | JSON DiscoveryResult (stdout) | No files |

Current two-step manual workflow:

```
krn-search discover-query "..." --provider searxng --searxng-url ... > discovery.json
# extract urls_for_fetch from JSON
echo "https://a.com\nhttps://b.com" > urls.txt
krn-search fetch-list urls.txt [--refresh] [--follow-redirects]
```

This works but requires manual JSON parsing and file plumbing. `search-query` automates the bridge.

## Design problem

How should `search-query` compose:

```
query -> discover-query / provider -> urls_for_fetch -> fetch-list -> evidence packs + manifest
```

Constraints:
- Must not hide failures (discover errors, fetch errors, blocked URLs)
- Must not weaken URL policy (all URLs through `check_url()`)
- Must not create schema drift (existing evidence/manifest schemas unchanged)
- Must not become a hidden synthesis engine
- Must not add dependencies
- Must remain testable with mocked HTTP (no live internet)

## Candidate architectures

### Architecture A: thin orchestration inside CLI.py

`search-query` logic lives as `_run_search_query()` directly in `search_tool/cli.py`, calling existing provider/fetch functions inline.

**Product value:** Moderate. Single command works. But cli.py already has 580+ lines — adding more inline composition makes it harder to read.

**Code complexity:** Low-to-moderate. No new files. But cli.py becomes a monolith — discover-query, fetch-url, fetch-list, and search-query all in one file with growing shared state.

**Testability:** Moderate. All logic is in cli.py which is already tested via `main()` CLI tests. Adding more `_run_*` functions means more CLI-level tests with tmp_path, monkeypatch, and capsys. No clean unit boundary.

**Failure honesty:** Good — can reuse existing exit-code conventions.

**stdout/stderr clarity:** Moderate. Mixing discover output with fetch output in one command complicates what goes to stdout.

**Artifact naming:** No new artifact type — just reuse manifest.

**Future krn-ai-os integration:** Poor. Composition logic embedded in CLI is harder to import programmatically.

**Risk of becoming a hidden synthesis engine:** Low — composition is thin and obvious in cli.py.

**Schema drift risk:** Low — no new schemas.

### Architecture B: separate composition module (`search_tool/search.py`)

`search_query()` function in a new `search_tool/search.py` module. CLI calls it via `_run_search_query()` in cli.py. The module owns the composition logic; the CLI owns the argparse surface.

**Product value:** High. Clean separation of concerns. Composition logic is testable independently. CLI stays thin.

**Code complexity:** Moderate. One new module (~50-80 lines). CLI adds a new subcommand and a thin runner. Clear module boundary.

**Testability:** High. `search_query()` can be unit-tested with mock providers and mock fetcher. CLI tests cover argparse surface only. No need for full integration tests in every test class.

**Failure honesty:** Good — `search_query()` returns structured results; CLI maps to exit codes.

**stdout/stderr clarity:** High. Composition module produces a structured result; CLI decides what to print.

**Artifact naming:** New `SearchRunResult` dataclass in the module. No new file schemas.

**Future krn-ai-os integration:** Good. krn-ai-os can import `search_tool.search.search_query()` directly.

**Risk of becoming a hidden synthesis engine:** Low. Module is explicitly named "search" but contains only composition — no ranking, no filtering, no synthesis. Risk is manageable if we keep the module thin.

**Schema drift risk:** Low — new dataclass only for internal use, not persisted.

### Architecture C: keep manual two-step flow only

No `search-query` command. Users run `discover-query`, pipe `urls_for_fetch` to a file, then run `fetch-list`. Maybe a shell script or external script bridges them.

**Product value:** Low. Users must write their own glue script. The workflow is functional but awkward.

**Code complexity:** Zero. No new code. But users carry the complexity.

**Testability:** N/A — no new code to test. But the two-step workflow is already tested separately.

**Failure honesty:** Good — each step has its own honest error reporting.

**stdout/stderr clarity:** Good — each step has clear output. But the user must manually handle the bridge.

**Artifact naming:** No change.

**Future krn-ai-os integration:** Poor. krn-ai-os must implement its own composition.

**Risk of becoming a hidden synthesis engine:** Zero — no new code.

**Schema drift risk:** Zero — no new code.

## Recommended architecture

**Architecture B** — separate composition module `search_tool/search.py`.

Rationale:
- CLI.py is already 580+ lines. Adding composition logic there accelerates monolith growth.
- `search_query()` as a pure function returning a structured result is independently testable.
- The module boundary makes krn-ai-os integration straightforward (import the function).
- The module stays thin (~50-80 lines): one function, one result dataclass, calls existing `discovery` and `cli.fetch_url_to_evidence()`.
- No new dependencies. No new schemas for evidence packs or manifests.
- Framework creep risk is low — one function, not a class hierarchy or plugin system.

## CLI contract proposal

```
krn-search search-query "<query>" --provider static|searxng [provider options] [fetch options]
```

Provider options (align with discover-query):
- `--provider static|searxng` (required)
- `--candidate-url` (repeatable, static only)
- `--candidate-title` (repeatable, static only)
- `--candidate-snippet` (repeatable, static only)
- `--candidate-engine` (repeatable, static only)
- `--searxng-url` (required for searxng)
- `--language` (searxng)
- `--category` (repeatable, searxng)
- `--safesearch` (searxng, 0/1/2)
- `--timeout` (searxng, default 10.0)
- `--max-candidates` (default 10)

Fetch options (align with fetch-list):
- `--refresh` (default: false)
- `--follow-redirects` (default: false)

Deferred options (not in MVP-1E.7):
- `--output-dir` — defer. Use default `evidence/` directory.
- `--keep-discovery-json` — defer. Discovery JSON can be reconstructed from evidence + manifest if needed.
- `--save-discovery-json` — defer. Would write the intermediate DiscoveryResult JSON for debugging.

Rationale for deferral: these are nice-to-haves. The core value is "one command produces evidence packs." Output directory and discovery JSON persistence can be added later without breaking the CLI contract.

## Output contract proposal

**stdout:** The fetch-list TSV format (one line per URL: `url\tstatus\tcache\tquality\tpath`) followed by `Manifest:\t<path>`. This is identical to `fetch-list` output.

**Why not print discovery JSON?** Two reasons:
1. The primary output of `search-query` is evidence packs, not discovery metadata. The manifest already summarizes what happened.
2. Printing both discovery JSON and fetch TSV to stdout creates parsing ambiguity for downstream consumers.

**stderr:** Diagnostic messages for composition errors (e.g., provider returned zero URLs after filtering, all fetches failed).

**Decision: print per-stage summary to stderr, not stdout.** This keeps stdout machine-readable (TSV + manifest path) while giving the user visibility into what happened in each stage.

Example stderr output:
```
[discovery] searxng: 8 candidates, 6 selected, 1 blocked, 1 duplicate
[fetch] 6 URLs: 4 succeeded, 1 blocked, 1 failed
```

This is informational, not structured. It does not replace the manifest.

## File/artifact contract

### Option 1: minimal — no search-level artifact
- Individual evidence packs (existing schema)
- Fetch-list manifest (existing schema)
- No search-level artifact tying discovery to fetch

**Pros:** No new schema. Simplest.
**Cons:** No record of which query produced this manifest. No discovery metadata (provider, errors, blocked candidates) preserved alongside the evidence.

### Option 2: discovery JSON + evidence packs + manifest
- Discovery JSON file written to `evidence/discovery-<timestamp>-<sha12>.json`
- Individual evidence packs (existing schema)
- Fetch-list manifest (existing schema)

**Pros:** Discovery metadata is persisted. Audit trail is complete.
**Cons:** New artifact type. Discovery JSON is redundant with manifest if we add discovery metadata to the manifest.

### Option 3: discovery JSON + evidence packs + fetch manifest + search-run manifest
- Discovery JSON file
- Individual evidence packs (existing schema)
- Fetch-list manifest (existing schema)
- Search-run manifest (`evidence/search-<timestamp>-<sha12>.md`) tying discovery + fetch together

**Pros:** Complete audit trail. One artifact per search run. Discovery and fetch metadata linked.
**Cons:** New manifest schema. More files per invocation. More complex.

### Decision: start with Option 1, plan for Option 3

**MVP-1E.7 should implement Option 1.** The fetch-list manifest already records all evidence packs. Adding a discovery JSON file and search-run manifest before the basic composition works is premature.

**Option 3 is the right end-state** but should be deferred until after the basic composition is proven. The search-run manifest should include:
- Query metadata (original, normalized, redacted)
- Provider name and config (non-sensitive: provider name, max_candidates)
- Discovery summary (candidates_total, selected_for_fetch, blocked, duplicates, errors)
- Link to discovery JSON file (if saved)
- Link to fetch-list manifest
- Timestamp

This can be added in MVP-1E.8 or later without breaking the existing CLI contract.

## Exit-code policy

| Condition | Exit code | Rationale |
|---|---|---|
| CLI misuse (invalid args, empty query, missing required options) | 1 | User error — catchable before any work |
| Discovery succeeds, fetch succeeds (even partially) | 0 | Operational outcome — artifacts produced honestly |
| Discovery fails (provider error) but produces a DiscoveryResult | 0 | Consistent with discover-query exit-code policy |
| Discovery produces zero URLs after filtering | 0 | Honest empty result — manifest records what happened |
| All fetches fail/blocked | 0 | Honest failure — each evidence pack records the failure |
| Fetch-list produces a manifest | 0 | Artifact exists — even if all packs are failure packs |

**Rationale:** `search-query` inherits the exit-code convention from both `discover-query` and `fetch-list`. CLI misuse exits 1. All operational outcomes (including total failure) exit 0 with honest artifacts. The manifest and evidence packs are the authoritative record of what happened.

This is consistent with the existing contract: expected fetch failures (404, DNS error, blocked URL) always exit 0 with a failure evidence pack. `search-query` extends this to the discovery phase.

## Failure honesty model

| Failure mode | Behavior | Artifact produced |
|---|---|---|
| Discovery provider returns errors + zero URLs | Exit 0, manifest with 0 succeeded, errors in stderr | Manifest (empty evidence table) |
| Discovery provider returns partial URLs + errors | Exit 0, fetch what's available, errors in stderr | Evidence packs for fetchable URLs + manifest |
| All discovered URLs blocked by URL policy | Exit 0, manifest with all blocked, errors in stderr | Blocked evidence packs + manifest |
| fetch-list input empty after filtering | Exit 0, empty manifest (consistent with fetch-list empty file handling) | Empty manifest |
| Some fetches fail / blocked | Exit 0, continue batch (consistent with fetch-list) | Mix of success/failure/blocked packs + manifest |
| All fetches fail | Exit 0, all failure packs, manifest records all failed | Failure packs + manifest |
| SearXNG 403 | Exit 0, no fetches attempted, error in stderr + manifest | Manifest with provider error |
| SearXNG timeout | Exit 0, no fetches attempted, error in stderr + manifest | Manifest with provider error |
| Redirect-blocked fetch | Exit 0, redirect-not-followed pack (consistent with fetch-url) | Evidence pack with redirect recorded |
| Duplicate discovered URLs | Dedup at discovery level (existing behavior) | Only first occurrence fetched |
| Invalid CLI input | Exit 1, error to stderr, no artifacts | None |

**Key principle:** `search-query` never silently discards information. Every failure at every stage is recorded either in the manifest, in an evidence pack, or in stderr. The user can always inspect the manifest to understand what happened.

## Security model

All existing security constraints apply. `search-query` adds no new trust boundaries.

| Constraint | How enforced |
|---|---|
| No provider output bypasses URL policy | All discovered URLs flow through `build_discovery_result()` → `check_url()`. Composition does not add its own URL filtering. |
| Fetch layer remains authority for evidence | `search-query` calls `fetch_url_to_evidence()` per URL, same as `fetch-list`. No shortcuts. |
| Discovery metadata is untrusted | Discovery JSON (if saved) is treated as data, not instructions. Titles/snippets are stored as metadata, never executed. |
| Evidence packs are data containers, not instructions | Unchanged. `search-query` produces the same evidence packs as `fetch-url`/`fetch-list`. |
| Query redaction is best-effort only | `redact_query()` applied at discovery stage. Documented as limitation in every DiscoveryResult. |
| SearXNG query privacy warning | `--searxng-url` required. No public default. Query forwarded to upstream engines via SearXNG instance. |
| No public SearXNG default | Same as discover-query. `--searxng-url` is required for searxng provider. |
| No live internet tests | All tests use mocked HTTP. No network calls in test suite. |
| No synthesis | `search-query` produces evidence packs and a manifest. No ranking, no filtering, no summarization of content. |
| No browser automation | Unchanged. Static HTML extraction only. |

## Test plan for implementation

### Unit tests for `search_tool/search.py`

1. **TestSearchQueryResult dataclass** — frozen, fields accessible
2. **TestSearchQuerySuccess** — mock provider returns 2 safe URLs, mock fetch succeeds, returns result with 2 evidence write results + manifest path
3. **TestSearchQueryProviderError** — mock provider returns DiscoveryResult with errors and zero URLs, returns empty result + manifest
4. **TestSearchQueryPartialFetch** — mock provider returns 3 URLs, one fetch fails, result has 2 success + 1 failed
5. **TestSearchQueryAllBlocked** — mock provider returns only blocked URLs, result has 0 evidence packs, manifest records all blocked
6. **TestSearchQueryEmptyAfterFiltering** — mock provider returns URLs that all fail URL policy, empty fetch list, manifest records 0 URLs
7. **TestSearchQueryFetchOptions** — verify `refresh` and `follow_redirects` passed through to fetch layer

### CLI tests for `search-query` subcommand

8. **TestSearchQueryCliBasic** — valid searxng invocation with mock, exits 0, manifest produced
9. **TestSearchQueryCliStatic** — valid static invocation, exits 0, manifest produced
10. **TestSearchQueryCliMissingQuery** — no query argument, exits 1
11. **TestSearchQueryCliMissingProvider** — no --provider, exits 1
12. **TestSearchQueryCliSearxngMissingUrl** — searxng without --searxng-url, exits 1
13. **TestSearchQueryCliStdout** — stdout format matches fetch-list TSV + manifest line
14. **TestSearchQueryCliStderr** — stderr contains discovery summary and fetch summary
15. **TestSearchQueryCliRefresh** — --refresh flag passed through
16. **TestSearchQueryCliFollowRedirects** — --follow-redirects flag passed through

All tests use mocked HTTP. No live internet.

Estimated: ~16 new tests.

## Non-goals

- No synthesis (ranking, filtering, summarization of fetched content)
- No query cache
- No retry logic for transient provider failures
- No new dependencies
- No pyproject.toml changes
- No browser automation
- No MCP server or hooks
- No database or SQLite storage
- No search-run manifest in MVP-1E.7 (deferred)
- No discovery JSON file persistence in MVP-1E.7 (deferred)
- No `--output-dir` option in MVP-1E.7 (deferred)
- No `--save-discovery-json` option in MVP-1E.7 (deferred)
- No framework abstractions (plugin registry, middleware chain)
- No changes to existing evidence pack schema
- No changes to existing manifest schema

## Decision

**RECOMMEND_ARCHITECTURE_B** — implement `search-query` as a thin composition in `search_tool/search.py`, wired to CLI via `_run_search_query()` in `search_tool/cli.py`.

MVP-1E.7 scope:
- New module `search_tool/search.py` with `SearchRunResult` dataclass and `search_query()` function
- New CLI subcommand `search-query` in `cli.py`
- Artifacts: individual evidence packs + fetch-list manifest only (Option 1)
- Stdout: fetch-list TSV format + manifest path
- Stderr: per-stage summary lines (discovery count, fetch count)
- Exit codes: 0 for all operational outcomes, 1 for CLI misuse
- ~16 new tests
- No new dependencies, no schema changes, no pyproject.toml changes

## Next recommended task

MVP-1E.7 — implement `search-query` composition per this design. Scope:
1. Create `search_tool/search.py` with `SearchRunResult` and `search_query()`
2. Add `search-query` subcommand to `search_tool/cli.py`
3. Add ~16 tests covering unit and CLI surfaces
4. Update README.md with `search-query` documentation
5. Update project notes
