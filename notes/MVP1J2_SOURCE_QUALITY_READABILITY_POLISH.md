# MVP-1J.2 — Source quality and evidence readability polish

**Date:** 2026-05-16
**Baseline SHA:** 9a12291c40b767dae0ec3556d9fc4d88f5421780
**New SHA:** pending commit

---

## 1. Baseline

- HEAD == origin/main == 9a12291c40b767dae0ec3556d9fc4d88f5421780
- 637/637 tests pass
- Dogfood identified 4 frictions: null titles, underclassified vendor blogs, redirect loops, nav chrome

## 2. Changes

### 2.1 Title fix (cli.py)

**Problem:** `evidence_results[].title` was hardcoded `None` in JSON output. Evidence pack frontmatter had titles from `<title>` tag extraction but they were never surfaced.

**Fix:** `_print_search_result_json` now reads the title from evidence pack YAML frontmatter (`title:` field) as a fallback when discovery candidate title is absent. Discovery candidate title still takes precedence.

**Files:** `search_tool/cli.py` (+19 lines)

### 2.2 Source quality for vendor research blogs (source_quality.py)

**Problem:** Official vendor research/blog pages (anthropic.com/research, openai.com/index, developers.googleblog.com) classified as `unknown` authority 1/3.

**Fix:** Added two new domain sets:
- `_PRIMARY_BLOG_DOMAINS`: anthropic.com, openai.com → `blog`, authority 3/3, `is_official=True`, `is_primary_source=True`
- `_PRIMARY_DEV_BLOG_DOMAINS`: developers.googleblog.com → `blog`, authority 3/3, `is_official=True`, `is_primary_source=True`

**Files:** `search_tool/source_quality.py` (+27 lines)

### 2.3 Trailing-slash redirect fix (fetch.py)

**Problem:** URLs without trailing slash (e.g., `https://openai.github.io/openai-agents-python`) got 301 → with-trailing-slash, but `normalize_url` stripped the trailing slash for the visited-set check, causing a false "redirect loop detected".

**Fix:**
- Added `_redirect_safe_url()` — normalization that strips fragments (not sent over HTTP) but preserves trailing slashes for redirect loop detection
- Added `_redirect_key()` — uses `_redirect_safe_url` for the visited set
- Redirect targets now use `_redirect_safe_url(resolved)` instead of `normalize_url(resolved)` for `current_url`

**Result:** Both `openai.github.io` and `developers.googleblog.com` URLs now succeed with `--follow-redirects`.

**Files:** `search_tool/fetch.py` (+32 lines, -7 lines)

### 2.4 Nav chrome reduction (compact.py)

**Problem:** Compact summary snippets polluted with nav lines ("Skip to main content", "Search...", "Navigation").

**Fix:** Added `_strip_nav_chrome()` function that strips common nav-only lines from the beginning of extracted text. Applied in `_extract_evidence_text()` before taking the first N chars.

**Files:** `search_tool/compact.py` (+43 lines)

## 3. Tests added/updated

| Test file | New tests | Description |
|-----------|-----------|-------------|
| `test_source_quality.py` | 5 | Vendor research/blog classification |
| `test_compact_summary.py` | 7 | Nav chrome stripping |
| `test_search_json.py` | 2 | Title from evidence pack frontmatter |
| `test_fetch.py` | 2 | Trailing-slash redirect not-loop |

**Total:** 653 passed (637 + 16 new)

## 4. Known limitations

- `_strip_nav_chrome` only strips nav lines from the **beginning** of text. Mid-content nav chrome is not removed.
- `_redirect_safe_url` is only used for redirect resolution, not for cache keying (which uses `normalize_url`). This is intentional to avoid cache breaks.
- No title extraction improvement for pages without `<title>` tags or YAML frontmatter `title:` field.

## 5. What was deferred

- None. All 4 identified frictions were addressed.

## 6. Verification

- `python -m pytest tests/ -v`: 653 passed
- `python -m py_compile search_tool/*.py`: OK
- `git diff --check`: no whitespace errors
- `eval-corpus`: 11/11 passed
- No dependencies added
- No pyproject.toml changes
- No WebSearch/WebFetch
- No generated artifacts
