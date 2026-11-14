"""Tests for krn-search health command."""

import json
import os
import stat
from pathlib import Path
from unittest.mock import patch

from search_tool.health import HealthCheck, HealthReport, check_searxng_reachable, run_health_checks, wait_for_searxng_reachable
from search_tool.cli import main


class TestHealthCheck:
    def test_fields(self):
        c = HealthCheck(name="test", status="ok", message="all good")
        assert c.name == "test"
        assert c.status == "ok"
        assert c.message == "all good"


class TestHealthReport:
    def test_overall_all_ok(self):
        checks = (
            HealthCheck(name="a", status="ok", message="a"),
            HealthCheck(name="b", status="ok", message="b"),
        )
        assert HealthReport(schema_version="0.1", checks=checks).overall_status() == "ok"

    def test_overall_info_counts_as_ok(self):
        checks = (
            HealthCheck(name="a", status="ok", message="a"),
            HealthCheck(name="b", status="info", message="b"),
        )
        assert HealthReport(schema_version="0.1", checks=checks).overall_status() == "ok"

    def test_overall_warn_is_degraded(self):
        checks = (
            HealthCheck(name="a", status="ok", message="a"),
            HealthCheck(name="b", status="warn", message="b"),
        )
        assert HealthReport(schema_version="0.1", checks=checks).overall_status() == "degraded"

    def test_overall_fail_is_fail(self):
        checks = (
            HealthCheck(name="a", status="ok", message="a"),
            HealthCheck(name="b", status="fail", message="b"),
        )
        assert HealthReport(schema_version="0.1", checks=checks).overall_status() == "fail"

    def test_to_json_valid(self):
        checks = (HealthCheck(name="a", status="ok", message="a"),)
        report = HealthReport(schema_version="0.1", checks=checks)
        parsed = json.loads(report.to_json())
        assert parsed["schema_version"] == "0.1"
        assert parsed["overall"] == "ok"
        assert len(parsed["checks"]) == 1

    def test_to_human_format(self):
        checks = (
            HealthCheck(name="import", status="ok", message="ok"),
            HealthCheck(name="searxng", status="warn", message="unreachable"),
        )
        report = HealthReport(schema_version="0.1", checks=checks)
        human = report.to_human()
        assert "krn-search health:" in human
        assert "import" in human
        assert "searxng" in human


class TestCheckSearxngReachable:
    """Tests for check_searxng_reachable using sys.modules mock."""

    def _mock_httpx(self):
        """Return a mock httpx module and install it in sys.modules."""
        import types
        import sys
        mock_httpx = types.ModuleType("httpx")
        mock_httpx.Client = lambda *a, **kw: _MockClient()
        sys.modules["httpx"] = mock_httpx
        return mock_httpx

    def test_reachable(self):
        import sys
        old = sys.modules.get("httpx")
        try:
            mock = self._mock_httpx()
            mock.Client = lambda *a, **kw: _MockClient(status_code=200)
            assert check_searxng_reachable("http://localhost:9999") is True
        finally:
            if old is not None:
                sys.modules["httpx"] = old
            else:
                sys.modules.pop("httpx", None)

    def test_unreachable(self):
        import httpx
        import sys
        old = sys.modules.get("httpx")
        try:
            self._mock_httpx()
            # Re-import to get ConnectError
            real_httpx = old or __import__("httpx", fromlist=["ConnectError"])
            httpx.ConnectError = real_httpx.ConnectError
            sys.modules["httpx"].ConnectError = real_httpx.ConnectError
            sys.modules["httpx"].Client = lambda *a, **kw: _MockClient(exception=real_httpx.ConnectError("refused"))
            assert check_searxng_reachable("http://localhost:9999") is False
        finally:
            if old is not None:
                sys.modules["httpx"] = old
            else:
                sys.modules.pop("httpx", None)

    def test_timeout(self):
        import httpx
        import sys
        old = sys.modules.get("httpx")
        try:
            self._mock_httpx()
            real_httpx = old or __import__("httpx", fromlist=["TimeoutException"])
            sys.modules["httpx"].TimeoutException = real_httpx.TimeoutException
            sys.modules["httpx"].Client = lambda *a, **kw: _MockClient(exception=real_httpx.TimeoutException("timeout"))
            assert check_searxng_reachable("http://localhost:9999") is False
        finally:
            if old is not None:
                sys.modules["httpx"] = old
            else:
                sys.modules.pop("httpx", None)

    def test_non_200_status(self):
        import sys
        old = sys.modules.get("httpx")
        try:
            self._mock_httpx()
            sys.modules["httpx"].Client = lambda *a, **kw: _MockClient(status_code=503)
            assert check_searxng_reachable("http://localhost:9999") is False
        finally:
            if old is not None:
                sys.modules["httpx"] = old
            else:
                sys.modules.pop("httpx", None)

    def test_retries_transient_startup_failures(self):
        import sys
        old = sys.modules.get("httpx")
        calls = []

        class FlakyClient(_MockClient):
            def post(self, *a, **kw):
                calls.append(kw)
                if len(calls) < 3:
                    return type("R", (), {"status_code": 503})()
                return type("R", (), {"status_code": 200})()

        try:
            self._mock_httpx()
            sys.modules["httpx"].Client = lambda *a, **kw: FlakyClient()
            assert check_searxng_reachable("http://localhost:9999", retries=3, retry_delay=0) is True
            assert len(calls) == 3
        finally:
            if old is not None:
                sys.modules["httpx"] = old
            else:
                sys.modules.pop("httpx", None)


