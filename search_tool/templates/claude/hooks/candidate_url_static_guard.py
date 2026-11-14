#!/usr/bin/env python3
"""PreToolUse hook: deny static candidate-url research runs without explicit override."""

import json
import sys

ALLOW_MARKER = "KRN_SEARCH_ALLOW_EXACT_URLS=1"

REASON = (
    "Blocked static candidate-url fallback in Claude Code research flow. "
    "This project allows `--provider static --candidate-url ...` only for exact URLs "
    "already supplied by the user, already present in inspected local/source context, "
    "or copied from prior krn-search output. "
    "Do not invent, template, or search separately for candidate URLs.\n"
    "If SearXNG is unavailable and you do not already have exact allowed URLs, stop and report the limitation.\n"
    f"If you do have exact allowed URLs, rerun intentionally with `{ALLOW_MARKER}` prefixed to the command."
)


def _is_guarded_command(command: str) -> bool:
    lowered = command.lower()
    return (
        "krn-search" in lowered
        and "search-query" in lowered
        and "--provider static" in lowered
        and "--candidate-url" in lowered
        and ALLOW_MARKER.lower() not in lowered
    )


def build_response(payload: dict) -> dict | None:
    if payload.get("tool_name") != "Bash":
        return None
    tool_input = payload.get("tool_input", {})
    if not isinstance(tool_input, dict):
        return None
    command = tool_input.get("command", "")
    if not isinstance(command, str) or not _is_guarded_command(command):
        return None
    return {
        "hookSpecificOutput": {
            "hookEventName": "PreToolUse",
            "permissionDecision": "deny",
            "permissionDecisionReason": REASON,
        }
    }


def main() -> None:
    try:
        raw = sys.stdin.read()
        payload = json.loads(raw) if raw.strip() else {}
    except (json.JSONDecodeError, UnicodeDecodeError):
        sys.exit(0)
    response = build_response(payload)
    if response is not None:
        json.dump(response, sys.stdout)
        sys.stdout.write("\n")


if __name__ == "__main__":
    main()
