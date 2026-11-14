# MVP-1F.4 krn-search-research Skill Dogfooding

## Baseline

- Commit: `defce2e76c313d93fbbb98730e1634e39443d18d`
- Working tree: clean
- Tests: 450/450 pass
- Eval-corpus: 11/11 pass
- Compile check: clean
- Diff check: clean

## Goal

Test whether the `krn-search-research` skill and `/krn-search-research` slash command are usable in a real Claude Code workflow. Report-only unless a tiny docs-only correction is required.

## Skill availability

- `krn-search-research` appears in Claude Code's available skills list.
- Skill file at `.claude/skills/krn-search-research/SKILL.md` — 123 lines, well-structured.
- Skill is on-demand (loaded via Skill tool invocation or slash command), not auto-triggered.
- No `/skills reload` needed — skill is visible from session start.

## Slash command availability

- `/krn-search-research` is available as a project slash command.
- Command file at `.claude/commands/krn-search-research.md` — 11 lines.
- Command accepts `$ARGUMENTS` (the research question).
- Command delegates to the skill workflow (steps 1-7 in the command file).

## Scenario A — static docs question

**Query:** "Is Python http.server safe for production?"

**Provider:** static (obvious docs URL)
**URL:** `https://docs.python.org/3/library/http.server.html`

**Results:**
- Discovery: 1/1 candidate, 1/1 selected, 0 blocked, 0 errors
- Fetch: 1/1 success, quality 3/3, cache miss
- Evidence pack: 22K chars extracted, full Python docs page
- Answer found in evidence at line 117-119: "http.server is not recommended for production. It only implements basic security checks"

**Manifests inspected:**
- Search-run manifest: correct, redacted query visible, provider=static, 1 candidate
- Fetch-list manifest: correct, 1 row, success, 3/3 quality
- Evidence pack: full frontmatter with URL, status, SHA-256, safety notice

**Verdict:** PASS. Clean end-to-end flow. No friction.

## Scenario B — SearXNG research question

**Query:** "Claude Code hooks PreToolUse WebSearch WebFetch"

**Provider:** searxng (localhost:9999)
**SearXNG status:** running (HTTP 200)

**Results:**
- Discovery: 31 candidates found, capped to 5 (max-candidates=5), 5/5 selected, 0 blocked, 0 errors
- Fetch: 3/5 succeeded, 2/5 failed
- Succeeded evidence packs: 3/3 quality each
  - `code.claude.com/docs/en/hooks` — 117K chars, Claude Code hooks reference
  - `github.com/anthropics/claude-code/issues/27164` — PII scrubbing discussion
  - `wow.pjh.is/journal/claude-code-allow-webfetch-all-domains` — domain allowlisting
- Failed evidence packs:
  - `mikhail.io/2025/10/claude-code-web-tools` — redirect loop (http→https→http cycling)
  - `alicoding.github.io/claude-parser/anthropic/hook` — redirect loop (trailing slash)

**Manifests inspected:**
- Search-run manifest: correct, shows "Capped candidates from 31 to 5" in limitations
- Fetch-list manifest: correct, shows 3 success / 0 blocked / 2 failed, error count=2
- Failed evidence packs: correct failure metadata (http_status=301, error="redirect loop detected", extraction=skipped)

**Verdict:** PASS. Honest failure reporting. Limitation correctly surfaced.

## Evidence reading behavior

- Skill correctly teaches: read search-run manifest first, then fetch-list manifest, then evidence packs.
- Evidence packs have clear YAML frontmatter with all provenance fields.
- Quality scores are visible in both fetch-list manifest and individual packs (via extraction status).
- Discovery snippets (titles from SearXNG) are correctly NOT used as evidence — only evidence pack content is cited.
- Safety notice is present in every artifact.
- Source URLs are clearly cited in evidence packs.

## WebSearch fallback behavior

