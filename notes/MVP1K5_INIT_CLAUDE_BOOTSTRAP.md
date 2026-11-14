# MVP-1K.5 — `krn-search init-claude` bootstrap command

## Baseline
- SHA: 696d530162530e971c2c1d8845bab6a9627a14dd
- Tests: 656/656 pass
- eval-corpus: 11/11 pass
- Portable kit dogfood passed (MVP-1K.3)

## Goal
Implement `krn-search init-claude` — the smallest useful bootstrap command for the portable research kit.

## CLI Contract

```
krn-search init-claude [--target-dir PATH] [--dry-run] [--force] [--with-hook]
```

| Flag | Default | Behavior |
|------|---------|----------|
| `--target-dir` | `.` (cwd) | Target repo directory |
| `--dry-run` | false | Print intended actions, write nothing |
| `--force` | false | Overwrite existing managed files |
| `--with-hook` | false | Also copy websearch guard hook |

**Default behavior:** Creates `.claude/skills/krn-search-research/SKILL.md` and `.claude/commands/krn-search-research.md`. Skips existing files. Does NOT create hook, settings files, or activate anything.

**Exit code:** 0 on success (including skipped existing files).

## Implementation Files

| File | Purpose |
|------|---------|
| `search_tool/bootstrap.py` | Core logic: template reading, file copy, summary |
| `search_tool/cli.py` | Subcommand registration + dispatch |
| `search_tool/templates/claude/skills/krn-search-research/SKILL.md` | Template source |
| `search_tool/templates/claude/commands/krn-search-research.md` | Template source |
| `search_tool/templates/claude/hooks/websearch_krn_search_guard.py` | Template source |
| `pyproject.toml` | Package data config |
| `tests/test_init_claude.py` | 24 tests |

## Template/Package-Data Strategy

Templates live under `search_tool/templates/claude/` as exact copies of the canonical `.claude/` files. `pyproject.toml` configures:

```toml
[tool.setuptools.package-data]
search_tool = ["templates/**/*"]
```

Template reading uses `importlib.resources.files("search_tool.templates")` — works in both editable and installed modes.

## Tests

24 new tests in `tests/test_init_claude.py`:
- dry-run creates nothing
- default creates skill + command
- default does not create hook
- `--with-hook` creates hook
- existing files skipped by default
- `--force` overwrites existing files
- `--target-dir` writes to requested target
- summary formatting (created/skipped/overwritten)
- content verification (expected strings present)
- no settings files created
- CLI entry point integration tests

## Known Limitations

- Hook is copied but never activated automatically
- `--force` overwrites managed files only (skill + command); unmanaged files untouched
- No wrapper script generation yet (deferred to future K.5+ work)
- No plugin packaging or MCP configuration

## Next Recommended Task

External dogfood: run `krn-search init-claude` from a fresh temp repo outside the krn-search codebase to verify it works with an installed (non-editable) package.
