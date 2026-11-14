"""Tests for local SearXNG operator bootstrap helpers."""

from __future__ import annotations

from subprocess import CompletedProcess

import pytest

from search_tool.cli import main
from search_tool.searxng import (
    CONTAINER_NAME,
    HOST_BIND,
    HOST_URL,
    SearxngOperatorError,
    ensure_local_searxng,
    patch_settings_yaml,
    probe_status,
    runtime_dir,
    stop_local_searxng,
)


SAMPLE_SETTINGS = """\
search:
  safe_search: 0
  formats:
    - html

server:
  port: 8888
  bind_address: "127.0.0.1"
  secret_key: "ultrasecretkey"  # Is overwritten by ${SEARXNG_SECRET}
"""


def test_patch_settings_yaml_enables_json_and_non_default_secret():
    patched = patch_settings_yaml(SAMPLE_SETTINGS, secret_key="not-default")
    assert "    - html\n    - json\n" in patched
    assert '  port: 8080\n' in patched
    assert '  bind_address: "0.0.0.0"\n' in patched
    assert '  secret_key: "not-default"  # Is overwritten by ${SEARXNG_SECRET}\n' in patched
    assert 'secret_key: "ultrasecretkey"' not in patched


def test_patch_settings_yaml_inserts_missing_formats_block():
    source = "search:\n  safe_search: 0\n\nserver:\n  port: 8888\n"
    patched = patch_settings_yaml(source, secret_key="abc123")
    assert "  formats:\n    - html\n    - json\n" in patched
    assert '  secret_key: "abc123"\n' in patched


def test_runtime_dir_prefers_xdg_cache_home(monkeypatch, tmp_path):
    monkeypatch.setenv("XDG_CACHE_HOME", str(tmp_path))
    assert runtime_dir() == tmp_path / "krn-search" / "searxng"


def test_ensure_runtime_dir_falls_back_when_primary_not_writable(monkeypatch, tmp_path):
    blocked = tmp_path / "blocked"
    fallback = tmp_path / "fallback"

    monkeypatch.setattr("search_tool.searxng.runtime_dir", lambda: blocked)

    def fake_mkdir(self, parents=False, exist_ok=False):
        raise PermissionError("blocked")

    monkeypatch.setattr(type(blocked), "mkdir", fake_mkdir)
    monkeypatch.setattr("search_tool.searxng.tempfile.mkdtemp", lambda prefix: str(fallback))

    from search_tool.searxng import _ensure_runtime_dir

    assert _ensure_runtime_dir() == fallback


def test_probe_status_reports_unreachable():
    status = probe_status("http://127.0.0.1:9")
    assert status.ready is False
    assert "unreachable" in status.reason


def test_cli_status_returns_failure_on_unreachable(monkeypatch, capsys):
    monkeypatch.setattr(
        "search_tool.searxng.probe_status",
        lambda: type("S", (), {"ready": False, "reason": "unreachable", "url": "http://localhost:9999"})(),
    )
    exit_code = main(["searxng", "status"])
    captured = capsys.readouterr()
    assert exit_code == 1
    assert "unreachable" in captured.err


def test_stop_local_searxng_only_targets_expected_container(monkeypatch):
    calls: list[list[str]] = []

    def fake_run(args, *, check=True):
        calls.append(list(args))
        if args[:3] == ["docker", "ps", "-a"]:
            return CompletedProcess(args, 0, "running\n", "")
        if args[:3] == ["docker", "rm", "-f"]:
            return CompletedProcess(args, 0, "removed", "")
        if args[:2] == ["docker", "--version"]:
            return CompletedProcess(args, 0, "Docker version", "")
        raise AssertionError(args)

    monkeypatch.setattr("search_tool.searxng._run_command", fake_run)
    message = stop_local_searxng()
    assert message == f"Removed {CONTAINER_NAME}"
    assert ["docker", "rm", "-f", CONTAINER_NAME] in calls
    assert all(call[-1] == CONTAINER_NAME for call in calls if call[:3] == ["docker", "rm", "-f"])


