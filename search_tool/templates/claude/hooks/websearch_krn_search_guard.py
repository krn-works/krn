#!/usr/bin/env python3
"""PreToolUse hook: deny WebSearch/WebFetch with krn-search recovery."""

import json
import sys

TARGET_TOOLS = {"WebSearch", "WebFetch"}

REASON = (
    "WebSearch/WebFetch are disabled in this project. "
    "Use krn-search for all web research:\n"
    '  krn-search search-query "<query>" --research\n'
    '  krn-search search-query "<query>" --research --candidate-url <user-provided-or-known-url>\n'
    "  krn-search fetch-url <url> --follow-redirects\n"
    "Alternatively: /krn-search-research <question>\n"
    "Do not retry WebSearch/WebFetch. "
    "Do not invent URLs. If krn-search evidence is insufficient, report the limitation honestly."
)


def build_response(payload: dict) -> dict | None:
    tool_name = payload.get("tool_name", "")
    if tool_name not in TARGET_TOOLS:
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