class _MockClient:
    def __init__(self, status_code=200, exception=None):
        self._status_code = status_code
        self._exception = exception

    def __enter__(self):
        return self

    def __exit__(self, *args):
        pass

    def post(self, *a, **kw):
        if self._exception:
            raise self._exception
        return type("R", (), {"status_code": self._status_code})()


class TestWaitForSearxngReachable:
    def test_wait_succeeds_after_delayed_reachability(self, monkeypatch):
        clock = {"now": 0.0}
        calls = []

        def fake_check(url: str, **kwargs) -> bool:
            calls.append((url, kwargs))
            return len(calls) == 3

        def fake_sleep(seconds: float) -> None:
            clock["now"] += seconds

        monkeypatch.setattr("search_tool.health.check_searxng_reachable", fake_check)
        monkeypatch.setattr("search_tool.health.time.monotonic", lambda: clock["now"])
        monkeypatch.setattr("search_tool.health.time.sleep", fake_sleep)

        assert wait_for_searxng_reachable("http://localhost:9999", 10, poll_interval=0.5) is True
        assert [call[0] for call in calls] == [
            "http://localhost:9999",
            "http://localhost:9999",
            "http://localhost:9999",
        ]
        assert all(call[1] == {"retries": 1, "retry_delay": 0} for call in calls)

    def test_wait_times_out_when_always_unreachable(self, monkeypatch):
        clock = {"now": 0.0}
        calls = []

        def fake_check(url: str, **kwargs) -> bool:
            calls.append((url, kwargs))
            return False

        def fake_sleep(seconds: float) -> None:
            clock["now"] += seconds

        monkeypatch.setattr("search_tool.health.check_searxng_reachable", fake_check)
        monkeypatch.setattr("search_tool.health.time.monotonic", lambda: clock["now"])
        monkeypatch.setattr("search_tool.health.time.sleep", fake_sleep)

        assert wait_for_searxng_reachable("http://localhost:9999", 1, poll_interval=0.4) is False
        assert len(calls) == 4
        assert all(call[1] == {"retries": 1, "retry_delay": 0} for call in calls)


