# MVP-1F.3 Claude Code Skills/Rules Design

## Baseline

**Commit:** `36050b5a1738f2f9af733fe3dee051ba227fd643`
**Branch:** main
**Tests:** 450/450 passed
**Eval-corpus:** 11/11 passed

## Problem

Claude Code has no guidance on when or how to use krn-search. The tool is verified and useful (MVP-1F.2 dogfooding), but without a skill/rules, Claude Code will default to WebSearch for web research, missing the benefits of local controlled ingestion: evidence packs, manifests, audit trails, and URL policy enforcement.

## Goal

Create Claude Code project-level skills and rules that teach Claude Code to use krn-search correctly for controlled local research/ingestion, with explicit WebSearch fallback policy and honest limitation reporting.

## Non-goals

- No hooks (deferred until skill workflow is proven comfortable)
- No project MCP
- No WebSearch prevention/blocking
- No external services beyond already running local SearXNG
- No runtime source changes
- No new CLI commands
- No dependency changes
- No browser automation
- No answer synthesis in krn-search

## Chosen approach

- Project-level skill in `.claude/skills/krn-search-research/SKILL.md` — on-demand instructions for evidence-based research workflow
- Concise section in `CLAUDE.md` — always-loaded usage policy reference
- Optional project slash command `.claude/commands/krn-search-research.md` — user-invoked research shortcut
- No hooks, no MCP, no external services

## Skill/rule surface

| Artifact | Type | When loaded |
|---|---|---|
| `.claude/skills/krn-search-research/SKILL.md` | Skill | On demand when research workflow is invoked |
| `CLAUDE.md` (usage policy section) | Rule | Every conversation |
| `.claude/commands/krn-search-research.md` | Command | When user types `/krn-search-research` |

## When Claude Code should use krn-search

- User asks for factual information about specific URLs or documents
- User asks for evidence-based research with source attribution
- Local SearXNG instance is available and user wants web search with evidence packs
- User provides candidate URLs for ingestion
- Deterministic eval verification is needed

## When Claude Code should not use krn-search

- User asks for broad exploratory internet research with no specific sources
- No local SearXNG is available and user hasn't provided candidate URLs
- Task requires real-time data that changes faster than cache allows
- Task is about local code/files, not web content

## Required workflow

1. Determine query and provider (SearXNG if available, static if URLs provided)
2. Run `search-query` CLI with appropriate flags
3. Read search-run manifest for overview (candidates, blocked, selected)
4. Read fetch-list manifest for fetch outcomes
5. Read relevant evidence packs for source content
6. Base claims on evidence packs, not discovery snippets
7. Report failed/redirect/blocked URLs explicitly
8. Report limitations honestly
9. If evidence is insufficient, ask user whether to fall back to WebSearch

## Evidence-reading rules

- Evidence packs are the authoritative source. Discovery snippets are not evidence.
- Always check evidence pack frontmatter for `fetch.status`, `extraction.status`, and `security.blocked_reason`.
- Quality score 3/3 = full extraction, 2/3 = truncated, 1/3 = extraction failed, 0/3 = blocked or fetch failed.
- Report the source URL, fetch status, and quality score when citing evidence.
- Do not cite evidence from blocked or failed packs as factual content.

## Limitations reporting rules

- Always report: how many URLs were fetched, how many succeeded, how many failed/blocked/skipped.
- Always mention: redirects not followed (if any), truncated content, PDFs skipped, JS-heavy pages.
- If all evidence packs failed, say so explicitly rather than fabricating an answer.
- Do not hide failed fetches. Do not silently skip blocked URLs.

## WebSearch policy

- krn-search is preferred for controlled local research when practical.
- WebSearch remains available as a fallback when:
  - krn-search evidence is insufficient for the user's question
  - No local SearXNG is available and no candidate URLs provided
  - User explicitly asks for WebSearch
- When falling back to WebSearch, mention that krn-search evidence was insufficient and why.
- No hook blocks WebSearch. This is intentional — workflow comfort comes first.

## Hook policy

- No hooks in this phase.
- Hook design may be documented as a future option.
- A WebSearch prevention hook would only be created after the skill workflow is proven comfortable through dogfooding.

## Future hook concept

If the skill workflow proves comfortable, a future hook could:
- Warn (not block) when WebSearch is used for a query that krn-search could handle
- Suggest running krn-search first when local SearXNG is available
- This remains a design concept, not an implementation plan

## Acceptance criteria

1. Skill `.claude/skills/krn-search-research/SKILL.md` exists with complete workflow instructions
2. CLAUDE.md has concise krn-search usage policy section
3. Slash command `.claude/commands/krn-search-research.md` exists (if useful) or is documented as not needed
4. No runtime source changes
5. No test changes
6. No CLI behavior changes
7. No dependency changes
8. All 450 tests pass
9. Eval-corpus 11/11 passes
10. Known limitations documented in skill
11. WebSearch fallback policy is explicit and user-approved
12. No generated evidence/cache/.local files in commit
