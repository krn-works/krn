# MVP-1F.5 WebSearch/WebFetch Hook Design

## Baseline

- Commit: `6f52df6a41e42190a3061fe8c0e81599f58bcb8b`
- Working tree: clean
- Tests: 450/450 pass
- Eval-corpus: 11/11 pass
- No WebSearch/WebFetch used in this task.

## Trigger incident

During the first attempt at this design task, Claude Code attempted to spawn a subagent to WebSearch for official Claude Code hook documentation. The user rejected the tool call. This incident confirms that:

1. Soft skill/rules/CLAUDE.md guidance is insufficient to prevent accidental WebSearch.
2. Claude Code defaults to WebSearch for research tasks even when local resources exist.
3. A mechanical guard (hook) is needed to enforce the krn-search-first workflow.

This is the exact behavior the hook is designed to prevent.

## Problem

Claude Code can call WebSearch/WebFetch at any time, even when:
- The project has a krn-search skill with a `/krn-search-research` slash command.
- CLAUDE.md says "Use krn-search for controlled local search/ingestion before WebSearch when practical."
- The project is a local evidence ingestion tool with no need for general web search during development.

The trigger incident proved that policy text alone does not reliably prevent WebSearch use.

## Goal

Design a Claude Code PreToolUse hook that asks before WebSearch/WebFetch when krn-search should be tried first, without blocking intentional user requests.

## Non-goals

- No hook implementation in this task.
- No settings hook config changes in this task.
- No hard deny in first version.
- No MCP integration.
- No runtime source code changes.
- No auto-running krn-search from the hook.
- No blocking tools unrelated to web search (Bash, Read, Grep, etc.).

## Known hook facts from project context

These facts are derived from local project files and existing knowledge of Claude Code. Schema details are marked TO_VERIFY before implementation.

- Claude Code supports hooks configured in `.claude/settings.json` and `.claude/settings.local.json`.
- Project settings (`.claude/settings.json`) are committed and shared across users.
- Local settings (`.claude/settings.local.json`) are not committed and apply only to the current environment.
- `PreToolUse` is a hook event type that fires before a tool is used.
- Hooks can target specific tool names (e.g., `WebSearch`, `WebFetch`).
- Hook scripts receive JSON input on stdin and produce JSON output on stdout.
- The output can include a `decision` field and a `reason` field.
- Known decision values: `allow`, `deny`, `ask` (TO_VERIFY: exact enum values).
- `ask` pauses execution and presents the reason to the user, who can approve or deny.
- Current `.claude/settings.json` has no hooks configured — only env vars and plugins.

## Candidate modes

### Mode A — no hook

Rely on CLAUDE.md policy and skill instructions alone.

**Pros:** Zero friction. No risk of blocking legitimate work. No maintenance.
**Cons:** Proven insufficient by the trigger incident. Claude Code used WebSearch despite explicit policy text.

### Mode B — warn/coach only

Hook returns `allow` with a coaching `reason` that suggests krn-search. The tool call proceeds but the user sees the message.

**Pros:** Zero friction on workflow. Educational. Cannot block legitimate work.
**Cons:** Claude Code may not display the reason prominently. Easy to ignore. No actual guard.

### Mode C — ask permission

Hook returns `ask` with a coaching `reason`. Execution pauses. User must explicitly approve or deny the WebSearch/WebFetch call.

**Pros:** Forces conscious decision. User can approve intentional WebSearch. Prevents accidental use. Stronger than Mode B without the risks of Mode D.
**Cons:** Adds friction. Every WebSearch/WebFetch call requires user interaction, even intentional ones.

### Mode D — hard deny

Hook returns `deny`. WebSearch/WebFetch is blocked entirely.

**Pros:** Maximum enforcement.
**Cons:** Blocks legitimate use. No escape hatch. Users will disable the hook. Wrong default for first implementation.

## Recommended mode

**Mode C — ask permission with coaching message.**

Rationale:
- Stronger than Mode A/B (proven necessary by trigger incident).
- Softer than Mode D (user can always approve intentional WebSearch).
- Good first dogfood mode — tests whether the hook is useful without the risk of hard blocking.
- If Mode C proves too noisy, downgrade to Mode B. If too permissive, escalate to Mode D later.
- Never start with the most restrictive option.

## Trigger scope

**Must cover:**
- `WebSearch`
- `WebFetch`

**Must not cover:**
- `Bash` (needed for krn-search CLI: `python -m search_tool search-query`)
- `Read`
- `Grep` / `find` via Bash
- `Write` / `Edit`
- `Skill` tool invocations
- Project slash commands
- `LSP` operations
- Any local tool calls

The hook must never interfere with running krn-search itself. The tool runs via `Bash` — the hook must not touch `Bash`.

## Decision logic

```
function decide(tool_name, tool_input):
    if tool_name not in ["WebSearch", "WebFetch"]:
        return null  # no opinion

    # Explicit user intent signals (heuristic from tool_input)
    if user_explicitly_requested_web_search(tool_input):
        return ask(reason="You asked to search the web. krn-search is available at /krn-search-research. Approve to proceed with WebSearch.")

    # Default: ask with coaching message
    return ask(reason="krn-search is available for controlled evidence ingestion. Try /krn-search-research <question> first, or approve this WebSearch/WebFetch call if you intentionally want general web search.")
```

**Rules for the decision function:**
1. If tool_name is not WebSearch/WebFetch: no decision (return null/allow).
2. If user explicitly asked to "use WebSearch", "browse online", "search the web": ask with lighter message. The user is conscious of the choice.
3. All other WebSearch/WebFetch calls: ask with full coaching message.
4. Do not auto-run krn-search.
5. Do not inspect secrets, credentials, or environment variables.
6. Do not read arbitrary files from the filesystem.
7. Do not write any files.
8. If unsure about the intent: ask, not deny.