class TestRunHealthChecks:
    def test_package_import_ok(self):
        report = run_health_checks(work_dir=Path("/tmp"))
        import_check = next(c for c in report.checks if c.name == "package_import")
        assert import_check.status == "ok"

    def test_static_provider_ok(self):
        report = run_health_checks(work_dir=Path("/tmp"))
        provider_check = next(c for c in report.checks if c.name == "static_provider")
        assert provider_check.status == "ok"

    def test_searxng_not_configured_checks_default_localhost(self):
        env = os.environ.pop("SEARXNG_URL", None)
        try:
            with patch("search_tool.health.check_searxng_reachable", return_value=True) as check:
                report = run_health_checks(work_dir=Path("/tmp"))
        finally:
            if env is not None:
                os.environ["SEARXNG_URL"] = env
        searxng_check = next(c for c in report.checks if c.name == "searxng_reachable")
        assert searxng_check.status == "ok"
        assert "default" in searxng_check.message
        check.assert_called_once_with("http://localhost:9999")

    def test_searxng_not_configured_and_default_unreachable_is_info(self):
        env = os.environ.pop("SEARXNG_URL", None)
        try:
            with patch("search_tool.health.check_searxng_reachable", return_value=False):
                report = run_health_checks(work_dir=Path("/tmp"))
        finally:
            if env is not None:
                os.environ["SEARXNG_URL"] = env
        searxng_check = next(c for c in report.checks if c.name == "searxng_reachable")
        assert searxng_check.status == "info"
        assert "default SearXNG unreachable" in searxng_check.message

    def test_searxng_configured_reachable(self):
        with patch("search_tool.health.check_searxng_reachable", return_value=True):
            os.environ["SEARXNG_URL"] = "http://localhost:9999"
            try:
                report = run_health_checks(work_dir=Path("/tmp"))
            finally:
                os.environ.pop("SEARXNG_URL", None)
        searxng_check = next(c for c in report.checks if c.name == "searxng_reachable")
        assert searxng_check.status == "ok"

    def test_searxng_configured_unreachable(self):
        with patch("search_tool.health.check_searxng_reachable", return_value=False):
            os.environ["SEARXNG_URL"] = "http://localhost:9999"
            try:
                report = run_health_checks(work_dir=Path("/tmp"))
            finally:
                os.environ.pop("SEARXNG_URL", None)
        searxng_check = next(c for c in report.checks if c.name == "searxng_reachable")
        assert searxng_check.status == "warn"
        assert "unreachable" in searxng_check.message

    def test_research_wait_uses_wait_helper(self):
        with patch("search_tool.health.wait_for_searxng_reachable", return_value=True) as wait:
            report = run_health_checks(
                work_dir=Path("/tmp"),
                research_mode=True,
                searxng_url_override="http://override.local:9999",
                searxng_wait_seconds=10,
            )

        wait.assert_called_once_with("http://override.local:9999", 10)
        searxng_check = next(c for c in report.checks if c.name == "searxng_reachable")
        assert searxng_check.status == "ok"

    def test_evidence_dir_writable(self, tmp_path):
        (tmp_path / "evidence").mkdir()
        report = run_health_checks(work_dir=tmp_path)
        evidence_check = next(c for c in report.checks if "evidence" in c.name)
        assert evidence_check.status == "ok"

    def test_cache_dir_writable(self, tmp_path):
        (tmp_path / "cache" / "objects").mkdir(parents=True)
        report = run_health_checks(work_dir=tmp_path)
        cache_check = next(c for c in report.checks if "objects" in c.name)
        assert cache_check.status == "ok"

    def test_dir_not_writable_fail(self, tmp_path):
        read_only = tmp_path / "cache" / "objects"
        read_only.mkdir(parents=True)
        read_only.chmod(stat.S_IRUSR | stat.S_IXUSR)
        report = run_health_checks(work_dir=tmp_path)
        cache_check = next((c for c in report.checks if "objects" in c.name), None)
        if cache_check:
            assert cache_check.status == "fail"

    def test_dir_not_exist_info(self, tmp_path):
        report = run_health_checks(work_dir=tmp_path / "nonexistent")
        evidence_check = next(c for c in report.checks if "evidence" in c.name)
        assert evidence_check.status == "info"


