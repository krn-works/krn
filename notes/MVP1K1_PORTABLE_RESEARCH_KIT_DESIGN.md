# MVP-1K.1 — Portable Research Kit Design

**Date:** 2026-05-16
**Baseline SHA:** a9f71ccc5813e9c9ea7f783c2e66d1e02fcc11bf

---

## 1. Baseline

| Check | Status |
|-------|--------|
| HEAD | a9f71cc == origin/main |
| Working tree | clean |
| Tests | 656/656 pass |
| py_compile | OK |
| git diff --check | no whitespace errors |
| eval-corpus | 11/11 passed, JSON valid |

Research pipeline operational. Research mode `--research` preset with 8/8 static fallback success.

---

## 2. Problem

krn-search is currently tied to this repo in ways that block portability to another codebase:

1. **Hardcoded `.venv/bin/python`** — skill docs, slash commands, implementation/acceptance/review skills all reference `.venv/bin/python` directly.
2. **Hardcoded `localhost:9999`** — SearXNG default in `cli.py` (line 720) and `ui.py` (line 120). Configurable via `SEARXNG_URL` env var, but the default is repo-anchored.
3. **`krn-search` naming** — package name `krn-search-lab`, CLI `krn-search`, directory `search_tool/`, work-dir `.local/krn-search-runs` — all repo-specific.
4. **Claude Code config** — hook, skill, command files are committed under `.claude/` and reference `krn-search` by name.
5. **No install mechanism documented** — pyproject.toml already has `krn-search` CLI entrypoint, but no README section on installation for new repos.

---

## 3. Portability Audit

### 3.1 Already portable (no changes needed)

| Component | Status | Evidence |
|-----------|--------|----------|
| `search_tool/` package | **Portable** | Zero repo-absolute paths in source. All paths relative to work-dir or configurable. |
| `pyproject.toml` CLI entrypoint | **Portable** | `[project.scripts] krn-search = "search_tool.cli:main"` — installable via pip/uv/pipx. |
| Dependencies | **Portable** | httpx + beautifulsoup4 only. No SearXNG dependency. |
| Hook guard script | **Portable** | Pure Python stdlib. No repo references. |
| Evidence pack schema | **Portable** | Self-contained, no repo-absolute paths. |
| Search-run manifest | **Portable** | Self-contained, relative paths. |
| eval-corpus | **Portable** | Fixed fixture URLs, network-free. |
| URL policy | **Portable** | Generic policy (no repo-anchored allowlists). |
| Cache semantics | **Portable** | SHA256-keyed, work-dir scoped. |
| README.md | **Mostly portable** | References `python -m search_tool` (not `.venv/bin/python`). |

### 3.2 Not portable (needs changes)

| Component | Issue | Fix |
|-----------|-------|-----|
| SKILL.md commands | `.venv/bin/python` hardcoded | `KRN_SEARCH_BIN` env var or fallback script |
| Slash command | `.venv/bin/python` hardcoded | Same convention |
| Implementation skill | `.venv/bin/python` in test commands | Same convention |
| Acceptance skill | `.venv/bin/python` in test commands | Same convention |
| Review skill | `.venv/bin/python` in test commands | Same convention |
| cli.py SearXNG default | `localhost:9999` | Keep as-is (env var override exists); document in skill |
| Work-dir conventions | `.local/krn-search-runs` hardcoded in research preset | Convention, not code enforcement; document as convention |
| Package name | `krn-search-lab` / `krn-search` | Accept: the tool is named `krn-search` (portable CLI name, not repo-locked) |

### 3.3 Naming analysis

The name `krn-search` is project-specific but does NOT block portability:
- It's a CLI tool name (like `gitleaks`, `gitleaks`, `trufflehog`).
- Other repos can fork and rename if needed.
- The Python package `search_tool` is generic.
- **Decision:** Keep the name. It's a product name, not a repo lock.

### 3.4 SearXNG default analysis

`cli.py` line 720: `searxng_url = os.environ.get("SEARXNG_URL", "http://localhost:9999")`
`ui.py` line 120: hardcoded in HTML input default value.

The `localhost:9999` default is a reasonable development default. The `SEARXNG_URL` env var provides override. This is acceptable as-is with documentation.

---

## 4. Packaging Options Comparison

### Option A: CLI-first portable kit

Ship the `search_tool` package as an installable CLI. Users `pip install` it and get `krn-search` on PATH. Copy `.claude/skills/` and `.claude/commands/` into target repo.