- No WebSearch fallback was triggered in either scenario — krn-search evidence was sufficient for both.
- The skill correctly documents when to fall back: insufficient evidence, no SearXNG, no candidate URLs, user request.
- The CLAUDE.md policy explicitly says: "If krn-search fails or evidence is insufficient, report the limitation and ask whether to fall back to WebSearch."
- No hook blocks WebSearch — this is intentional per design.

## Friction found

| # | Friction | Severity | Notes |
|---|----------|----------|-------|
| 1 | Skill requires explicit `/krn-search-research` invocation — does not auto-trigger on research questions | Low | Expected behavior for on-demand skill. Auto-trigger would need hook or more specific description. |
| 2 | `search-query` lacks `--work-dir` flag — evidence lands in `evidence/` relative to CWD | Low | Known limitation documented in skill (section 10). For Claude Code sessions, this is acceptable since `evidence/` is gitignored. |
| 3 | Evidence artifacts land in repo root `evidence/` directory, not in a temp dir | Low | `evidence/*.md` is in `.gitignore` with `!evidence/.gitkeep` exception. Safe but could be cleaner with `--work-dir`. |
| 4 | Command file (11 lines) duplicates decision logic from skill (33 lines in sections 3+6) | None | Command is intentionally a thin entry point. Duplication is minimal and serves different purpose (command = what to do, skill = how and why). |
| 5 | Redirect loop on mikhail.io and alicoding.github.io (trailing slash http/https cycling) | Low | Known limitation. `--follow-redirects` follows redirects but some servers create loops. The tool correctly reports "redirect loop detected". |
| 6 | SearXNG capped 31→5 candidates — user cannot see what was missed without re-running with higher `--max-candidates` | Low | By design. The cap prevents excessive fetching. |

## Bugs or contradictions found

| # | Issue | Severity | Details |
|---|-------|----------|---------|
| 1 | CLAUDE.md lists "SearXNG" as a hard non-goal, but the tool ships a SearXNG provider and the skill documents SearXNG usage | Medium | CLAUDE.md says: "Hard non-goals: SearXNG, Crawl4AI, Repomix". But `search_tool/discovery.py` contains `SearxngDiscoveryProvider`, and the skill documents `--provider searxng`. This is a docs contradiction. The hard non-goal likely referred to using SearXNG as the project's primary architecture (not the ingestion tool itself), but as written it's misleading. |

No code bugs found. All manifests, evidence packs, and CLI commands produced correct output.

## Smallest next fixes

1. **Fix CLAUDE.md SearXNG non-goal wording** — The hard non-goal should say "SearXNG as a search backend dependency" or "SearXNG as a required runtime dependency" to clarify that the tool supports SearXNG as an optional provider but doesn't depend on it. This is a docs-only one-line change.

## Hook readiness assessment

**Assessment: READY to proceed to hook design.**

Rationale:
- Skill workflow is comfortable and well-documented.
- Both scenarios (static and SearXNG) completed without code bugs.
- Manifests are easy to inspect and contain all needed information.
- Evidence reading order is clear (search-run → fetch-list → evidence packs).
- Failure honesty works correctly (redirect loops reported, not hidden).
- WebSearch fallback policy is explicit and user-controlled.
- The only issue is a CLAUDE.md wording contradiction (docs-only fix).

**Recommended hook scope for next phase:**
- `PreToolUse` hook for WebSearch/WebFetch: intercept and suggest krn-search first.
- Hook should NOT block — only suggest/prefer.
- Hook should check if SearXNG is available (localhost:9999) before suggesting.
- Hook should allow user override (always allow WebSearch if user explicitly requests it).

## Final recommendation

**Proceed to WebSearch hook design.** Fix CLAUDE.md SearXNG non-goal wording as a docs-only precursor.

The skill workflow is comfortable, honest, and produces useful evidence. The slash command provides a convenient entry point. Manifests provide full provenance. No code changes needed.