def test_stop_local_searxng_reports_missing_container(monkeypatch):
    def fake_run(args, *, check=True):
        if args[:3] == ["docker", "ps", "-a"]:
            return CompletedProcess(args, 0, "", "")
        if args[:2] == ["docker", "--version"]:
            return CompletedProcess(args, 0, "Docker version", "")
        raise AssertionError(args)

    monkeypatch.setattr("search_tool.searxng._run_command", fake_run)
    assert stop_local_searxng() == f"{CONTAINER_NAME} not present"


def test_ensure_local_searxng_starts_container_and_waits_for_health(monkeypatch, tmp_path):
    calls: list[list[str]] = []

    class FakeReport:
        def overall_status(self):
            return "ok"

        def to_human(self):
            return "krn-search health: ok"

    def fake_run(args, *, check=True):
        calls.append(list(args))
        return CompletedProcess(args, 0, "started", "")

    monkeypatch.setattr("search_tool.searxng.probe_status", lambda base_url=HOST_URL: type("S", (), {"ready": False})())
    monkeypatch.setattr("search_tool.searxng._require_docker", lambda: None)
    monkeypatch.setattr("search_tool.searxng._container_state", lambda name: None)
    monkeypatch.setattr("search_tool.searxng.runtime_dir", lambda: tmp_path)
    monkeypatch.setattr("search_tool.searxng._read_default_settings_from_image", lambda: SAMPLE_SETTINGS)
    monkeypatch.setattr("search_tool.searxng._run_command", fake_run)
    monkeypatch.setattr("search_tool.searxng.run_health_checks", lambda **kwargs: FakeReport())

    message = ensure_local_searxng(wait_seconds=12)
    assert message == f"SearXNG ready at {HOST_URL}"
    settings = (tmp_path / "settings.yml").read_text(encoding="utf-8")
    assert '  bind_address: "0.0.0.0"\n' in settings
    assert '  port: 8080\n' in settings
    assert 'secret_key: "ultrasecretkey"' not in settings
    assert ["docker", "run", "-d", "--name", CONTAINER_NAME, "-v", f"{tmp_path}:/etc/searxng", "-p", f"{HOST_BIND}:9999:8080", "searxng/searxng:latest"] in calls


def test_ensure_local_searxng_recreates_existing_container(monkeypatch, tmp_path):
    removed: list[str] = []

    class FakeReport:
        def overall_status(self):
            return "ok"

        def to_human(self):
            return "krn-search health: ok"

    monkeypatch.setattr("search_tool.searxng.probe_status", lambda base_url=HOST_URL: type("S", (), {"ready": False})())
    monkeypatch.setattr("search_tool.searxng._require_docker", lambda: None)
    monkeypatch.setattr("search_tool.searxng._container_state", lambda name: "running")
    monkeypatch.setattr("search_tool.searxng._remove_container", lambda name: removed.append(name))
    monkeypatch.setattr("search_tool.searxng.runtime_dir", lambda: tmp_path)
    monkeypatch.setattr("search_tool.searxng._read_default_settings_from_image", lambda: SAMPLE_SETTINGS)
    monkeypatch.setattr("search_tool.searxng._run_command", lambda args, check=True: CompletedProcess(args, 0, "started", ""))
    monkeypatch.setattr("search_tool.searxng.run_health_checks", lambda **kwargs: FakeReport())

    ensure_local_searxng()
    assert removed == [CONTAINER_NAME]


def test_cli_down_surfaces_operator_errors(monkeypatch, capsys):
    monkeypatch.setattr(
        "search_tool.searxng.stop_local_searxng",
        lambda: (_ for _ in ()).throw(SearxngOperatorError("docker missing")),
    )
    exit_code = main(["searxng", "down"])
    captured = capsys.readouterr()
    assert exit_code == 1
    assert "docker missing" in captured.err