**Explicit intent detection** (heuristic, best-effort):
- Check if the user's recent message or the tool input contains phrases like "use WebSearch", "browse", "search online", "look up online".
- This is a fuzzy heuristic. When in doubt, default to the full coaching message.

## Proposed hook response

Conceptual JSON shape (exact schema TO_VERIFY before implementation):

```json
{
  "decision": "ask",
  "reason": "krn-search is available for controlled evidence ingestion. Try /krn-search-research <question> first, or approve this WebSearch/WebFetch call if you intentionally want general web search."
}
```

For explicit user intent:

```json
{
  "decision": "ask",
  "reason": "You requested web search. krn-search is available at /krn-search-research if you prefer controlled evidence. Approve to proceed with WebSearch."
}
```

**Schema note:** The exact field names (`decision`, `reason`) and valid values need verification against official Claude Code hook documentation before implementation. This is recorded as TO_VERIFY in the implementation task.

## Placement recommendation

**First implementation:** `.claude/settings.local.json`

Rationale:
- Local settings are not committed — safe for dogfooding.
- If the hook breaks workflow or is too noisy, the user can remove it without affecting other contributors.
- No risk of pushing a hook that interrupts other developers.

**Promotion path:**
1. Implement in `settings.local.json` for personal dogfooding.
2. If comfortable after dogfooding, promote to `.claude/settings.json` (project-level).
3. Only after explicit user approval.

**Do not modify `.claude/settings.json` in this task or the implementation task without explicit authorization.**

## Hook script shape

Future script location: `.claude/hooks/websearch_krn_search_guard.py`

**Constraints:**
- Python stdlib only (`json`, `sys`).
- Read JSON from stdin.
- Write JSON to stdout.
- Exit 0 on success, non-zero on parse error.
- No network access.
- No `subprocess`, `os.system`, or shell execution.
- No file reads or writes (no `open()`).
- No reading repo artifacts, evidence packs, or cache.
- No environment variable inspection beyond what's in the hook input.
- Deterministic output for given input.
- Small and auditable (target: under 50 lines).
- No third-party imports.

**Error handling:**
- Malformed JSON on stdin: write `{"decision": "allow"}` to stdout and exit 0. Do not block on errors.
- Missing fields: default to coaching message.
- Exception: write `{"decision": "allow"}` to stdout and exit 0. Fail open.

## Safety constraints

| # | Constraint | Why |
|---|-----------|-----|
| 1 | No secrets | Hook input may contain user data. Must not log or leak. |
| 2 | No network | Hook should be fully offline. Network access from a hook is a security risk. |
| 3 | No generated files | Hook must not create artifacts. Clean stdin/stdout only. |
| 4 | No side effects | Hook must be pure: JSON in, JSON out. |
| 5 | No MCP | Hook scope is WebSearch/WebFetch only. |
| 6 | No auto-running krn-search | The hook suggests krn-search but never executes it. |
| 7 | No hard deny in v1 | First version is ask/coach only. Hard deny requires dogfooding proof. |
| 8 | No blocking explicit user choice | If user says "search the web", the hook asks with lighter message, not deny. |
| 9 | Fail open on error | Malformed input or exceptions produce `allow`, not `deny`. |
| 10 | No Bash interference | Hook targets WebSearch/WebFetch only. Must not touch Bash (krn-search runs via Bash). |

## Future test plan

Tests for the implementation task (not this task):

| # | Test | Expected |
|---|------|----------|
| 1 | WebSearch tool input | `ask` with coaching message |
| 2 | WebFetch tool input | `ask` with coaching message |
| 3 | Bash tool input | No decision (allow) |
| 4 | Read tool input | No decision (allow) |
| 5 | Explicit "search the web" in input | `ask` with lighter message |
| 6 | Empty input | `allow` (fail open) |
| 7 | Malformed JSON input | `allow` (fail open) |
| 8 | Missing `tool_name` field | `allow` (fail open) |
| 9 | Output JSON valid | Parseable, correct schema |
| 10 | No network calls | Script completes without network |
| 11 | No file writes | Script completes without touching filesystem |
| 12 | No subprocess calls | Script completes without shelling out |
| 13 | Deterministic | Same input produces same output |
| 14 | Script under 50 lines | Auditable |

## Rollout plan

1. **Design-only** (this task) — write design memo, update notes.
2. **Implement local ask hook** — add hook config to `.claude/settings.local.json`, create script in `.claude/hooks/`. ACTIVE_TASK.md authorization required.
3. **Dogfood locally** — use krn-search in real tasks, observe hook behavior. Note friction and false positives.
4. **Evaluate** — if comfortable, consider promoting to `.claude/settings.json`. If too noisy, downgrade to Mode B or disable.
5. **Hard deny** — probably never by default. Only if ask mode proves reliable and user explicitly requests stronger enforcement.

## Acceptance criteria

- [x] Design memo created at `notes/MVP1F5_WEBSEARCH_HOOK_DESIGN.md`.
- [x] No hook implemented.
- [x] No settings hook config changed.
- [x] No runtime source changes.
- [x] No test changes.
- [x] No CLI changes.
- [x] No WebSearch/WebFetch used in this task.
- [x] 450/450 tests pass.
- [x] 11/11 eval-corpus pass.
- [x] Next task clearly scoped: MVP-1F.6 implement local ask-mode hook.
