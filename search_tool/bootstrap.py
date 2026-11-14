"""Bootstrap command: `krn-search init-claude` copies portable kit artifacts to a target repo."""

from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Any

TEMPLATE_SKILL_RESEARCH = "claude/skills/krn-search-research/SKILL.md"
TEMPLATE_COMMAND_RESEARCH = "claude/commands/krn-search-research.md"
TEMPLATE_SKILL_DIAGNOSE = "claude/skills/krn-search-diagnose/SKILL.md"
TEMPLATE_SKILL_DESIGN_GRILL = "claude/skills/krn-search-design-grill/SKILL.md"
TEMPLATE_SKILL_HANDOFF = "claude/skills/krn-search-handoff/SKILL.md"
TEMPLATE_HOOK = "claude/hooks/websearch_krn_search_guard.py"
TEMPLATE_CANDIDATE_URL_HOOK = "claude/hooks/candidate_url_static_guard.py"

MANAGED_FILES = [
    TEMPLATE_SKILL_RESEARCH, TEMPLATE_COMMAND_RESEARCH,
    TEMPLATE_SKILL_DIAGNOSE, TEMPLATE_SKILL_DESIGN_GRILL, TEMPLATE_SKILL_HANDOFF,
]
OPTIONAL_FILES = [TEMPLATE_HOOK, TEMPLATE_CANDIDATE_URL_HOOK]

INSTRUCTION_FILES = [
    "CLAUDE.md",
    "AGENTS.md",
    ".claude/rules/00-operating-model.md",
]

CONTRACT_START = "<!-- krn-search:research-contract:start -->"
CONTRACT_END = "<!-- krn-search:research-contract:end -->"
RESEARCH_CONTRACT_BLOCK = f"""\
{CONTRACT_START}
## krn-search Research Contract

- Do not use WebSearch/WebFetch in this project.
- For Claude Code research flow, run `krn-search searxng status` and `krn-search searxng up` before `krn-search search-query "<query>" --research` when local SearXNG is not already ready.
- For open-ended web research, start with `krn-search search-query "<query>" --research`.
- Use `--candidate-url` only when the exact URL was supplied by the user, appears in local/source context, or came from prior krn-search output.
- Do not invent, template, guess, or synthesize candidate URLs from domains, slugs, package names, paper titles, or search queries.
- If discovery is unavailable and no exact candidate URLs exist, report the limitation honestly instead of falling back to WebSearch/WebFetch.
- In Claude Code research flow, do not switch to `--provider static --candidate-url ...` unless exact allowed URLs already exist and the retry is intentional.
{CONTRACT_END}
"""

SETTINGS_LOCAL_PATH = ".claude/settings.local.json"
HOOK_SETTINGS = {
    "matcher": "WebSearch|WebFetch",
    "hooks": [
        {
            "type": "command",
            "command": "python3 .claude/hooks/websearch_krn_search_guard.py",
        }
    ],
}
BASH_STATIC_GUARD_SETTINGS = {
    "matcher": "Bash",
    "hooks": [
        {
            "type": "command",
            "command": "python3 .claude/hooks/candidate_url_static_guard.py",
        }
    ],
}
DEFAULT_HOOK_ENV = {
    "KRN_SEARCH_BIN": "krn-search",
    "SEARXNG_URL": "http://localhost:9999",
}


class BootstrapError(ValueError):
    """Bootstrap configuration error with user-facing message."""


def _read_template(name: str) -> str:
    """Read a packaged template file. Works in editable and installed modes."""
    import importlib.resources
    pkg = "search_tool.templates"
    data = importlib.resources.files(pkg).joinpath(name)
    return data.read_text(encoding="utf-8")


def _copy_file(template_name: str, dest: Path, force: bool) -> str:
    """Copy a template to dest. Returns 'created', 'skipped', or 'overwritten'."""
    if dest.exists() and not force:
        return "skipped"
    content = _read_template(template_name)
    dest.parent.mkdir(parents=True, exist_ok=True)
    dest.write_text(content, encoding="utf-8")
    return "overwritten" if dest.exists() and force else "created"  # type: ignore[redundant-expr]


