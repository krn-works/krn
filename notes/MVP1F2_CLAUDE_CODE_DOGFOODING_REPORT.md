# MVP-1F.2 Claude Code Dogfooding Report

## Baseline

**Commit:** `03017432ad74b591ff1da0b5e64a11a20c182dbe`
**Branch:** main
**Working tree:** clean
**Tests:** 447/447 passed
**Eval-corpus:** 11/11 passed

## Goal

Dogfood krn-search from the perspective of a Claude Code user. Determine whether the tool is useful as a local research/ingestion primitive before building Claude Code skills/rules/hooks around it.

## Commands run

```bash
# Scenario A — static docs fetch
python -m search_tool search-query "python http.server security docs" \
  --provider static \
  --candidate-url "https://docs.python.org/3/library/http.server.html" \
  --max-candidates 1 --follow-redirects

# Scenario B — live SearXNG query
python -m search_tool search-query "Claude Code hooks skills best practices" \
  --provider searxng \
  --searxng-url "http://localhost:9999" \
  --max-candidates 5 --follow-redirects

# Scenario C — local UI manual test
python -m search_tool ui --work-dir .local/krn-search-ui --port 8765
# Tested with query: "best mcp servers 2026" via SearXNG

# Scenario D — failure honesty
python -m search_tool search-query "failure honesty test" \
  --provider static \
  --candidate-url "https://example.com" \
  --candidate-url "http://localhost/" \
  --candidate-url "file:///etc/passwd" \
  --max-candidates 10
```

## Scenario A — static docs fetch

| Metric | Value |
|---|---|
| Discovery candidates | 1 |
| Selected | 1 |
| Blocked | 0 |
| Evidence packs | 1 |
| Extraction status | success |
| Text chars extracted | 22,228 |
| Evidence lines | 1,678 |
| Quality | 3/3 |
| Cache | miss |
| Followed redirects | 0 |

**Evidence usefulness:** The full Python http.server documentation was extracted as clean Markdown with frontmatter metadata. Sufficient to answer "Is Python http.server production-safe?" — the docs explicitly warn against it for production use. The evidence pack includes HTTP status, content length, body SHA-256, extraction method, and security policy result.

**Manifest quality:** Both fetch-list manifest and search-run manifest are well-structured. The search-run manifest includes query redaction, provider config, discovery summary, and links to the fetch-list manifest. The "Blocked Candidates" section is present but empty (correctly).

**CLI output:** Clear one-line-per-URL format with status, cache, quality, and evidence path. Manifest paths printed at the end. Usable for scripting.

## Scenario B — live SearXNG query

| Metric | Value |
|---|---|
| Discovery candidates | 5 (capped from 32) |
| Selected | 5 |
| Blocked | 0 |
| Evidence packs written | 5 (3 success, 1 skipped PDF, 2 failed) |
| Extracted successfully | 2 |
| Failed | 2 (Reddit 301, Medium 403) |
| Skipped | 1 (PDF — extraction not supported) |

**Top 5 URLs discovered:**
1. `https://code.claude.com/docs/en/best-practices` — success, 3/3
2. `https://www.reddit.com/r/ClaudeAI/comments/1rxu41b/...` — failed (301 redirect not followed despite `--follow-redirects`)
3. `https://code.claude.com/docs/en/hooks-guide` — success, 3/3
4. `https://resources.anthropic.com/hubfs/...Skill-for-Claude.pdf` — skipped (PDF, extraction N/A)
5. `https://medium.com/@sabita2025/...` — failed (403 Cloudflare)

**Evidence quality:** The two official docs (code.claude.com) produced excellent evidence packs — 32KB and 42KB of clean Markdown. Sufficient to answer the query about Claude Code hooks and skills best practices.

**Audit trail:** Search-run manifest shows query SHA-256, redacted query, provider config (with SearXNG URL redacted), candidate count, cap notice ("Capped candidates from 32 to 5"), and per-URL status. Fetch-list manifest shows cache stats and per-pack quality.

**Leakage check:** No SearXNG API keys, credentials, or secrets in any manifest. Provider URL appears only as `http://localhost:9999` (redacted field). The safety notice about untrusted content is present in all manifests.

