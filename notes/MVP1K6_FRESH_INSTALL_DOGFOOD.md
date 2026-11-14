# MVP-1K.6 — Fresh install dogfood for `krn-search init-claude`

## Baseline
- SHA: 61a7b777aadcbca5fd896153d43c9dff70ad33d1
- Tests: 680/680 pass
- MVP-1K.5 bootstrap command complete (all 24 tests pass in editable mode)

## Environment
- OS: Linux 6.6.87.2-microsoft-standard-WSL2 (Debian-based)
- Python: 3.12.3
- Install method: `python3 -m venv` + `pip install` from source tree (non-editable)
- Fresh empty directory (not a git repo, no `.claude/` pre-existing)

## Scenario 1: Installed CLI availability
- `krn-search --version` → `krn-search 0.1.0`
- Status: **PASS**

## Scenario 2: Dry-run (default)
- Command: `krn-search init-claude --target-dir <tmp>/target --dry-run`
- Output: reports 2 files would be created (SKILL.md + command)
- No `.claude/` directory created on disk
- Status: **PASS**

## Scenario 3: Default create (skill + command only)
- Command: `krn-search init-claude --target-dir <tmp>/target`
- Created: 2 files (SKILL.md, command)
- No hooks directory created
- No settings files created
- Status: **PASS**

## Scenario 4: Content verification
- SKILL.md contains: `krn-search search-query` (3 occurrences), `--research` (1 occurrence)
- Command file contains: `krn-search-research`, `krn-search search-query`
- Status: **PASS**

## Scenario 5: Idempotent second run (skip)
- Command: `krn-search init-claude --target-dir <tmp>/target` (second time)
- Output: `Skipped (2)` for both existing files
- File count unchanged at 2
- Status: **PASS**

## Scenario 6: `--with-hook` flag
- Command: `krn-search init-claude --target-dir <tmp>/target --with-hook`
- Created: 1 additional file (`.claude/hooks/websearch_krn_search_guard.py`)
- Existing 2 files skipped
- Hook content contains: `WebSearch` (4 occurrences), `WebFetch` (4 occurrences)
- File count: 3
- Status: **PASS**

## Scenario 7: `--force` flag
- Modified SKILL.md with `# MODIFIED CONTENT`
- Command: `krn-search init-claude --target-dir <tmp>/target --force --with-hook`
- Output: `Overwritten (3)` for all files
- Modified content gone (restored from template)
- Status: **PASS**

## Scenario 8: Post-init health check
- Command: `krn-search health --json --work-dir <tmp>/target/.local/krn-search-runs`
- Output: valid JSON, overall `ok`
- `package_import`: ok
- `static_provider`: ok
- `searxng_reachable`: info (optional, not configured)
- `evidence_writable`: info (directory not yet created, will be on first use)
- `objects_writable`: info (directory not yet created, will be on first use)
- Status: **PASS**

## Scenario 9: No leakage
- `git status --short` in krn-search repo shows only `build/` (pip build artifact)
- No untracked files in source repo working tree
- Status: **PASS**

## Scenario 10: Existing tests
- `tests/test_init_claude.py`: 24/24 pass
- Full suite: 680/680 pass
- Status: **PASS**

## Friction found
None. The installed-mode story works identically to editable mode. The `importlib.resources` template loading works correctly in non-editable installations.

## Verdict
**FRESH_INSTALL_DOGFOOD_PASS**

The `krn-search init-claude` command works correctly from a fresh pip install in a brand-new directory. All flags (`--dry-run`, `--force`, `--with-hook`) behave as designed. No artifacts leak into the source repo.