def _inject_research_contract(path: Path, dry_run: bool = False, force: bool = False) -> str:
    """Inject or refresh the krn-search research contract in an existing instruction file."""
    if not path.exists():
        return "missing"

    content = path.read_text(encoding="utf-8")
    block = "\n" + RESEARCH_CONTRACT_BLOCK.rstrip() + "\n"

    if CONTRACT_START in content and CONTRACT_END in content:
        start = content.index(CONTRACT_START)
        end = content.index(CONTRACT_END, start) + len(CONTRACT_END)
        current = content[start:end]
        desired = RESEARCH_CONTRACT_BLOCK.rstrip()
        if current == desired:
            return "unchanged"
        if not force:
            return "unchanged"
        new_content = content[:start] + desired + content[end:]
        action = "updated"
    elif CONTRACT_START in content or CONTRACT_END in content:
        return "unchanged"
    else:
        separator = "" if content.endswith("\n") else "\n"
        new_content = content.rstrip() + separator + block
        action = "injected"

    if not dry_run:
        path.write_text(new_content, encoding="utf-8")
    return action


def _configure_hook_settings(target: Path, dry_run: bool = False) -> str:
    """Create or merge local Claude settings needed to activate the WebSearch guard."""
    path = target / SETTINGS_LOCAL_PATH
    if path.exists():
        try:
            settings = json.loads(path.read_text(encoding="utf-8"))
        except json.JSONDecodeError as exc:
            raise BootstrapError(f"invalid JSON in {path}: {exc}") from exc
        if not isinstance(settings, dict):
            settings = {}
    else:
        settings = {}

    original = json.dumps(settings, sort_keys=True)

    env = settings.setdefault("env", {})
    if not isinstance(env, dict):
        env = {}
        settings["env"] = env
    for key, value in DEFAULT_HOOK_ENV.items():
        env.setdefault(key, value)

    hooks = settings.setdefault("hooks", {})
    if not isinstance(hooks, dict):
        hooks = {}
        settings["hooks"] = hooks

    pre_tool_use = hooks.setdefault("PreToolUse", [])
    if not isinstance(pre_tool_use, list):
        pre_tool_use = []
        hooks["PreToolUse"] = pre_tool_use

    hook_exists = any(
        isinstance(item, dict)
        and item.get("matcher") == HOOK_SETTINGS["matcher"]
        and item.get("hooks") == HOOK_SETTINGS["hooks"]
        for item in pre_tool_use
    )
    if not hook_exists:
        pre_tool_use.append(HOOK_SETTINGS)
    bash_guard_exists = any(
        isinstance(item, dict)
        and item.get("matcher") == BASH_STATIC_GUARD_SETTINGS["matcher"]
        and item.get("hooks") == BASH_STATIC_GUARD_SETTINGS["hooks"]
        for item in pre_tool_use
    )
    if not bash_guard_exists:
        pre_tool_use.append(BASH_STATIC_GUARD_SETTINGS)

    updated = json.dumps(settings, sort_keys=True)
    if original == updated:
        return "unchanged"

    if not dry_run:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(settings, indent=2) + "\n", encoding="utf-8")
    return "configured"


