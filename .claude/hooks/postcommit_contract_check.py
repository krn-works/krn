"""PostToolUse hook: contract-hardening warnings after git commit.

Installation (manual):
Add to .claude/settings.local.json under hooks.PostToolUse:
  {
    "matcher": "Bash",
    "hooks": [{ "type": "command", "command": "python .claude/hooks/postcommit_contract_check.py" }]
  }

Warning mode only — never blocks commits.
"""

import json
import re
import subprocess
import sys

_COMMIT_RE = re.compile(r"\bgit\s+commit\b")

SENSITIVE_FILES = frozenset({
    "search_tool/evidence.py",
    "search_tool/cache.py",
    "search_tool/search.py",
    "search_tool/discovery.py",
    "search_tool/url_policy.py",
})


def main() -> None:
    try:
        raw = sys.stdin.read()
        if not raw.strip():
            return
        payload = json.loads(raw)
    except (json.JSONDecodeError, UnicodeDecodeError):
        return

    tool_input = payload.get("tool_input", {})
    command = tool_input.get("command", "")

    if not _COMMIT_RE.search(command):
        return

    # Check 1: suggest fail-fast tests
    print(
        "[contract-check] Suggested: python -m pytest tests/ -x -q",
        file=sys.stderr,
    )

    try:
        staged = subprocess.run(
            ["git", "diff", "--cached", "--name-only"],
            capture_output=True,
            text=True,
            timeout=5,
        ).stdout.strip().splitlines()

        commit_subject = subprocess.run(
            ["git", "log", "-1", "--format=%s"],
            capture_output=True,
            text=True,
            timeout=5,
        ).stdout.strip()
    except Exception:
        return

    # Check 2: feature commit without docs
    if commit_subject.lower().startswith("feat:"):
        docs_files = [f for f in staged if f.startswith("notes/") or f == "CLAUDE.md"]
        if not docs_files:
            print(
                "[contract-check] WARNING: feature commit without docs/notes update",
                file=sys.stderr,
            )

    # Check 3: contract-sensitive files changed
    changed_sensitive = SENSITIVE_FILES.intersection(set(staged))
    if changed_sensitive:
        files_str = ", ".join(sorted(changed_sensitive))
        print(
            f"[contract-check] Contract-sensitive files changed: {files_str}",
            file=sys.stderr,
        )
        print(
            "[contract-check] Verify: evidence schema, manifest schema, cache behavior, path isolation, no secrets in output",
            file=sys.stderr,
        )


if __name__ == "__main__":
    main()
