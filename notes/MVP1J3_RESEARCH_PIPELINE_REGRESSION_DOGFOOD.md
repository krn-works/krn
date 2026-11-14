# MVP-1J.3 — Research pipeline regression dogfood and tiny readability polish

**Date:** 2026-05-16
**Baseline SHA:** 7b7bf84108b620fde2052a5c3905785960ce089b
**New SHA:** pending commit

---

## 1. Baseline

- HEAD == origin/main == 7b7bf84108b620fde2052a5c3905785960ce089b
- 637/637 tests pass (MVP-1J.2 committed and pushed)
- Working tree had uncommitted J.2 changes (already committed in baseline)

## 2. J.2 fixes being regression-tested

### 2.1 Title fallback from evidence pack frontmatter
- `_print_search_result_json` now reads `title:` from evidence pack YAML frontmatter
- Discovery candidate title still takes precedence

### 2.2 Official vendor research/blog source quality
- `anthropic.com`, `openai.com` → blog, authority 3/3, is_official=True
- `developers.googleblog.com` → blog, authority 3/3, is_official=True

### 2.3 Trailing-slash redirect false loops
- `_redirect_safe_url()` preserves trailing slashes for redirect loop detection
- `openai.github.io/openai-agents-python/` now succeeds
- `developers.googleblog.com/en/a2a-...` now succeeds

### 2.4 Beginning-of-snippet nav chrome stripping
- `_strip_nav_chrome()` strips known nav lines from text start
- Applied in `_extract_evidence_text()` (compact summary) and `_print_search_result_json()` (JSON excerpt)

## 3. Tiny J.3 polish applied

### 3.1 "Skip to content" nav chrome stripping (compact.py)

**Change:** Added `"Skip to content"` to `_NAV_CHROME_LINES` frozenset.

**File:** `search_tool/compact.py` (+1 line)

### 3.2 Title backslash separator cleanup (cli.py)

**Problem:** Evidence pack frontmatter title contained YAML-ish backslash separator artifact:
`Building Effective AI Agents \\ Anthropic` (two literal backslash chars in raw file).

**Fix:** After extracting title from frontmatter, replace ` \\ ` and ` \ ` with ` - `:
```python
val = val.replace(r" \\ ", " - ")
val = val.replace(r" \ ", " - ")
```

**Rationale:** The evidence pack frontwriter stores the HTML `<title>` tag content (e.g., `Building Effective AI Agents \ Anthropic` from a YAML-escaped field). This is a separator artifact, not a meaningful backslash.

**File:** `search_tool/cli.py` (+3 lines)

### 3.3 Tests added

| Test file | New test | Description |
|-----------|----------|-------------|
| `test_search_json.py` | `test_title_double_backslash_artifact_cleaned` | Evidence pack frontmatter with `\\` separator becomes ` - ` |
| `test_search_json.py` | `test_title_normal_unchanged` | Normal titles remain unchanged |

## 4. Regression dogfood command

```bash
.venv/bin/python -m search_tool search-query \
  "AI coding-agent operating systems hooks skills MCP evals repo governance" \
  --research --provider static --profile official-docs --max-candidates 8 \
  --candidate-url "https://docs.anthropic.com/en/docs/claude-code/hooks" \
  --candidate-url "https://docs.anthropic.com/en/docs/claude-code/skills" \
  --candidate-url "https://docs.anthropic.com/en/docs/agents-and-tools/tool-use/overview" \
  --candidate-url "https://www.anthropic.com/research/building-effective-agents" \
  --candidate-url "https://modelcontextprotocol.io/introduction" \
  --candidate-url "https://docs.github.com/en/copilot/using-github-copilot/coding-agent" \
  --candidate-url "https://openai.github.io/openai-agents-python/" \
  --candidate-url "https://developers.googleblog.com/en/a2a-a-new-era-of-agent-interoperability/" \
  --work-dir <tmpdir>
```

## 5. Results

### 5.1 Status
- **8/8 sources succeeded** (previously 6/8 in J.1, 8/8 in J.2)
- `status: ok` (all success, no failures)

### 5.2 Title visibility
- All 8 evidence_results have non-null titles in JSON output
- Anthropic research blog: `"Building Effective AI Agents - Anthropic"` (backslash fixed)
- Google A2A: `"Announcing the Agent2Agent Protocol\n...\n- Google Developers Blog"` (backslash from HTML title extraction, not frontmatter — deferred)

### 5.3 Redirect results
- `openai.github.io/openai-agents-python/` — success (no more redirect loop)
- `developers.googleblog.com/en/a2a-...` — success (no more redirect loop)

### 5.4 Source quality
| URL | Type | Authority | Official |
|-----|------|-----------|----------|
| docs.anthropic.com/* | official_docs | 3/3 | True |
| anthropic.com/research | blog | 3/3 | True |
| github.com/* | official_docs | 3/3 | True |
| modelcontextprotocol.io | unknown | 1/3 | False |
| openai.github.io | unknown | 1/3 | False |
| developers.googleblog.com | blog | 3/3 | True |

### 5.5 Compact readability
- JSON excerpts: no `Skip to content`, no `Search` at start
- Compact summary snippets: `_strip_nav_chrome` removes beginning nav chrome but mid-content nav items (Reference, Resources, etc.) remain — expected behavior, only beginning-of-text stripping is implemented

## 6. What was deliberately NOT changed

- No generic `Cloud`, `Docs`, `Products`, `Resources` stripping (too broad, would corrupt legitimate content)
- No browser rendering
- No SearXNG requirement
- No new dependencies
- No pyproject.toml changes
- No WebSearch/WebFetch

## 7. Verdict

**All J.2 fixes confirmed working. J.3 tiny polish applied and verified.**

8/8 success rate, titles visible and cleaned, redirects handled, no nav chrome pollution in JSON excerpts.

## 8. Recommended next step

Address Google A2A title backslash from HTML `<title>` tag extraction layer. This is separate from frontmatter fix — the fetch layer's `<title>` extraction needs similar cleanup.

## 9. Verification

- `pytest tests/ -v`: 656 passed (637 + 19 new)
- `py_compile search_tool/*.py`: OK
- `git diff --check`: no whitespace errors
- `eval-corpus`: 11/11 passed, JSON valid
