# MVP-1N.1 — Release / Docs Summary: Portable Research Kit

**Date:** 2026-05-19
**Phase:** MVP-1N
**Task:** MVP-1N.1 — Release/docs summary
**Status:** Complete

## Baseline

- **SHA:** b06f6ca69cbd02ef9a88b8e2ff135c189d85401c
- **Tests:** 890/890 pass
- **Eval-corpus:** 11/11 pass
- **Compile:** OK
- **Whitespace:** OK
- **Working tree:** clean (docs-only diff)

## What this covers

This summary documents the completed improvements to the portable research kit since the MVP-1H research workflow:

### 1. Portable kit — `init-claude` bootstrap command

`krn-search init-claude` copies `.claude/` artifacts (skill, slash command, optional hook) into a target repository using `importlib.resources` from the packaged distribution. No hook auto-activation. Fresh install dogfood passed (pipx/uv tool, non-editable mode).

- `krn-search init-claude [--target-dir PATH] [--dry-run] [--force] [--with-hook]`
- Template files packaged via `[tool.setuptools.package-data]`
- 24 tests, 10 fresh-install scenarios, 680/6680 full suite

### 2. llms.txt discovery provider

`--provider llms` discovers candidate URLs from a user-supplied llms.txt file at a given URL.

- Lightweight markdown parser (stdlib only) — supports `-` and `*` bullets, named URLs, raw URLs, relative URL resolution, fenced code block filtering
- Deterministic keyword scoring (title > section > URL)
- URL policy enforcement on all discovered URLs
- Three CLI aliases: `--url`, `--llms-url`, `--docs-index-url`
- `--follow-redirects` for the llms.txt source fetch
- `llms-docs` query profile
- Parser warnings surfaced in JSON `limitations` with `llms parser warning:` prefix
- Real-world dogfood accepted (Pydantic, Claude Code — useful; FastAPI — honest 404; GitHub Docs — fixed `*` bullet parsing)
- 88 new tests (40 parser + 48 provider)

### 3. Candidate-level canonical URL dedup

`search_tool/canonical.py` with `canonicalize_url_for_dedup()` — stricter normalization than `normalize_url()`:

- Strips fragments
- Removes tracking params (`utm_*`, `fbclid`, `gclid`, `msclkid`, `mc_cid`, `mc_eid`, `igshid`)
- Preserves meaningful params (`ref`, `source`, `via`)
- Collapses duplicate slashes, sorts retained query params
- First occurrence wins; collapsed count reported in `limitations`
- 45 tests covering all canonicalization rules

### 4. Final URL dedup — visibility, metadata, skip

Staged implementation across MVP-1M.4 through MVP-1M.7:

**MVP-1M.4 — Mark-only visibility**
- `final_url: str | None` added to `EvidenceWriteResult`
- Post-fetch dedup registry in `search_query()` using `canonicalize_url_for_dedup()`
- Collapsed count reported in `SearchRunResult.limitations`

**MVP-1M.6 — Duplicate reference metadata**
- `dedup_status: str` — `"unique"` or `"duplicate_final_url"`
- `duplicate_of_url: str | None` — canonicalized final_url of kept result
- `duplicate_of_evidence_path: Path | None` — kept evidence path

**MVP-1M.7 — Skip extraction**
- Pre-extraction dedup check via `_final_url_dedup_registry`
- Synthetic `skipped_duplicate` result (fetch_status, no evidence pack written)
- Evidence path points to the kept result's evidence pack
- Limitation wording: "Skipped N duplicates by final_url"
- JSON status: `succeeded + skipped == total` → `"ok"`

**MVP-1M.7a — Non-redirect fallback bugfix**
- `final_url_override = normalized` set when `follow_redirects=True` and no redirects occurred

**MVP-1M.7b — Compact writer limitation dedup**
- Removed concatenation of `result.limitations` + `discovery.limitations` (doubled discovery limitations)

**MVP-1M.8 — Hygiene cleanup**
- Removed unused params from `_maybe_skip_duplicate()`
- Replaced unused `kept_idx` with `_`

### 5. Consistency across JSON, manifest, compact, eval

- `eval-corpus` gains `actual_skipped` and `skipped_duplicates` checks
- Compact summary reads `result.limitations` only (not duplicated from discovery)
- Manifests written before post-processing in search-query so "Skipped N" appears
- JSON status remains `"ok"` when success + skipped == total
- All changes backward compatible (additive fields with frozen dataclass defaults)

## What this is NOT

- Not a web search engine
- Not semantic/content hash dedup (URL-level only)
- Not cross-query dedup
- Not HTML canonical tag extraction
- Not web-scale crawling
- Does not require SearXNG or WebSearch

## Verified status

| Gate | Result |
|------|--------|
| Full test suite | 890/890 pass |
| Eval-corpus | 11/11 pass |
| Compile | OK |
| Whitespace | OK |
| Generated artifacts | None tracked |
| Dependencies | No changes |

## Files changed in this commit

- `notes/MVP1N1_RELEASE_SUMMARY.md` — this document (new)
- `notes/PROJECT_STATE.md` — updated to MVP-1N
- `notes/ACTIVE_TASK.md` — marked MVP-1N.1 complete
- `notes/EXPERIMENT_LOG.md` — entry for this task
