# MVP-1K.4 — Shell-safe launcher / bootstrap strategy

## Baseline
94996cf0aee49b24507e6246c81343fa8beaa696

## Friction from K.3
External-repo dogfood proved the portable kit works, but revealed:
- `KRN_SEARCH_BIN` with command+args (editable fallback) uses unquoted `$KRN_SEARCH_BIN` word splitting
- Works in bash (Claude Code's shell) but not zsh for manual copy-paste
- Most users won't have `krn-search` on PATH — editable fallback is common

## Launcher strategies compared

### Option A — Keep KRN_SEARCH_BIN as command+args (current)
- Shell: bash only (Claude Code). zsh manual copy-paste breaks.
- Claude Code: works.
- Setup: export KRN_SEARCH_BIN="..."
- **Verdict:** Keep as advanced/internal override. Document zsh limitation.

### Option B — Require installed `krn-search` executable
- Shell: universal.
- Claude Code: works.
- Manual copy-paste: works.
- Setup: pipx/uv tool install (non-trivial one-time step).
- **Verdict:** Primary portable user story.

### Option C — Shell function `krn_search()`
- Shell: bash+zsh compatible.
- Claude Code: works.
- Manual copy-paste: requires defining function in each session.
- Setup: source function definition.
- **Verdict:** Good fallback pattern for Claude artifacts. Overkill for K.4.

### Option D — Wrapper script in target repo
- Shell: universal.
- Claude Code: works.
- Manual copy-paste: works.
- Setup: bootstrap step to create `.local/bin/krn-search`.
- **Verdict:** Best v0.2 strategy. Requires bootstrap command. Defer to K.5+.

### Option E — Split env vars
- Shell: universal (no word splitting issues).
- Claude Code: works.
- Manual copy-paste: works.
- Setup: 2 env vars instead of 1. More verbose. Python-specific.
- **Verdict:** Discard. Awkward and unnecessary.

### Option F — Bootstrap command (`krn-search init-claude`)
- Shell: universal.
- Claude Code: works.
- Setup: one command.
- **Verdict:** Good future direction. Requires runtime changes. Defer to K.5+.

## Recommendation

**Primary user story:** install `krn-search` executable via pipx/uv tool.

**Claude Code editable fallback:** `KRN_SEARCH_BIN` env var with bash-specific warning.

**Future (K.5+):** wrapper script in target repo (`krn-search init-claude`).

**What changed:**
- README primary examples use `krn-search` (not `$KRN_SEARCH_BIN`)
- Editable fallback documented separately with explicit bash-vs-zsh warning
- KRN_SEARCH_BIN kept as internal/advanced override
- Skill/command updated similarly

## Implementation

Docs/artifact polish only. No runtime changes.

Files changed:
- `CLAUDE.md` — primary launcher changed to `krn-search`, KRN_SEARCH_BIN section simplified
- `README.md` — all command examples use `krn-search`; editable fallback documented separately with zsh warning
- `.claude/commands/krn-search-research.md` — primary launcher `krn-search`, KRN_SEARCH_BIN as internal override
- `.claude/skills/krn-search-research/SKILL.md` — primary launcher `krn-search`, launcher config section, bash/zsh note

## Micro-dogfood result

- Editable fallback: status ok, 1/1 evidence, quality 3/3, paths under target repo
- Installed CLI: not tested (not installed in CI environment) — expected to work on user systems

## Known limitations

- zsh users copying commands manually will still hit issues unless they install `krn-search`
- The KRN_SEARCH_BIN resolver snippet was removed from skills/CLAUDE.md to reduce verbosity — users relying on editable fallback need to know they need to `export KRN_SEARCH_BIN=...` first
- No bootstrap/wrapper generation yet (planned for K.5+)

## Next recommended task

MVP-1K.5 — Implement `krn-search init-claude` bootstrap command: copies `.claude` artifacts to target repo, writes `.local/bin/krn-search` wrapper, configures Claude Code integration.