| Criteria | Rating | Notes |
|----------|--------|-------|
| Portability | 9/10 | pip install works anywhere |
| Setup friction | 3/10 | `pip install .` + copy `.claude/` files |
| Lock-in | Low | Standard pip package |
| Safety | High | No runtime hooks, no MCP |
| Maintainability | Medium | Two repos need to sync skill updates manually |

### Option B: Claude Code skill package

Bundle as a `.claude/` directory that users copy into their repo. No pip install. Users invoke via `python -c "import search_tool; search_tool.cli.main()"` or alias.

| Criteria | Rating | Notes |
|----------|--------|-------|
| Portability | 7/10 | No install but requires Python in path |
| Setup friction | 5/10 | Copy files + set alias |
| Lock-in | Medium | Claude Code config lock-in |
| Safety | High | No runtime changes |
| Maintainability | Low | Manual sync in both directions |

### Option C: Claude plugin

Build as a Claude Code extension/plugin.

| Criteria | Rating | Notes |
|----------|--------|-------|
| Portability | 6/10 | Plugin system not yet stable |
| Setup friction | 7/10 | Plugin authoring overhead |
| Lock-in | High | Anthropic plugin ecosystem lock-in |
| Safety | Medium | Plugin can run arbitrary code |
| Maintainability | Low | Requires maintaining plugin alongside tool |

### Option D: MCP server

Wrap krn-search as an MCP tool server.

| Criteria | Rating | Notes |
|----------|--------|-------|
| Portability | 8/10 | MCP is a standard protocol |
| Setup friction | 6/10 | MCP server setup + config |
| Lock-in | Medium | MCP ecosystem |
| Safety | Medium | MCP servers run code |
| Maintainability | Medium | Two moving parts (CLI + MCP) |

### Option E: Staged hybrid (recommended)

| Criteria | Rating | Notes |
|----------|--------|-------|
| Portability | 9/10 | pip install + copyable `.claude/` bundle |
| Setup friction | 2/10 | pip install + one script to copy Claude files |
| Lock-in | Low | Standard pip + Claude Code skill system |
| Safety | High | No runtime hooks, no MCP, no plugins |
| Maintainability | High | CLI is self-contained; Claude config is data |

---

## 5. Recommendation: Staged Hybrid

**v0.1: Portable CLI + copyable skill bundle + optional hook**

### Stage 1 (v0.1 — this MVP): Installable CLI + copyable `.claude/` bundle

**CLI install:**
```bash
pip install .        # or uv pip install . or pipx install .
# or from git:
pip install git+https://github.com/<org>/krn-search.git
```

**Claude Code setup:**
```bash
# Copy the reusable Claude Code artifacts
cp -r .claude/skills/krn-search-research <target>/.claude/skills/
cp .claude/commands/krn-search-research.md <target>/.claude/commands/
# Optional: add hook
cp .claude/hooks/websearch_krn_search_guard.py <target>/.claude/hooks/
# Add hook config to <target>/.claude/settings.local.json
```