**Issue — Reddit 301 not followed:** Reddit returned a 301 redirect even with `--follow-redirects` enabled. The redirect target was the same URL with a trailing slash. This may be a trailing-slash normalization issue in the redirect-following logic.

**Issue — PDF extraction:** PDFs are downloaded (561KB) but extraction is skipped. The evidence pack records `extraction.status: "skipped"` and `extraction.method: "none"`. This is expected behavior but wastes bandwidth. A content-type pre-check before download would save the fetch.

## Scenario C — local UI manual test

Tested query: "best mcp servers 2026" via SearXNG, `follow_redirects` OFF.

**Discovery summary:** Clear — "10 candidates found, 10 selected, 0 blocked, 0 duplicates, 0 errors". Immediately understandable.

**Ingestion summary:** Useful breakdown — "6 extracted, 0 truncated, 3 redirects not followed, 1 failed, 0 blocked, 3 skipped". The redirect notice ("Enable Follow Redirects to fetch final pages") is helpful.

**Artifact links:** Fetch List Manifest and Search Run Manifest links are present and clickable.

**URL table:** Shows URL, STATUS, QUAL, and ACTION (VIEW) for each result. STATUS column is clear. QUAL column shows `undefined/3` — **bug** (see below).

**Raw JSON viewer:** Available and useful for debugging.

**Issues found:**
1. **QUAL column shows `undefined/3`** — The `EvidenceWriteResult` dataclass in `search.py` does not have a `quality_score` field. The UI template at `ui.py:327` references `r.quality_score` which is undefined after `asdict()` serialization. The `_quality_score()` helper function exists in `search.py` but is never called during API response construction.
2. **No follow-redirects ON test performed** — User tested only with redirects OFF.

**UI trustworthiness:** The UI feels functional enough for manual QA. The ASCII art banner, clear warnings, and structured output are reassuring. The `undefined/3` bug reduces trust in the quality column but does not affect the actual data.

## Scenario D — failure honesty

| Input URL | Outcome | Reason |
|---|---|---|
| `https://example.com` | success | 3/3 quality |
| `http://localhost/` | **blocked** | hostname is localhost or loopback alias |
| `file:///etc/passwd` | **blocked** | scheme not allowed: 'file' |

**Blocked URL visibility:** Both blocked URLs appear in the search-run manifest under "Blocked Candidates" table with explicit reasons. The fetch-list manifest only shows the 1 fetched URL (correct — blocked URLs were never sent to the fetch pipeline).

**Content verification:** Only `example.com` content was written to disk. No `/etc/passwd` content leaked. The blocked URLs appear in the manifest only as metadata entries, not as fetched content.

**Manifest honesty:** The manifests accurately report: candidates_total=3, selected_for_fetch=1, blocked=2. The fetch summary shows requested=1, succeeded=1, failed=0. No dishonest inflation of success counts.

## Evidence usefulness

**Verdict: useful as a Claude Code ingestion primitive.**

- A single evidence pack provides enough content to answer most factual questions about a page.
- Frontmatter metadata (HTTP status, content type, SHA-256, extraction method) is sufficient for provenance.
- Safety notice on every manifest is a good trust signal.
- The quality score (3/3) on the CLI output is a quick signal for confidence.
- Failed/redirect evidence packs honestly record what happened — useful for debugging.

**Limitations:**
- PDF content is downloaded but not extracted (wasted bandwidth, no value).
- SPA/JS-heavy sites produce low-value evidence (known limitation).
- Reddit-style redirects with trailing slashes may not be followed even with `--follow-redirects`.

## UI usefulness

**Verdict: functional for manual QA, not ready as a daily driver.**

The UI is adequate for inspecting search runs manually. The discovery/ingestion summaries and artifact links work. However, the `undefined/3` quality bug and the lack of a follow-redirects toggle comparison limit its usefulness for evaluation.

**What works:**
- ASCII art banner with LOCAL-ONLY DEV UI warning
- Provider selection (static vs searxng)
- SearXNG URL field with port hint
- REFRESH and FOLLOW_REDIRECTS toggles
- Discovery and ingestion summaries
- Per-URL status table with VIEW action
- Artifact links to manifests
- Raw JSON viewer

