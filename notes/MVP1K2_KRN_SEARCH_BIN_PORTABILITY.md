# MVP-1K.2 — KRN_SEARCH_BIN portability convention

## Baseline
02ce750cb8f063520cf4b032662af644e9c1faf3

## Problem
All reusable Claude Code artifacts (skills, slash commands, README.md) hardcoded `.venv/bin/python` or `.venv/bin/krn-search`, making them unusable in other repos without manual editing.

## Convention

```bash
if [ -n "${KRN_SEARCH_BIN:-}" ]; then
  :
elif command -v krn-search >/dev/null 2>&1; then
  KRN_SEARCH_BIN="krn-search"
elif [ -x .venv/bin/python ]; then
  KRN_SEARCH_BIN=".venv/bin/python -m search_tool"
elif command -v python3 >/dev/null 2>&1; then
  KRN_SEARCH_BIN="python3 -m search_tool"
else
  KRN_SEARCH_BIN="python -m search_tool"
fi
```

Resolution order: explicit env var → installed CLI on PATH → editable `.venv` → `python3` → `python`.

Usage: unquoted `$KRN_SEARCH_BIN` in command examples (may contain spaces). Do NOT use `"$KRN_SEARCH_BIN"`.

## Files audited

| File | Type | Action |
|---|---|---|
| `CLAUDE.md` | Repo config | Updated Python command hygiene section |
| `README.md` | Project docs | Replaced all command examples; added portable kit section |
| `.claude/commands/krn-search-research.md` | Slash command | Replaced commands; added convention snippet |
| `.claude/skills/krn-search-research/SKILL.md` | Skill | Replaced all command examples; added convention note |
| `.claude/skills/krn-search-next-task/SKILL.md` | Skill | Updated test command to use `$PYTHON_BIN` |
| `.claude/skills/krn-search-implementation/SKILL.md` | Skill | Updated test commands to use `$PYTHON_BIN` |
| `.claude/skills/krn-search-review/SKILL.md` | Skill | Updated test command to use `$PYTHON_BIN` |
| `.claude/skills/krn-search-acceptance/SKILL.md` | Skill | Updated test commands to use `$PYTHON_BIN` |
| `.claude/skills/krn-search-research/evals/evals.json` | Eval fixture | No change (no command examples) |
| `notes/` (all) | Historical reports | Left alone (historical record) |

## Changes made
- 8 files updated (7 reusable artifacts + CLAUDE.md)
- 18 hardcoded `.venv/bin/python` / `.venv/bin/krn-search` references replaced with `$KRN_SEARCH_BIN`
- Portable kit section added to README.md with install, verify, configure, use steps
- Convention note added to README.md

## Remaining acceptable local references
- `notes/MVP1K1_PORTABLE_RESEARCH_KIT_DESIGN.md` — design doc referencing old state
- `notes/EXPERIMENT_LOG.md` — historical log of past sessions
- `notes/MVP1*` dogfooding reports — historical record of past work
- `notes/PROJECT_STATE.md` — will be updated in commit

## Tests
656/656 passing
Eval-corpus: 11/11 pass
JSON parse: OK
Compile: OK

## Known limitations
- `notes/PROJECT_STATE.md` still mentions `.venv/bin/python` in line 112 (preferred research command) — updated in this commit
- `notes/MVP1K1_PORTABLE_RESEARCH_KIT_DESIGN.md` references old convention — will be superseded by this convention
- The portable kit section in README.md mentions MCP/server as deferred (by design)

## Next recommended step
MVP-1K.3 — Add Claude Code hook integration for automatic krn-search invocation in research workflows.
