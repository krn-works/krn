"""Tests for PostToolUse contract-hardening smoke hook."""

import importlib.util
import json
import subprocess
import sys
from io import StringIO
from unittest.mock import patch

HOOK = ".claude/hooks/postcommit_contract_check.py"


def _import_main():
    spec = importlib.util.spec_from_file_location("postcommit_check", HOOK)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod.main


class TestPostCommitHookStdin:
    """Tests that run the hook as a subprocess with stdin."""

    def test_non_commit_command_silent(self):
        result = subprocess.run(
            [sys.executable, HOOK],
            input=json.dumps({"hook_event_name": "PostToolUse", "tool_name": "Bash", "tool_input": {"command": "echo hello"}}),
            capture_output=True, text=True, timeout=5,
        )
        assert result.returncode == 0
        assert "contract-check" not in result.stderr

    def test_git_commit_shows_test_suggestion(self):
        result = subprocess.run(
            [sys.executable, HOOK],
            input=json.dumps({"hook_event_name": "PostToolUse", "tool_name": "Bash", "tool_input": {"command": "git commit -m \"test\""}}),
            capture_output=True, text=True, timeout=5,
        )
        assert result.returncode == 0
        assert "contract-check" in result.stderr
        assert "pytest" in result.stderr

    def test_malformed_json_safe(self):
        result = subprocess.run(
            [sys.executable, HOOK], input="not json {{{",
            capture_output=True, text=True, timeout=5,
        )
        assert result.returncode == 0

    def test_empty_stdin_safe(self):
        result = subprocess.run(
            [sys.executable, HOOK], input="",
            capture_output=True, text=True, timeout=5,
        )
        assert result.returncode == 0


class TestPostCommitHookLogic:
    """Tests that directly test hook logic by mocking subprocess calls."""

    def test_git_commit_non_feat_no_docs_warning(self):
        main = _import_main()
        mock_run_results = {
            "diff": type("R", (), {"stdout": "search_tool/foo.py", "returncode": 0})(),
            "log": type("R", (), {"stdout": "fix: update something", "returncode": 0})(),
        }
        def mock_run(cmd, **kwargs):
            if "diff" in cmd:
                return mock_run_results["diff"]
            elif "log" in cmd:
                return mock_run_results["log"]
            return type("R", (), {"stdout": "", "returncode": 0})()

        payload = json.dumps({"hook_event_name": "PostToolUse", "tool_name": "Bash", "tool_input": {"command": "git commit -m \"fix: something\""}})
        with patch("sys.stdin", StringIO(payload)), patch("subprocess.run", mock_run), patch("sys.stderr", StringIO()) as mock_err:
            main()
            output = mock_err.getvalue()
            assert "contract-check" in output
            assert "without docs" not in output

    def test_git_commit_feat_without_docs_warns(self):
        main = _import_main()
        def mock_run(cmd, **kwargs):
            if "diff" in cmd:
                return type("R", (), {"stdout": "search_tool/foo.py", "returncode": 0})()
            elif "log" in cmd:
                return type("R", (), {"stdout": "feat: add new feature", "returncode": 0})()
            return type("R", (), {"stdout": "", "returncode": 0})()

        payload = json.dumps({"hook_event_name": "PostToolUse", "tool_name": "Bash", "tool_input": {"command": "git commit -m \"feat: add new feature\""}})
        with patch("sys.stdin", StringIO(payload)), patch("subprocess.run", mock_run), patch("sys.stderr", StringIO()) as mock_err:
            main()
            output = mock_err.getvalue()
            assert "WARNING" in output
            assert "without docs" in output

    def test_git_commit_feat_with_docs_no_warning(self):
        main = _import_main()
        def mock_run(cmd, **kwargs):
            if "diff" in cmd:
                return type("R", (), {"stdout": "search_tool/foo.py\nnotes/MVP1G0_SOMETHING.md", "returncode": 0})()
            elif "log" in cmd:
                return type("R", (), {"stdout": "feat: add new feature", "returncode": 0})()
            return type("R", (), {"stdout": "", "returncode": 0})()

        payload = json.dumps({"hook_event_name": "PostToolUse", "tool_name": "Bash", "tool_input": {"command": "git commit -m \"feat: add new feature\""}})
        with patch("sys.stdin", StringIO(payload)), patch("subprocess.run", mock_run), patch("sys.stderr", StringIO()) as mock_err:
            main()
            output = mock_err.getvalue()
            assert "without docs" not in output

    def test_sensitive_files_changed_shows_checklist(self):
        main = _import_main()
        def mock_run(cmd, **kwargs):
            if "diff" in cmd:
                return type("R", (), {"stdout": "search_tool/evidence.py\nsearch_tool/search.py", "returncode": 0})()
            elif "log" in cmd:
                return type("R", (), {"stdout": "fix: update evidence", "returncode": 0})()
            return type("R", (), {"stdout": "", "returncode": 0})()

        payload = json.dumps({"hook_event_name": "PostToolUse", "tool_name": "Bash", "tool_input": {"command": "git commit -m \"fix: update evidence\""}})
        with patch("sys.stdin", StringIO(payload)), patch("subprocess.run", mock_run), patch("sys.stderr", StringIO()) as mock_err:
            main()
            output = mock_err.getvalue()
            assert "Contract-sensitive files changed" in output
            assert "evidence.py" in output

    def test_hook_never_raises(self):
        main = _import_main()
        payload = json.dumps({"hook_event_name": "PostToolUse", "tool_name": "Bash", "tool_input": {"command": "git commit -m \"test\""}})
        with patch("sys.stdin", StringIO(payload)), patch("subprocess.run", side_effect=OSError("git not found")), patch("sys.stderr", StringIO()):
            main()  # should not raise
