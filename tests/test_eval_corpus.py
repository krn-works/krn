"""Tests for the evaluation corpus runner."""

import json
from pathlib import Path
from unittest.mock import patch

import pytest

from search_tool.eval_corpus import run_corpus, ScenarioResult


def test_run_corpus_accepts_basic_fixture():
    corpus_path = Path("tests/fixtures/search_corpus/basic.json")
    results = run_corpus(corpus_path)

    assert len(results) > 0
    assert all(isinstance(r, ScenarioResult) for r in results)
    assert all(r.status == "PASS" for r in results)


def test_run_corpus_fails_on_missing_schema_version(tmp_path):
    corpus_file = tmp_path / "invalid.json"
    corpus_file.write_text(json.dumps({"scenarios": []}))

    results = run_corpus(corpus_file)
    assert len(results) == 1
    assert results[0].scenario_id == "validation"
    assert "schema_version" in results[0].message


def test_run_corpus_fails_on_missing_scenarios(tmp_path):
    corpus_file = tmp_path / "invalid.json"
    corpus_file.write_text(json.dumps({"schema_version": "0.1"}))

    results = run_corpus(corpus_file)
    assert len(results) == 1
    assert results[0].scenario_id == "validation"
    assert "scenarios" in results[0].message


def test_run_corpus_returns_json_serializable_summary():
    corpus_path = Path("tests/fixtures/search_corpus/basic.json")
    results = run_corpus(corpus_path)

    # Check if we can serialize the result as JSON (ScenarioResult is a dataclass)
    from dataclasses import asdict
    summary = [asdict(r) for r in results]
    json_str = json.dumps(summary)
    assert json_str.startswith("[")


def test_run_corpus_fails_on_missing_corpus_path():
    results = run_corpus(Path("nonexistent.json"))
    assert len(results) == 1
    assert results[0].status == "ERROR"


def test_run_corpus_isolates_artifacts(tmp_path):
    # This is partially tested by the fact that run_scenario uses tempfile.TemporaryDirectory() internally.
    # But we want to be sure it doesn't leak to the current directory's evidence/ folder.

    # We'll run a scenario and check if the repo's evidence folder was touched
    repo_evidence = Path("evidence")
    initial_files = set(repo_evidence.glob("*")) if repo_evidence.exists() else set()

    corpus_path = Path("tests/fixtures/search_corpus/basic.json")
    run_corpus(corpus_path)

    final_files = set(repo_evidence.glob("*")) if repo_evidence.exists() else set()
    assert final_files == initial_files


def test_run_corpus_no_live_network_or_dns():
    # We patch httpx.Client and socket.getaddrinfo at the top level to catch any leaks
    with patch("httpx.Client") as mock_http, \
         patch("socket.getaddrinfo") as mock_dns:

        corpus_path = Path("tests/fixtures/search_corpus/basic.json")
        run_corpus(corpus_path)

        # These should NOT have been called because run_scenario patches deeper internal names
        # or uses mocks. If they WERE called, they would be leaks.
        assert mock_http.call_count == 0
        assert mock_dns.call_count == 0


def test_run_corpus_uses_supplied_work_dir(tmp_path):
    work_dir = tmp_path / "custom_work"
    corpus_path = Path("tests/fixtures/search_corpus/basic.json")

    run_corpus(corpus_path, work_dir=work_dir)

    # Check if artifacts are in work_dir
    # run_scenario creates subdirs by scenario.id
    scenario_dir = work_dir / "safe_single"
    assert scenario_dir.exists()
    assert (scenario_dir / "evidence").exists()


def test_cli_eval_corpus_json_stdout(tmp_path):
    from search_tool.cli import main
    import io
    from contextlib import redirect_stdout, redirect_stderr

    corpus_path = Path("tests/fixtures/search_corpus/basic.json")

    f_stdout = io.StringIO()
    f_stderr = io.StringIO()

    with redirect_stdout(f_stdout), redirect_stderr(f_stderr):
        exit_code = main(["eval-corpus", str(corpus_path)])

    assert exit_code == 0

    # stdout should be JSON
    output = f_stdout.getvalue()
    data = json.loads(output)
    assert data["schema_version"] == "0.1"
    assert data["status"] == "pass"
    assert data["scenarios_total"] > 0
    assert len(data["results"]) == data["scenarios_total"]

    # stderr should have compact summary
    err = f_stderr.getvalue()
    assert "[eval-corpus]" in err
    assert "scenarios=" in err


def test_cli_eval_corpus_failing_exit_1(tmp_path):
    from search_tool.cli import main
    import io
    from contextlib import redirect_stdout, redirect_stderr

    corpus_file = tmp_path / "fail.json"
    corpus_file.write_text(json.dumps({
        "schema_version": "0.1",
        "scenarios": [
            {
                "id": "fail_cli",
                "description": "Fails",
                "query": "test",
                "provider": "static",
                "expect": {"discovery": {"total": 1}}
            }
        ]
    }))

    f_stdout = io.StringIO()
    f_stderr = io.StringIO()

    with redirect_stdout(f_stdout), redirect_stderr(f_stderr):
        exit_code = main(["eval-corpus", str(corpus_file)])

    assert exit_code == 1
    data = json.loads(f_stdout.getvalue())
    assert data["status"] == "fail"
    assert data["scenarios_failed"] == 1