**What needs fixing:**
- QUAL column renders `undefined/3` — highest priority UI bug
- No visual distinction between SUCCESS and FAILED rows in the table
- EVAL and ARTIFACTS tabs not tested in this session

## Artifact usefulness

**Verdict: strong.**

The three-layer artifact structure (search-run manifest → fetch-list manifest → evidence packs) provides a clear audit trail. Each layer links to the next. The manifests are human-readable Markdown with YAML frontmatter for machine parsing.

The search-run manifest is the most valuable artifact for Claude Code integration — it summarizes the entire run in one file.

## Security/failure honesty findings

1. **URL policy enforcement works correctly.** `file://`, `localhost`, private IPs, and credentials are blocked before fetch.
2. **Blocked URLs are visible in manifests** with explicit reasons. No silent filtering.
3. **Failed fetches produce honest evidence packs** recording HTTP status, error type, and cache outcome.
4. **No content leakage** — blocked URLs never reach the fetch pipeline.
5. **No credential leakage** in manifests — SearXNG URL is redacted, no API keys appear.
6. **Safety notice** is present on every manifest.
7. **Query redaction** is applied — SHA-256 hash of original query stored alongside redacted version.

## What felt good

- CLI output is clean and scriptable. One-line-per-URL format with status, cache, quality, and path.
- `search-query` composition (discover + fetch + manifest) in one command is convenient.
- Evidence packs are self-contained — one file per URL with full metadata.
- Manifests link to each other — navigation is natural.
- The `--provider static` mode is useful for deterministic testing and manual ingestion of known URLs.
- Security decisions are transparent — blocked URLs and their reasons are always visible.

## What broke or confused the user

1. **`--work-dir` flag not available on `search-query`.** The task assumed it existed. Had to `cd` to a temp directory and set `PYTHONPATH` instead.
2. **Reddit 301 redirect not followed** despite `--follow-redirects`. Likely a trailing-slash normalization edge case.
3. **QUAL column shows `undefined/3` in UI.** Reduces trust in quality reporting.
4. **PDFs downloaded but not extracted.** Wastes bandwidth with no value.
5. **UI `follow_redirects` ON test not performed.** User only tested with OFF.

## Smallest next fixes

1. **Fix QUAL column in UI** — Add quality_score to API response for each evidence result. Use existing `_quality_score()` helper in `search.py`. ~5 lines of code.
2. **Add `--work-dir` to `search-query` CLI** — Already exists on `eval-corpus` and `ui`. Consistency gap.
3. **Content-type pre-check for non-HTML** — Skip download if content-type is PDF, image, video, etc. Save bandwidth.
4. **Investigate Reddit trailing-slash redirect** — May be a normalization issue in redirect following.

## Should we create Claude Code skills/rules now?

**Yes.** The tool is useful as a local ingestion primitive. The CLI contract is stable, evidence packs are well-structured, and manifests provide a clear audit trail. A Claude Code skill that wraps `search-query` with SearXNG and produces evidence packs for the agent to read would add immediate value.

**Recommended skill scope:**
- `search-query` wrapper with SearXNG provider
- Evidence pack reading (parse frontmatter, extract text)
- Manifest inspection (parse search-run manifest, fetch-list manifest)
- No synthesis — the agent reads evidence packs directly

## Should we create WebSearch-prevention hooks now?

**No.** WebSearch is a different capability (general web search for the model). krn-search is a local ingestion primitive. They serve different purposes. A hook that prevents WebSearch would be premature — the workflow should first prove that krn-search is a comfortable replacement for the WebSearch use case.

**Keep as later opt-in** after dogfooding proves the skill-based workflow is comfortable.

## Final recommendation

1. **Create Claude Code skills/rules next.** The tool is ready for integration.
2. **Do not create WebSearch prevention hook yet.** Premature — workflow comfort unproven.
3. **Fix QUAL column bug** before UI becomes a daily driver.
4. **Keep hook idea** as opt-in after skills prove the workflow.
5. **PDF pre-check** is a nice-to-have, not blocking.
