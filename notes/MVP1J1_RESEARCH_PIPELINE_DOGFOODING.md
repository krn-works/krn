# MVP-1J.1 Research Pipeline Dogfooding

**Date:** 2026-05-16
**Baseline SHA:** ba4ff8bbf072c8a5e9c2dd368ab42a5c620956e9
**Author:** Claude Code (agent-driven dogfooding)

---

## 1. Baseline

Repo clean, HEAD == origin/main == ba4ff8bbf072c8a5e9c2dd368ab42a5c620956e9.
637/637 tests pass. All source files compile. No whitespace errors.
Eval-corpus 11/11 passed.

## 2. Hook reality

- **Hook script present:** Yes, `.claude/hooks/websearch_krn_search_guard.py`.
- **Configured in committed `.claude/settings.json`:** No. The committed settings file does NOT reference the hook.
- **Configured in `.claude/settings.local.json`:** Yes. Local settings have:
  - `hooks.PreToolUse` matcher on `WebSearch|WebFetch` running `python .claude/hooks/websearch_krn_search_guard.py`
  - `permissions.allow: [WebSearch]` (hook still enforces deny via stderr/stdin)
- **If WebSearch attempted:** It is blocked by the PreToolUse hook. The hook reads tool selection from stdin, matches `WebSearch`/`WebFetch`, and returns `{"hookSpecificOutput": {"permissionDecision": "deny", "permissionDecisionReason": "..."}}`.
- **Recovery path shown to Claude:**
  > "WebSearch/WebFetch are disabled in this project. Use krn-search for all web research:
  >   krn-search search-query "<query>" --provider searxng --searxng-url <url> --follow-redirects
  >   krn-search search-query "<query>" --provider static --candidate-url <url> --follow-redirects
  >   krn-search fetch-url <url> --follow-redirects
  > Alternatively: /krn-search-research <question>
  > Do not retry WebSearch/WebFetch. If krn-search evidence is insufficient, report the limitation honestly."

## 3. SearXNG reality

- **Port 9999 (project default):** Not reachable. No container mapped to host:9999.
- **Port 8080:** SearXNG containers exist (multiple, shared supersearch environment) but JSON format is NOT configured. `/search?q=test&format=json` returns 404 with `{"error":{"message":"File Not Found","type":"not_found_error","code":404}}`.
- **Health check:** Reports `degraded`. SearXNG reachable at `http://127.0.0.1:8080` but `warn` status because JSON format unavailable.
- **Is SearXNG optional or blocking?** Optional. Static provider works without it. Degraded (no SearXNG) is not a blocker.

## 4. Special research question

**Query:** "Current best practices for building AI coding-agent operating systems in 2026: Claude Code hooks/skills, OpenAI Codex/agents, MCP/A2A, evals, guardrails, and repo governance."

**Rationale:** Hard enough to test real research. Needs current sources. Has official docs + blogs + GitHub docs. Exposes whether krn-search can discover useful sources or only SEO/blogspam. Directly relevant to krn-ai-os integration.

## 5. Attempt A — SearXNG research mode

**Result:** `error` status. 0 candidates, 1 discovery error: "connection error".

**Why:** SearXNG not reachable on configured URL `http://localhost:9999`. No evidence produced. Recovery message directs to check provider configuration or provide candidate URLs.

**Assessment:** Expected behavior — SearXNG is not configured locally with JSON format on the expected port. The error message is honest and actionable.

## 6. Attempt B — Static curated URLs

**Result:** `partial_success`. 6/8 succeeded with quality 3/3. 2 failed.

### Successful sources (quality 3/3):

| # | URL | Type | Authority | Official |
|---|-----|------|-----------|----------|
| 1 | `docs.anthropic.com/en/docs/claude-code/hooks` | official_docs | 3/3 | True |
| 2 | `docs.anthropic.com/en/docs/claude-code/skills` | official_docs | 3/3 | True |
| 3 | `docs.anthropic.com/en/docs/agents-and-tools/tool-use/overview` | official_docs | 3/3 | True |
| 4 | `docs.github.com/en/copilot/using-github-copilot/coding-agent` | official_docs | 3/3 | True |
| 5 | `www.anthropic.com/research/building-effective-agents` | unknown | 1/3 | False |
| 6 | `modelcontextprotocol.io/introduction` | unknown | 1/3 | False |

### Failed sources:

| URL | Reason |
|-----|--------|
| `openai.github.io/openai-agents-python/` | Redirect loop detected |
| `developers.googleblog.com/en/a2a-a-new-era-of-agent-interoperability/` | Redirect loop detected |

### Observations:

- Anthropic docs (hooks, skills, tool-use) fetched successfully with full content (~4MB hooks page, 128K chars extracted).
- GitHub Copilot cloud agent docs fetched and extracted cleanly.
- Anthropic research blog (`building-effective-agents`) fetched with good content (published Dec 19, 2024).
- MCP introduction page fetched but content truncated at nav chrome.
- OpenAI Agents Python and Google A2A blog both hit redirect loops — this is a `follow-redirects` issue. The `--research` flag enables `--follow-redirects` but the static provider may not be forwarding the flag correctly to the fetch layer for these specific URLs.
- All titles are `null` in the JSON output (title extraction from `<title>` tags not working for these pages). The evidence packs DO have titles (e.g., "Hooks reference - Claude Code Docs"), confirming extraction works in evidence pack but the API response's `title` field is null. This is a friction point in the compact summary — it shows "[no title]" for all entries.
- The compact summary's excerpt snippets contain lots of nav chrome (Search..., Navigation, etc.) which reduces signal-to-noise ratio.

