# MVP-1K.3 — Portable research kit external-repo dogfood

## Baseline
550a9bca3c2442d9c3176f0e484be3e14cf97b38

## Target repo setup
- `DOGFOOD_ROOT=/tmp/tmp.a2YfkqC4Dn` (created via `mktemp -d`)
- `TARGET=/tmp/tmp.a2YfkqC4Dn/portable-target`
- Empty git repo with a simple README.md
- Confirmed NOT inside krn-search repo

## KRN_SEARCH_BIN used
- `krn-search` not on PATH
- Used editable fallback: `KRN_SEARCH_BIN=/home/krn/coding/krn/krn-search/.venv/bin/python -m search_tool`
- Resolved via `bash -c` (convention designed for Claude Code's bash, not zsh)
- **Friction:** unquoted `$KRN_SEARCH_BIN` word splitting only works in bash. zsh does not split on spaces in unquoted variables. Claude Code runs bash, so convention is correct for its target, but users in zsh sessions may hit issues if they copy-paste manually.

## Artifacts copied
- `.claude/skills/krn-search-research/SKILL.md`
- `.claude/commands/krn-search-research.md`
- `.claude/hooks/websearch_krn_search_guard.py`
- No hardcoded `.venv/bin/python` outside convention fallback snippets

## Health result
- `KRN_SEARCH_BIN --version` → `krn-search 0.1.0`
- `KRN_SEARCH_BIN health --json` → valid JSON (tested, health OK)

## Static research result
- Query: "python http.server security docs"
- Provider: static, candidate: docs.python.org
- status: ok
- evidence_count: 1
- quality: 3/3, authority: 3 (official_docs)
- compact_summary_path: under target repo
- paths verified inside target repo `.local/krn-search-runs`

## Skillflow result
- Query: "agent patterns anthropic effective agents"
- Two candidate URLs (anthropic.com + docs.anthropic.com)
- status: ok
- evidence_count: 2/2
- Both quality 3/3, authority 3
- Compact path under target repo
- No artifacts leaked into krn-search repo

## Artifact path verification
- All evidence packs: under `TARGET/.local/krn-search-runs/runs/...`
- All manifests: under `TARGET/.local/krn-search-runs/runs/...`
- compact_summary_path: exists and under target repo
- No artifacts in krn-search repo working tree

## Hook template status
- Copied but not configured (no `.claude/settings.local.json`)
- Hook present but not enabled globally

## Friction found
1. **zsh incompatibility:** unquoted `$KRN_SEARCH_BIN` word splitting works in bash (Claude Code's shell) but not zsh. Users in zsh need to wrap commands in `bash -c` or use a wrapper script. Minor — convention targets Claude Code's bash, not interactive user shells.
2. **No krn-search on PATH:** most users won't have `krn-search` installed via pipx/uv tool. They'll need to export `KRN_SEARCH_BIN` with the editable path. The README portable kit section documents this, but it's a setup step.
3. **Convention note missing from README portable kit section:** the convention note was added after the main portable kit section. Users might copy the install/use section without the convention note.

## Fixes made
None required. All behavior is correct. The friction items are documentation/setup concerns, not code issues.

## Verdict
**PORTABLE_KIT_PASS**

The portable kit works outside the krn-search repo:
- CLI resolves via KRN_SEARCH_BIN
- Skills + slash command copy cleanly
- Research produces artifacts in target repo's `.local/krn-search-runs`
- No path leakage, no repo layout dependency
- Static provider works without SearXNG
- Multiple candidate URLs work
