# MVP-1A Fetch-List Evaluation

## Baseline

**Commit:** `fb865d333405b98152e563e164d51624c85bf32b`
**Date:** 2026-05-08
**Tests:** 200/200 passed

## Commands run

```bash
git status --short
git rev-parse HEAD
git log --oneline -5
.venv/bin/python -m pytest tests/ -v

# Scenario A — Static docs happy path
.venv/bin/krn-search fetch-list tmp/mvp1a-static-docs.txt --refresh
.venv/bin/krn-search fetch-list tmp/mvp1a-static-docs.txt
.venv/bin/python -m search_tool fetch-list tmp/mvp1a-static-docs.txt

# Scenario B — Mixed outcome batch
.venv/bin/krn-search fetch-list tmp/mvp1a-mixed.txt --refresh
.venv/bin/krn-search fetch-list tmp/mvp1a-mixed.txt

# Scenario C — Markdown/manifest safety
.venv/bin/krn-search fetch-list tmp/mvp1a-safety.txt --refresh
.venv/bin/python -m search_tool fetch-list tmp/mvp1a-safety.txt
```

## Scenario A — Static docs happy path

**URL list:** 4 public documentation URLs (Python docs, httpx docs, pytest docs)

**Refresh run:**
- Exit code: 0
- All 4 URLs: status=success, cache=bypass, quality=3/3
- Manifest: `evidence/manifest-20260508T125424Z-dba5aef12324.md`

**Cached run:**
- Exit code: 0
- All 4 URLs: status=success, cache=hit, quality=3/3
- Manifest: `evidence/manifest-20260508T125431Z-dba5aef12324.md`

**python -m run:**
- Exit code: 0
- Identical output to cached run

**Extraction quality:**

| URL | text_chars | Status |
|-----|-----------|--------|
| docs.python.org/urllib.parse | 28,344 | success |
| docs.python.org/ipaddress | 34,384 | success |
| python-httpx.org/timeouts | 2,769 | success |
| docs.pytest.org/monkeypatch | 15,482 | success |

All 4 documentation sites produced substantial, useful extraction.

## Scenario B — Mixed outcome batch

**URL list:** example.com (success), file:///etc/passwd (blocked), 404 URL (failed), example.com (duplicate)

**Refresh run:**
- Exit code: 0
- example.com: success, bypass, 3/3
- file:///etc/passwd: blocked, not_written, 0/3
- example.com/definitely-missing-krn-search-lab: failed (HTTP 404), bypass, 0/3
- example.com (duplicate): success, bypass, 3/3
- Manifest: `evidence/manifest-20260508T125439Z-a4a9dcc2a443.md`

**Cached run:**
- example.com: success, hit, 3/3
- file:///etc/passwd: blocked, not_written, 0/3
- 404 URL: failed, not_written, 0/3
- example.com (duplicate): success, hit, 3/3
- Manifest: `evidence/manifest-20260508T125440Z-a4a9dcc2a443.md`

**Observations:**
- Duplicate preserved in manifest (rows 1 and 4 both show example.com)
- unique_urls: 3 (correct — 4 total, 1 duplicate)
- blocked: 1, failed: 1, succeeded: 2 (correct)
- Cache hit=2 on second run for the 2 successful URLs
- Batch continued through blocked and failed URLs

## Scenario C — Markdown/manifest safety

**URL list:** URLs containing `|`, `<script>`, `\`, `[brackets]`

**Refresh run:**
- Exit code: 0
- All 4 URLs: status=failed (example.com returns 404 for arbitrary paths), not_written, 0/3
- Manifest: `evidence/manifest-20260508T125446Z-4a2f649c1284.md`

**Manifest table inspection:**
```
| 1 | https://example.com/path\|with\|pipes | failed | not_written | 0/3 | ... |
| 2 | https://example.com/\<script\>alert(1)\</script\> | failed | not_written | 0/3 | ... |
| 3 | https://example.com/a\\b | failed | not_written | 0/3 | ... |
| 4 | https://example.com/[brackets] | failed | not_written | 0/3 | ... |
```

**Observations:**
- Pipes escaped as `\|` — table structure intact
- Angle brackets escaped as `\<` and `\>` — no raw HTML rendering
- Backslash escaped as `\\`
- Square brackets not escaped (no Markdown injection risk in table cell context)
- Table has correct 6 columns in every row

## Metrics

| Metric | Score | Notes |
|---|---|---|
| Scenario A — Manifest usefulness | 3/3 | Clear batch provenance, all 4 docs extracted well |
| Scenario B — Failure honesty | 3/3 | Blocked, 404, duplicate all recorded correctly |
| Scenario C — Markdown safety | 3/3 | Pipes, angle brackets, backslashes all escaped |
| Batch repeatability | 3/3 | bypass -> hit transition visible, deterministic output |
| Failure honesty | 3/3 | Every failure produces an evidence pack with errors |
| Manifest safety | 3/3 | Safety notice present, no raw content, table escaped |
| CLI ergonomics | 3/3 | Tab-separated stdout, both entry points work, --refresh |

## Manual inspection notes

- YAML frontmatter: `manifest_version`, `schema_version`, `input`, `results`, `cache` all present in all manifests
- `## Safety notice` section present in all manifests with full SAFETY_NOTICE text
- `## Evidence Packs` table present with 6 columns (#, URL, Status, Cache, Quality, Evidence)
- No raw source content appears in any manifest
- Manifest links point to existing evidence pack files
- Duplicate URL (Scenario B, rows 1 and 4) points to same evidence pack path
- Blocked URL shows `blocked` status, `not_written` cache, 0/3 quality
- Failed 404 URL shows `failed` status with error recorded in evidence pack
- Cache bypass -> hit transition clearly visible in frontmatter counts between refresh and cached runs
- Per-URL stdout is tab-separated: `url\tstatus\tcache\tquality\tpath`
- Final `Manifest:\tpath` line clearly separates per-URL output from manifest reference
- python -m entry point produces identical output to installed CLI

## Acceptance checklist

- [x] fetch-list command works through installed CLI
- [x] fetch-list command works through python -m
- [x] manifest is produced
- [x] individual evidence packs are produced
- [x] per-URL stdout is readable
- [x] manifest includes safety notice
- [x] manifest frontmatter has required sections (manifest_version, input, results, cache)
- [x] failures are honest
- [x] duplicates are preserved
- [x] cache behavior is visible
- [x] Markdown table safety holds (pipes, angle brackets, backslashes)
- [x] no source content is embedded in manifest
- [x] tests pass (200/200)

**Checklist: 13/13 passed**

## Decision

**ACCEPT_MVP1A**

All 13 acceptance criteria met. Fetch-list + manifest is useful, honest, repeatable, and ready to serve as the multi-source evidence primitive.

## Recommended next step

Decide between:
1. **MVP-1B:** Controlled redirect following (depth-limited, policy-checked)
2. **MVP-1A.3:** Manifest extraction/refactor (move manifest helper to `search_tool/manifest.py`)

Redirect following would recover content from sites that currently produce 3xx redirect packs (e.g., httpx.org redirected to unstoppabledomains.com in MVP-0 evaluation).
