import importlib.util
import json
import subprocess
import sys

HOOK = ".claude/hooks/websearch_krn_search_guard.py"


def _import_build_response():
    spec = importlib.util.spec_from_file_location("guard", HOOK)
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


def _run_hook_raw(data: str) -> tuple[str, str, int]:
    result = subprocess.run(
        [sys.executable, HOOK],
        input=data,
        capture_output=True,
        text=True,
        timeout=5,
    )
    return result.stdout, result.stderr, result.returncode


class TestBuildResponse:
    def setup_method(self):
        self.build_response = _import_build_response()

    def test_websearch_returns_deny(self):
        resp = self.build_response({"tool_name": "WebSearch"})
        assert resp is not None
        assert resp["hookSpecificOutput"]["permissionDecision"] == "deny"

    def test_webfetch_returns_deny(self):
        resp = self.build_response({"tool_name": "WebFetch"})
        assert resp is not None
        assert resp["hookSpecificOutput"]["permissionDecision"] == "deny"

    def test_bash_returns_none(self):
        resp = self.build_response({"tool_name": "Bash"})
        assert resp is None

    def test_read_returns_none(self):
        resp = self.build_response({"tool_name": "Read"})
        assert resp is None

    def test_empty_dict_returns_none(self):
        resp = self.build_response({})
        assert resp is None

    def test_no_tool_name_returns_none(self):
        resp = self.build_response({"hook_event_name": "PreToolUse"})
        assert resp is None

    def test_reason_contains_slash_command(self):
        resp = self.build_response({"tool_name": "WebSearch"})
        assert "/krn-search-research" in resp["hookSpecificOutput"]["permissionDecisionReason"]

    def test_no_deprecated_decision_field(self):
        resp = self.build_response({"tool_name": "WebSearch"})
        assert "decision" not in resp
        assert "reason" not in resp

    def test_no_continue_field(self):
        resp = self.build_response({"tool_name": "WebSearch"})
        assert "continue" not in resp


class TestHookStdinIntegration:
    def test_websearch_json_valid(self):
        stdout = _run_hook({
            "hook_event_name": "PreToolUse",
            "tool_name": "WebSearch",
            "tool_input": {"query": "test"},
        })
        parsed = json.loads(stdout)
        assert parsed["hookSpecificOutput"]["permissionDecision"] == "deny"

    def test_webfetch_json_valid(self):
        stdout = _run_hook({
            "hook_event_name": "PreToolUse",
            "tool_name": "WebFetch",
            "tool_input": {"url": "https://example.com"},
        })
        parsed = json.loads(stdout)
        assert parsed["hookSpecificOutput"]["permissionDecision"] == "deny"

    def test_bash_no_output(self):
        stdout = _run_hook({
            "hook_event_name": "PreToolUse",
            "tool_name": "Bash",
            "tool_input": {"command": "echo ok"},
        })
        assert stdout.strip() == ""

    def test_malformed_json_safe(self):
        stdout, stderr, code = _run_hook_raw("not json {{{")
        assert stdout.strip() == ""
        assert code == 0

    def test_empty_stdin_safe(self):
        stdout, stderr, code = _run_hook_raw("")
        assert stdout.strip() == ""
        assert code == 0

    def test_hook_event_name_present_in_output(self):
        stdout = _run_hook({
            "hook_event_name": "PreToolUse",
            "tool_name": "WebSearch",
        })
        parsed = json.loads(stdout)
        assert parsed["hookSpecificOutput"]["hookEventName"] == "PreToolUse"

    def test_reason_contains_do_not_retry(self):
        stdout = _run_hook({
            "hook_event_name": "PreToolUse",
            "tool_name": "WebSearch",
            "tool_input": {"query": "test"},
        })
        parsed = json.loads(stdout)
        reason = parsed["hookSpecificOutput"]["permissionDecisionReason"]
        assert "Do not retry" in reason

    def test_reason_contains_krn_search_commands(self):
        stdout = _run_hook({
            "hook_event_name": "PreToolUse",
            "tool_name": "WebSearch",
            "tool_input": {"query": "test"},
        })
        parsed = json.loads(stdout)
        reason = parsed["hookSpecificOutput"]["permissionDecisionReason"]
        assert "krn-search search-query" in reason
        assert "--research" in reason
        assert "<user-provided-or-known-url>" in reason

    def test_reason_does_not_mention_websearch_approval(self):
        stdout = _run_hook({
            "hook_event_name": "PreToolUse",
            "tool_name": "WebSearch",
            "tool_input": {"query": "test"},
        })
        parsed = json.loads(stdout)
        reason = parsed["hookSpecificOutput"]["permissionDecisionReason"]
        assert "WebSearch approval" not in reason

    def test_reason_contains_fetch_url(self):
        stdout = _run_hook({
            "hook_event_name": "PreToolUse",
            "tool_name": "WebSearch",
            "tool_input": {"query": "test"},
        })
        parsed = json.loads(stdout)
        reason = parsed["hookSpecificOutput"]["permissionDecisionReason"]
        assert "krn-search fetch-url" in reason

    def test_reason_does_not_lead_with_manual_searxng_flags(self):
        stdout = _run_hook({
            "hook_event_name": "PreToolUse",
            "tool_name": "WebSearch",
            "tool_input": {"query": "test"},
        })
        parsed = json.loads(stdout)
        reason = parsed["hookSpecificOutput"]["permissionDecisionReason"]
        assert "--provider searxng --searxng-url <url>" not in reason
        assert "Do not invent URLs" in reason

    def test_reason_contains_slash_command_alternative(self):
        stdout = _run_hook({
            "hook_event_name": "PreToolUse",
            "tool_name": "WebSearch",
            "tool_input": {"query": "test"},
        })
        parsed = json.loads(stdout)
        reason = parsed["hookSpecificOutput"]["permissionDecisionReason"]
        assert "/krn-search-research" in reason
