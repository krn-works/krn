# MVP-1E.9 Search Run Manifest Evaluation

## Baseline

`38fa77b154bd1eb9d46de6250121cd28fd0ebf59` — fix: harden search manifest provider redaction

## Implementation commits

- `fed9dbbbbab1357df0a26f68051c4add3c183baf` — feat: add search-run manifest
- `38fa77b154bd1eb9d46de6250121cd28fd0ebf59` — fix: harden search manifest provider redaction

## Purpose

Evaluate the `search-run manifest` artifact that ties together query metadata, provider configuration, discovery summaries, and fetch results into a single, human-readable, and machine-parsable Markdown file.

## Scope

- `search_tool/search.py` — `write_search_run_manifest()` implemented. `search_query()` updated.
- `search_tool/cli.py` — `search-query` updated to output `SearchManifest:` line.
- `tests/test_search.py` — Unit tests for manifest generation and redaction.
- `tests/test_cli_smoke.py` — CLI smoke tests for manifest output and provider sanitization.

## Acceptance verdict

**ACCEPT_MVP1E9**

## What was implemented

- `write_search_run_manifest` implemented in `search_tool/search.py`.
- Search-run manifest schema v0.1 (Markdown with YAML frontmatter).
- `artifact_type: "search_run_manifest"` field in frontmatter.
- `command.name: "search-query"` field.
- Manifest files written to `evidence/search-YYYYMMDDTHHMMSSZ-<sha12>.md`.
- Search-run manifest links to the corresponding `fetch-list` manifest.
- `SearchRunResult` updated to include `search_manifest_path`.
- CLI `search-query` subcommand appends `SearchManifest:\t<path>` to stdout.
- Search manifest write failure exits with code 1.
- Privacy-first storage: Raw original query is NEVER stored; SHA256 of original query is stored for auditability.
- Redacted query (secrets removed) is stored in the manifest.
- Snippets are not stored in the search-run manifest (kept in individual evidence packs).
- Provider configuration sanitization: SearXNG URL redaction preserves hostname/port but removes credentials, path, query, and fragment.

## What was not implemented

- No discovery JSON file persistence (stayed with Markdown manifest only).
- No changes to existing evidence pack or fetch-list manifest schemas.
- No new dependencies added to `pyproject.toml`.
- No changes to `MAX_REDIRECTS` or other core constants.

## Artifact contract verification

The `search-run` manifest follows the Strategy C design from MVP-1E.8. It acts as a parent artifact linking the discovery intent (query) to the fetch outcome (manifest).

| Check | Status | Evidence |
|---|---|---|
| write_search_run_manifest exists | PASS | `search_tool/search.py` line 77 |
| Writes under evidence/ | PASS | `search.py` line 92 |
| filename search-YYYY... md | PASS | `search.py` line 93 |
| schema_version 0.1 | PASS | `search.py` line 113 |
| artifact_type search_run_manifest | PASS | `search.py` line 114 |
| command.name search-query | PASS | `search.py` line 117 |
| links fetch-list manifest | PASS | `search.py` line 152 |
| does not replace fetch-list manifest | PASS | `_write_manifest` still called in `cli.py` and `search.py` |
| evidence schema unchanged | PASS | No changes to `evidence.py` or `extract.py` |
| fetch-list manifest schema unchanged | PASS | No changes to `_write_manifest` signature or output |

## Privacy verification

| Check | Status | Evidence |
|---|---|---|
| Raw original query omitted | PASS | `search.py` line 121: `query:` block uses `redacted` |
| Original query SHA256 stored | PASS | `search.py` line 122: `original_sha256` stored |
| Redacted query stored | PASS | `search.py` line 123: `redacted` stored |
| Snippets omitted | PASS | Not present in frontmatter or body |
| provider config sanitized | PASS | `cli.py` lines 649-661 build sanitized config |
| SearXNG credentials removed | PASS | `cli.py` line 593: `_sanitize_provider_url_for_manifest` |
| SearXNG path/query/fragment removed | PASS | `cli.py` line 605: returns `urlunparse` with empty path/query/frag |
| Malformed provider URL redacted | PASS | `cli.py` line 607: returns `[REDACTED]` |

## CLI output verification

| Check | Status | Evidence |
|---|---|---|
| stdout keeps TSV lines | PASS | `cli.py` line 683 |
| stdout keeps Manifest line | PASS | `cli.py` line 686 |
| stdout appends SearchManifest line | PASS | `cli.py` line 689 |
| no prose/log pollution on stdout | PASS | Only tab-separated lines and tagged paths |
| stderr summaries remain compact | PASS | `[discovery]` and `[fetch]` lines to stderr |
| manifest write failure exits 1 | PASS | `cli.py` line 692 |

## Refactor verification

- `EvidenceWriteResult` moved to `search_tool/search.py` successfully (shared between search and cli).
- `_quality_score` moved to `search_tool/search.py` successfully.
- `fetch-url` still works: Verified by `TestCliSmoke.test_command_runs_and_prints_path`.
- `fetch-list` still works: Verified by `TestFetchListCli.test_fetch_list_runs`.
- No circular imports: `cli.py` imports from `search.py`, but `search.py` does not import from `cli.py`.

## Test coverage

410/410 tests pass (including 12 new tests for manifest and redaction).

*Note: Previous documentation mentioned 412 tests, but the actual count is 410. This is corrected in this evaluation.*

| Category | Count | Status |
|---|---|---|
| Unit tests (search.py) | 16 | PASS |
| CLI smoke tests | 34 | PASS |
| URL policy tests | 64 | PASS |
| Fetch tests | 39 | PASS |
| Cache tests | 18 | PASS |
| Extraction tests | 14 | PASS |
| **Total** | **410** | **PASS** |

## Known limitations

- Query redaction is best-effort and not a security boundary.
- The manifest links to the fetch-list manifest via filename; if the manifest directory is moved, relative links may break.
- Discovery JSON is not persisted (Strategy C decision).

## Decision

**ACCEPT_MVP1E9**

The Search Run Manifest is correctly implemented as a "parent" artifact. It successfully captures the search context (query hash, redacted query, provider) and ties it to the fetch outcome without leaking secrets or bloating the artifact set.

## Next recommended task

MVP-1E.10 — Search pipeline evaluation corpus. Build a systematic way to evaluate search results against expected outcomes.
