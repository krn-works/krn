import importlib.util
import json
import subprocess
import sys

HOOK = ".claude/hooks/candidate_url_static_guard.py"


def _import_build_response():
    spec = importlib.util.spec_from_file_location("candidate_guard", HOOK)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod.build_response


def _run_hook(payload: dict) -> str:
    result = subprocess.run(
        [sys.executable, HOOK],
        input=json.dumps(payload),
        capture_output=True,
        text=True,
        timeout=5,
    )
    return result.stdout


class TestBuildResponse:
    def setup_method(self):
        self.build_response = _import_build_response()

    def test_denies_static_candidate_url_search_without_marker(self):
        resp = self.build_response({
            "tool_name": "Bash",
            "tool_input": {
                "command": 'krn-search search-query "q" --provider static --candidate-url "https://example.com"'
            },
        })
        assert resp is not None
        assert resp["hookSpecificOutput"]["permissionDecision"] == "deny"

    def test_allows_static_candidate_url_search_with_marker(self):
        resp = self.build_response({
            "tool_name": "Bash",
            "tool_input": {
                "command": 'KRN_SEARCH_ALLOW_EXACT_URLS=1 krn-search search-query "q" --provider static --candidate-url "https://example.com"'
            },
        })
        assert resp is None

    def test_ignores_non_static_search(self):
        resp = self.build_response({
            "tool_name": "Bash",
            "tool_input": {"command": 'krn-search search-query "q" --research'},
        })
        assert resp is None

    def test_ignores_non_bash(self):
        resp = self.build_response({"tool_name": "Read"})
        assert resp is None


class TestHookStdinIntegration:
    def test_json_valid(self):
        stdout = _run_hook({
            "hook_event_name": "PreToolUse",
            "tool_name": "Bash",
            "tool_input": {
                "command": 'krn-search search-query "q" --provider static --candidate-url "https://example.com"'
            },
        })
        parsed = json.loads(stdout)
        assert parsed["hookSpecificOutput"]["permissionDecision"] == "deny"
        reason = parsed["hookSpecificOutput"]["permissionDecisionReason"]
        assert "Do not invent" in reason
        assert "KRN_SEARCH_ALLOW_EXACT_URLS=1" in reason