## 7. Useful sources found

1. **Anthropic hooks doc** — best source for Claude Code hooks lifecycle, hook types, input/output, decision control.
2. **Anthropic skills doc** — best source for skill types, live change detection, skill file structure.
3. **Anthropic tool-use overview** — covers tools, tool use with prompt caching, server tools.
4. **Anthropic building-effective-agents blog** — practical advice from Anthropic's experience with dozens of teams. Published Dec 2024.
5. **GitHub Copilot cloud agent docs** — covers agent sessions, tracking, Jira/Slack integration.
6. **MCP introduction** — open-source standard for AI-app-to-external-systems connections.

## 8. Weak/bad sources

1. **modelcontextprotocol.io** — extracts nav chrome heavily; first 1000 chars of excerpt are all navigation. The actual content starts after the nav.
2. **Anthropic research blog** — classified as `unknown` type (authority 1/3) rather than `blog` or `research`. The `source_quality` heuristic doesn't recognize `anthropic.com` (non-docs subdomain) as anything special.
3. **OpenAI Agents Python** — redirect loop, no evidence. Would need a corrected URL (remove trailing slash or add `--follow-redirects` at static provider level).
4. **Google A2A blog** — redirect loop, no evidence. Same issue as OpenAI.

## 9. Evidence reading friction

1. **Title null in API response:** The `title` field is null for all evidence in the JSON output. Titles are present in evidence packs' YAML frontmatter but not surfaced in the compact summary table or API response. This forces the reader to open each evidence pack to learn what it is.
2. **Nav chrome in excerpts:** Extracted content includes site navigation ("Skip to main content", "Search...", "Navigation") which reduces the signal-to-noise ratio in compact summaries.
3. **No title in compact summary table:** Shows "[no title]" for every row, making it harder to prioritize reading order.
4. **Redirect loops not retried with corrected URL:** The static provider detects redirect loops but doesn't attempt URL normalization (trailing slash removal, www redirect). These are simple fixes the provider could apply.
5. **Evidence pack content not surfaced in compact summary beyond first 1000 chars:** The "Source Snippets" section truncates at 1000 chars, which for many docs pages is entirely nav chrome.

## 10. Ideal pipeline

### Fast path (SearXNG available with JSON)
```
/krn-search-research <query>
```
Or explicitly:
```bash
.venv/bin/python -m search_tool search-query "<query>" \
  --research --provider searxng --searxng-url http://localhost:9999
```

### Static fallback (no SearXNG or JSON disabled)
```bash
.venv/bin/python -m search_tool search-query "<query>" \
  --research --provider static \
  --candidate-url <url1> \
  --candidate-url <url2> \
  ...
```

### Evidence reading order
1. JSON output (status, discovery summary, recovery message)
2. Compact summary (`compact_summary_path`) — source table with quality scores
3. Search-run manifest — run scope, provider config, discovery summary
4. Fetch-list manifest — evidence pack paths, success/fail counts
5. Top evidence packs by quality score and profile preference match

### Source selection policy
- Official docs (docs subdomain) first
- Primary sources (company research blogs, official announcements) second
- Community blogs third (only when official docs are weak)
- Forum/social only as supporting signals, never primary evidence

### Failure policy
- 403/404/redirect loop/SPA extraction failures are limitations, not silent failures
- Report every failure with its specific reason
- Never pretend evidence is stronger than it is
- If all evidence fails, report "All N evidence packs failed"

### WebSearch policy
- WebSearch is not trusted/available
- PreToolUse hook blocks WebSearch/WebFetch locally
- If hook not active, manually avoid WebSearch/WebFetch
- Use krn-search first

### SearXNG policy
- Optional
- JSON format required (must include `json` in `search.formats` in `settings.yml`)
- Missing SearXNG is degraded, not blocker

### When to stop
- Enough primary evidence (3+ quality-3 official/primary sources covering the topic)
- Or evidence insufficient — report insufficiency explicitly

## 11. Recommended next changes

1. **Fix title extraction:** The `title` field in API/evidence_results is null. Evidence packs have titles in YAML frontmatter. Either populate `title` from the evidence pack frontmatter in the API response, or improve the `<title>` tag extraction in the fetch layer.
2. **Redirect normalization:** The static provider should strip trailing slashes and attempt redirects before declaring "redirect loop". Two of eight sources failed for this reason.
3. **Nav chrome reduction:** The extractor should try to skip common nav patterns (e.g., remove lines containing only "Search...", "Navigation", "Skip to main content") before recording excerpts.
4. **SearXNG discovery provider health check:** When SearXNG returns 404 for JSON, the health check should suggest checking `search.formats` configuration (already documented in notes, but could be more explicit).

## 12. Verdict

**The research pipeline works end-to-end with static provider.** 6/8 curated URLs produced quality-3 evidence packs from authoritative sources. The compact summary provides a useful source overview. Evidence reading order is well-defined.

**SearXNG discovery is currently non-functional** in this environment (no JSON format configured). This is expected — SearXNG is optional. The static fallback is a viable primary path when candidate URLs are known.

**Key friction:** Null titles in API response force opening evidence packs to identify content. Redirect loop failures on known-good URLs reduce confidence.

**Pipeline status: OPERATIONAL with known frictions.**