def init_claude(
    target_dir: str,
    dry_run: bool = False,
    force: bool = False,
    with_hook: bool = False,
) -> dict[str, Any]:
    """Run the init-claude bootstrap.

    Returns a dict with keys: created, skipped, overwritten, skipped_files, next_steps.
    """
    target = Path(target_dir).resolve()

    created: list[str] = []
    skipped: list[str] = []
    overwritten: list[str] = []
    injected: list[str] = []
    unchanged: list[str] = []
    updated: list[str] = []
    configured: list[str] = []

    # Map template names to dest subpaths
    mappings: list[tuple[str, str]] = [
        (TEMPLATE_SKILL_RESEARCH, ".claude/skills/krn-search-research/SKILL.md"),
        (TEMPLATE_COMMAND_RESEARCH, ".claude/commands/krn-search-research.md"),
        (TEMPLATE_SKILL_DIAGNOSE, ".claude/skills/krn-search-diagnose/SKILL.md"),
        (TEMPLATE_SKILL_DESIGN_GRILL, ".claude/skills/krn-search-design-grill/SKILL.md"),
        (TEMPLATE_SKILL_HANDOFF, ".claude/skills/krn-search-handoff/SKILL.md"),
    ]
    if with_hook:
        mappings.append((TEMPLATE_HOOK, ".claude/hooks/websearch_krn_search_guard.py"))
        mappings.append((TEMPLATE_CANDIDATE_URL_HOOK, ".claude/hooks/candidate_url_static_guard.py"))

    for tmpl, rel in mappings:
        dest = target / rel
        if dry_run:
            if dest.exists():
                skipped.append(rel)
            else:
                created.append(rel)
            continue

        action = _copy_file(tmpl, dest, force)
        if action == "created":
            created.append(rel)
        elif action == "skipped":
            skipped.append(rel)
        elif action == "overwritten":
            overwritten.append(rel)

    for rel in INSTRUCTION_FILES:
        dest = target / rel
        action = _inject_research_contract(dest, dry_run=dry_run, force=force)
        if action == "injected":
            injected.append(rel)
        elif action == "updated":
            updated.append(rel)
        elif action == "unchanged":
            unchanged.append(rel)

    if with_hook:
        action = _configure_hook_settings(target, dry_run=dry_run)
        if action == "configured":
            configured.append(SETTINGS_LOCAL_PATH)
        elif action == "unchanged":
            unchanged.append(SETTINGS_LOCAL_PATH)

    # Build next steps
    next_steps: list[str] = [
        "Install krn-search: pipx install git+https://github.com/korneliuszburian/krn-search.git",
        "Start local research discovery when needed: krn-search searxng up",
    ]

    return {
        "created": created,
        "skipped": skipped,
        "overwritten": overwritten,
        "injected": injected,
        "updated": updated,
        "unchanged": unchanged,
        "configured": configured,
        "target": str(target),
        "next_steps": next_steps,
    }


def print_summary(result: dict[str, Any]) -> None:
    """Print human-readable summary to stdout."""
    lines: list[str] = []
    lines.append(f"Target: {result['target']}")
    lines.append("")

    if result["created"]:
        lines.append(f"Created ({len(result['created'])}):")
        for f in result["created"]:
            lines.append(f"  + {f}")
        lines.append("")

    if result["overwritten"]:
        lines.append(f"Overwritten ({len(result['overwritten'])}):")
        for f in result["overwritten"]:
            lines.append(f"  ~ {f}")
        lines.append("")

    if result["skipped"]:
        lines.append(f"Skipped ({len(result['skipped'])}):")
        for f in result["skipped"]:
            lines.append(f"  - {f}")
        lines.append("")

    if result.get("injected"):
        lines.append(f"Injected ({len(result['injected'])}):")
        for f in result["injected"]:
            lines.append(f"  + {f}")
        lines.append("")

    if result.get("updated"):
        lines.append(f"Updated ({len(result['updated'])}):")
        for f in result["updated"]:
            lines.append(f"  ~ {f}")
        lines.append("")

    if result.get("configured"):
        lines.append(f"Configured ({len(result['configured'])}):")
        for f in result["configured"]:
            lines.append(f"  + {f}")
        lines.append("")

    if result.get("unchanged"):
        lines.append(f"Already configured ({len(result['unchanged'])}):")
        for f in result["unchanged"]:
            lines.append(f"  = {f}")
        lines.append("")

    if (
        not result["created"]
        and not result["overwritten"]
        and not result["skipped"]
        and not result.get("injected")
        and not result.get("updated")
        and not result.get("configured")
        and not result.get("unchanged")
    ):
        lines.append("No files to process.")
        lines.append("")

    if result["next_steps"]:
        lines.append("Next steps:")
        for step in result["next_steps"]:
            lines.append(f"  * {step}")
        lines.append("")

    sys.stdout.write("\n".join(lines))