class TestHealthCli:
    def test_health_without_research_keeps_default_behavior(self, capsys, monkeypatch):
        monkeypatch.setattr("search_tool.health.check_searxng_reachable", lambda *args, **kwargs: False)
        rc = main(["health"])
        captured = capsys.readouterr()
        assert rc == 0
        assert "krn-search health:" in captured.out
        assert "default SearXNG unreachable" in captured.out
        assert "optional, static provider works" in captured.out

    def test_health_research_unreachable_is_error_status(self, capsys, monkeypatch):
        monkeypatch.setattr("search_tool.health.check_searxng_reachable", lambda *args, **kwargs: False)
        rc = main(["health", "--research"])
        captured = capsys.readouterr()
        assert rc != 0
        assert "research mode requires SearXNG discovery" in captured.out
        assert not captured.err
        assert "krn-search health: fail" in captured.out

    def test_health_research_json_marks_overall_fail(self, capsys, monkeypatch):
        monkeypatch.setattr("search_tool.health.check_searxng_reachable", lambda *args, **kwargs: False)
        rc = main(["health", "--research", "--json"])
        captured = capsys.readouterr()
        assert rc != 0
        assert not captured.err
        parsed = json.loads(captured.out)
        assert parsed["overall"] == "fail"
        searxng_check = next(c for c in parsed["checks"] if c["name"] == "searxng_reachable")
        assert searxng_check["status"] == "fail"
        assert "research mode requires SearXNG discovery" in searxng_check["message"]

    def test_health_research_wait_succeeds_after_delayed_reachability(self, capsys, monkeypatch):
        clock = {"now": 0.0}
        calls = []

        def fake_check(url: str, **kwargs) -> bool:
            calls.append((url, kwargs))
            return len(calls) == 3

        def fake_sleep(seconds: float) -> None:
            clock["now"] += seconds

        monkeypatch.setattr("search_tool.health.check_searxng_reachable", fake_check)
        monkeypatch.setattr("search_tool.health.time.monotonic", lambda: clock["now"])
        monkeypatch.setattr("search_tool.health.time.sleep", fake_sleep)

        rc = main(["health", "--research", "--wait", "10"])
        captured = capsys.readouterr()

        assert rc == 0
        assert "krn-search health: ok" in captured.out
        assert len(calls) == 3
        assert all(call[1] == {"retries": 1, "retry_delay": 0} for call in calls)

    def test_health_research_wait_times_out(self, capsys, monkeypatch):
        clock = {"now": 0.0}
        calls = []

        def fake_check(url: str, **kwargs) -> bool:
            calls.append((url, kwargs))
            return False

        def fake_sleep(seconds: float) -> None:
            clock["now"] += seconds

        monkeypatch.setattr("search_tool.health.check_searxng_reachable", fake_check)
        monkeypatch.setattr("search_tool.health.time.monotonic", lambda: clock["now"])
        monkeypatch.setattr("search_tool.health.time.sleep", fake_sleep)

        rc = main(["health", "--research", "--wait", "1"])
        captured = capsys.readouterr()

        assert rc != 0
        assert "krn-search health: fail" in captured.out
        assert "research mode requires SearXNG discovery" in captured.out
        assert len(calls) == 3

    def test_health_research_json_wait_reports_valid_ok(self, capsys, monkeypatch):
        clock = {"now": 0.0}
        calls = []

        def fake_check(url: str, **kwargs) -> bool:
            calls.append(url)
            return len(calls) == 2

        def fake_sleep(seconds: float) -> None:
            clock["now"] += seconds

        monkeypatch.setattr("search_tool.health.check_searxng_reachable", fake_check)
        monkeypatch.setattr("search_tool.health.time.monotonic", lambda: clock["now"])
        monkeypatch.setattr("search_tool.health.time.sleep", fake_sleep)

        rc = main(["health", "--research", "--json", "--wait", "10"])
        captured = capsys.readouterr()
        parsed = json.loads(captured.out)

        assert rc == 0
        assert parsed["overall"] == "ok"
        searxng_check = next(c for c in parsed["checks"] if c["name"] == "searxng_reachable")
        assert searxng_check["status"] == "ok"

    def test_health_research_wait_zero_matches_immediate_check(self, capsys, monkeypatch):
        calls = []

        def fake_check(url: str, **kwargs) -> bool:
            calls.append((url, kwargs))
            return False

        monkeypatch.setattr("search_tool.health.check_searxng_reachable", fake_check)

        rc = main(["health", "--research", "--wait", "0"])
        captured = capsys.readouterr()

        assert rc != 0
        assert "krn-search health: fail" in captured.out
        assert calls == [("http://localhost:9999", {})]

    def test_health_research_reachable_returns_zero(self, capsys, monkeypatch):
        monkeypatch.setattr("search_tool.health.check_searxng_reachable", lambda *args, **kwargs: True)
        rc = main(["health", "--research"])
        captured = capsys.readouterr()
        assert rc == 0
        assert "krn-search health: ok" in captured.out

    def test_health_research_searxng_url_override_is_used(self, capsys, monkeypatch):
        calls = []

        def fake_check(url: str) -> bool:
            calls.append(url)
            return url == "http://override.local:9999"

        monkeypatch.setenv("SEARXNG_URL", "http://env-only:9999")
        monkeypatch.setattr("search_tool.health.check_searxng_reachable", fake_check)
        rc = main(["health", "--research", "--searxng-url", "http://override.local:9999"])
        captured = capsys.readouterr()
        assert rc == 0
        assert calls == ["http://override.local:9999"]
        assert "SearXNG reachable at http://override.local:9999" in captured.out
        assert "source: --searxng-url" in captured.out
        assert "optional, static provider works" not in captured.out