**Hook config snippet (to be merged into target's settings.local.json):**
```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "WebSearch|WebFetch",
        "hooks": [
          {
            "type": "command",
            "command": "python .claude/hooks/websearch_krn_search_guard.py"
          }
        ]
      }
    ]
  }
}
```

### Stage 2 (future): Bundle script

A small shell script that copies all `.claude/` artifacts to a target repo with a single command.

### Stage 3 (future): Skill/hook stability validation

Validate the bundle works across at least two repos before promoting to a full plugin.

---

## 6. Target User Experience

### Scenario: New repo wants krn-search research

1. **Install CLI** (one command):
   ```bash
   pip install git+https://github.com/<org>/krn-search.git
   ```

2. **Copy Claude artifacts** (copy 4 files):
   - `.claude/skills/krn-search-research/SKILL.md`
   - `.claude/commands/krn-search-research.md`
   - `.claude/hooks/websearch_krn_search_guard.py` (optional)
   - Hook config into `settings.local.json` (optional, one-line addition)

3. **Use:**
   ```bash
   /krn-search-research "What is this project about?"
   ```

4. **Verify:**
   ```bash
   krn-search eval-corpus tests/fixtures/search_corpus/basic.json
   ```

**Total setup: ~3 commands, zero code changes.**

---

## 7. Required Changes

### 7.1 Python interpreter convention

**Current:** All skills/commands use `.venv/bin/python` hardcoded.

**New convention:** `KRN_SEARCH_BIN` environment variable with fallback chain.

```
KRN_SEARCH_BIN (env) -> krn-search (PATH) -> .venv/bin/python -> python3 -> python
```

**Changes needed:**

| File | Lines | Change |
|------|-------|--------|
| `.claude/skills/krn-search-research/SKILL.md` | All command examples | `.venv/bin/python` → `$KRN_SEARCH_BIN or python3 -m search_tool` |
| `.claude/commands/krn-search-research.md` | Lines 5, 17 | Same convention |
| `.claude/skills/krn-search-implementation/SKILL.md` | Line 24, 28 | Same convention |
| `.claude/skills/krn-search-acceptance/SKILL.md` | Line 16 | Same convention |
| `.claude/skills/krn-search-review/SKILL.md` | Line 33 | Same convention |
| `CLAUDE.md` | Python command hygiene section | Add `KRN_SEARCH_BIN` to the resolution chain |

**Rationale:** `KRN_SEARCH_BIN` is the explicit override. If not set, fall back to `krn-search` (from pip PATH install) or `python3 -m search_tool` (editable install). This covers all install methods.

### 7.2 Skill docs: Add setup instructions

Add a "Setup in new repo" section to `krn-search-research/SKILL.md`:

```markdown
## Setup in a new repo

1. Install: `pip install git+https://github.com/<org>/krn-search.git`
2. Copy `.claude/skills/krn-search-research/` and `.claude/commands/krn-search-research.md`
3. (Optional) Copy `.claude/hooks/websearch_krn_search_guard.py` and add hook config to `settings.local.json`
```

### 7.3 README.md: Add installation section

Add to README.md:
```markdown
## Installation

```bash
pip install .
# or
uv pip install .
# or
pipx install .
```

Verifies with: `krn-search eval-corpus tests/fixtures/search_corpus/basic.json`
```

### 7.4 Work-dir convention documentation

The `.local/krn-search-runs` convention is documented in skills and CLAUDE.md as the default work directory. This is a convention, not code enforcement. New repos should create their own work directory or use the default.

No code changes needed — this is documentation only.

### 7.5 SearXNG default documentation

The `localhost:9999` default is acceptable. Document the `SEARXNG_URL` env var override in the skill docs. No code changes needed.

---

## 8. Non-goals for v0.1

- **No MCP server** — explicitly out of scope (hard non-goal)
- **No Claude Code plugin** — premature; validate via skill/hook first
- **No pyproject.toml changes** — CLI entrypoint already exists
- **No WebSearch hook changes** — hook script is already portable (pure stdlib)
- **No renaming** — `krn-search` stays as the product name
- **No runtime changes** — design only, unless tiny docs correction
- **No SearXNG dependency addition** — optional, self-hosted only

---

## 9. Staged Roadmap

| Stage | What | When |
|-------|------|------|
| v0.1 (this task) | Portable CLI + copyable `.claude/` bundle + `KRN_SEARCH_BIN` convention | MVP-1K.1 |
| v0.2 | Bundle script (`scripts/clone-to-repo.sh` or similar) | Future |
| v0.3 | Validate across 2+ repos | After v0.2 |
| v1.0 | Promote to plugin if skill/hook proves stable across repos | After v0.3 validation |

---

## 10. First Implementation Ticket

**MVP-1K.2: Apply `KRN_SEARCH_BIN` convention to all Claude Code artifacts**

Changes:
1. Replace `.venv/bin/python` with `$KRN_SEARCH_BIN or python3 -m search_tool" in all skill docs and commands
2. Update CLAUDE.md Python command hygiene to add `KRN_SEARCH_BIN` to resolution chain
3. Add "Setup in new repo" section to `krn-search-research/SKILL.md`
4. Add installation section to README.md
5. Tests: no code changes, so no new tests. Verify existing tests still pass.
6. Commit: `feat: portable research kit — KRN_SEARCH_BIN convention + setup docs`

---

## 11. Acceptance Criteria for v0.1

- [ ] All skill docs use `$KRN_SEARCH_BIN or python3 -m search_tool` (no hardcoded `.venv/bin/python`)
- [ ] Slash command uses `KRN_SEARCH_BIN` convention
- [ ] CLAUDE.md Python command hygiene includes `KRN_SEARCH_BIN`
- [ ] README.md has installation section
- [ ] `krn-search-research/SKILL.md` has setup instructions for new repos
- [ ] 656/656 tests still pass
- [ ] eval-corpus 11/11
- [ ] py_compile OK
- [ ] No runtime changes to `search_tool/` package
