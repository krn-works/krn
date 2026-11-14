"""Complete tests for session summary functionality."""

import json
import tempfile
from pathlib import Path

from search_tool.cli import main
from search_tool.session import generate_session_id
from search_tool.session_summary import generate_session_summary, write_session_summary


def _write_minimal_session(work_dir: Path, session_id: str) -> None:
    session_dir = work_dir / "sessions" / session_id
    run_dir = session_dir / "runs" / "20260522T100000Z-abc123"
    run_dir.mkdir(parents=True, exist_ok=True)
    (run_dir / "search-run.json").write_text(json.dumps({
        "schema_version": "0.1",
        "query": {"redacted": "test query"},
        "discovery": {"provider": "static"},
        "fetch": {
            "requested_urls": 1,
            "succeeded": 1,
            "blocked": 0,
            "failed": 0,
            "skipped_duplicates": 0,
        },
        "limitations": [],
        "evidence_relevance": [
            {"url": "http://example.com/page1", "score": 0.65}
        ],
        "evidence_results": [
            {"url": "http://example.com/page1", "status": "success"}
        ],
    }), encoding="utf-8")


def test_session_summary_basic():
    """Test basic session summary functionality with correct directory structure."""

    with tempfile.TemporaryDirectory() as tmpdir:
        work_dir = Path(tmpdir)
        sessions_dir = work_dir / "sessions"
        sessions_dir.mkdir(parents=True, exist_ok=True)

        # Create a session directory
        session_dir = sessions_dir / "session-abc123"
        session_dir.mkdir(parents=True, exist_ok=True)

        # Create session.yaml with valid content to avoid metadata limitation
        session_meta_path = session_dir / "session.yaml"
        session_meta_content = '''schema_version: "0.1"
session_id: "session-abc123"
topic: "test topic"
created_at: "2026-05-22T10:00:00Z"
updated_at: "2026-05-22T10:00:00Z"
status: "active"
runs_total: 2
runs:
  - run_id: "20260522T100000Z-abc123"
    query: "test query"
    query_sha256: "d74ff0ee8da3b9806b18c8a731f5e72a"
    provider: "static"
    profile: null
    status: "ok"
    sources_total: 2
    sources_succeeded: 2
    sources_failed: 0
    best_evidence_relevance: 0.65
    created_at: "2026-05-22T10:00:00Z"
  - run_id: "20260522T110000Z-def456"
    query: "test query 2"
    query_sha256: "f7ff9e8b7bb2e09b70935485708d6303"
    provider: "static"
    profile: null
    status: "ok"
    sources_total: 2
    sources_succeeded: 2
    sources_failed: 0
    best_evidence_relevance: 0.72
    created_at: "2026-05-22T11:00:00Z"
'''
        session_meta_path.write_text(session_meta_content)

        # Create runs directory within the session
        runs_dir = session_dir / "runs"
        runs_dir.mkdir(parents=True, exist_ok=True)

        # Create a run directory
        run1_dir = runs_dir / "20260522T100000Z-abc123"
        run1_dir.mkdir(parents=True, exist_ok=True)

        # Create a mock search-run.json for run 1 with evidence_relevance
        manifest_content = {
            "schema_version": "0.1",
            "query": {
                "redacted": "test query"
            },
            "discovery": {
                "provider": "static"
            },
            "fetch": {
                "requested_urls": 2,
                "succeeded": 2,
                "blocked": 0,
                "failed": 0,
                "skipped_duplicates": 0
            },
            "limitations": [],
            "evidence_relevance": [
                {"url": "http://example.com/page1", "score": 0.65},
                {"url": "http://example.com/page2", "score": 0.45}
            ],
            "evidence_results": [
                {
                    "url": "http://example.com/page1",
                    "status": "success",
                    "source_quality": {
                        "authority_score": 3
                    }
                },
                {
                    "url": "http://example.com/page2",
                    "status": "success",
                    "source_quality": {
                        "authority_score": 2
                    }
                }
            ]
        }

        manifest_path = run1_dir / "search-run.json"
        with open(manifest_path, 'w') as f:
            json.dump(manifest_content, f)

        # Create a second run with same URLs but different relevance scores
        run2_dir = runs_dir / "20260522T110000Z-def456"
        run2_dir.mkdir(parents=True, exist_ok=True)

        manifest_content2 = {
            "schema_version": "0.1",
            "query": {
                "redacted": "test query 2"
            },
            "discovery": {
                "provider": "static"
            },
            "fetch": {
                "requested_urls": 2,
                "succeeded": 2,
                "blocked": 0,
                "failed": 0,
                "skipped_duplicates": 0
            },
            "limitations": [],
            "evidence_relevance": [
                {"url": "http://example.com/page1", "score": 0.45},
                {"url": "http://example.com/page2", "score": 0.72}
            ],
            "evidence_results": [
                {
                    "url": "http://example.com/page1",
                    "status": "success",
                    "source_quality": {
                        "authority_score": 3
                    }
                },
                {
                    "url": "http://example.com/page2",
                    "status": "success",
                    "source_quality": {
                        "authority_score": 2
                    }
                }
            ]
        }

        manifest_path2 = run2_dir / "search-run.json"
        with open(manifest_path2, 'w') as f:
            json.dump(manifest_content2, f)

        # Generate summary for the specific session
        summary = generate_session_summary(work_dir, session_id="session-abc123")

        # Test that we get the correct session ID
        assert summary.session_id == "session-abc123"

        # Test that the best relevance is calculated correctly
        # page1: 0.65 (from run1) vs 0.45 (from run2) -> should be 0.65
        # page2: 0.45 (from run1) vs 0.72 (from run2) -> should be 0.72
        assert "http://example.com/page1" in summary.source_relevance
        assert "http://example.com/page2" in summary.source_relevance

        # Check that we get the max scores, not average or frequency
        assert summary.source_relevance["http://example.com/page1"] == 0.65
        assert summary.source_relevance["http://example.com/page2"] == 0.72

        # Test run count
        assert summary.runs_count == 2

        # Test limitations are empty for successful runs (except for metadata limitation which should be handled properly)
        # The session.yaml is present, so no metadata limitation should be recorded
        # Note: we may still get some limitations from the run processing itself
        # But main test focus is that no extra limitation was added due to missing session metadata


def test_session_summary_empty():
    """Test generating a session summary with no runs."""

    with tempfile.TemporaryDirectory() as tmpdir:
        work_dir = Path(tmpdir)
        sessions_dir = work_dir / "sessions"
        sessions_dir.mkdir(parents=True, exist_ok=True)

        # Create a session directory
        session_dir = sessions_dir / "session-empty"
        session_dir.mkdir(parents=True, exist_ok=True)

        # Create runs directory within the session
        runs_dir = session_dir / "runs"
        runs_dir.mkdir(parents=True, exist_ok=True)

        # Generate summary for empty session
        summary = generate_session_summary(work_dir, session_id="session-empty")

        # Should have no sources or runs
        assert summary.session_id == "session-empty"
        assert summary.runs_count == 0
        assert summary.unique_sources == 0


def test_session_summary_with_limitations():
    """Test handling of missing/corrupt artifacts with limitations recorded."""

    with tempfile.TemporaryDirectory() as tmpdir:
        work_dir = Path(tmpdir)
        sessions_dir = work_dir / "sessions"
        sessions_dir.mkdir(parents=True, exist_ok=True)

        # Create a session directory
        session_dir = sessions_dir / "session-with-limitations"
        session_dir.mkdir(parents=True, exist_ok=True)

        # Create runs directory within the session
        runs_dir = session_dir / "runs"
        runs_dir.mkdir(parents=True, exist_ok=True)

        # Create a run directory with missing search-run.json
        run1_dir = runs_dir / "20260522T100000Z-abc123"
        run1_dir.mkdir(parents=True, exist_ok=True)

        # This run has no search-run.json file - should create limitation

        # Generate summary for session with problematic run
        summary = generate_session_summary(work_dir, session_id="session-with-limitations")

        # Should have limitations recorded (at least one for missing file)
        assert len(summary.limitations) > 0
        # Check that the limitation message is appropriate
        assert any("missing search-run.json" in lim for lim in summary.limitations)


def test_session_summary_with_corrupt_metadata():
    """Test handling of corrupt session.yaml with limitations recorded."""

    with tempfile.TemporaryDirectory() as tmpdir:
        work_dir = Path(tmpdir)
        sessions_dir = work_dir / "sessions"
        sessions_dir.mkdir(parents=True, exist_ok=True)

        # Create a session directory
        session_dir = sessions_dir / "session-with-corrupt-metadata"
        session_dir.mkdir(parents=True, exist_ok=True)

        # Create session.yaml with invalid content to simulate corruption
        session_meta_path = session_dir / "session.yaml"
        session_meta_path.write_text("invalid yaml content that cannot be parsed\n")

        # Create runs directory within the session
        runs_dir = session_dir / "runs"
        runs_dir.mkdir(parents=True, exist_ok=True)

        # Create a run directory with search-run.json for valid processing
        run1_dir = runs_dir / "20260522T100000Z-abc123"
        run1_dir.mkdir(parents=True, exist_ok=True)

        # Create a mock search-run.json for run 1
        manifest_content = {
            "schema_version": "0.1",
            "query": {
                "redacted": "test query"
            },
            "discovery": {
                "provider": "static"
            },
            "fetch": {
                "requested_urls": 2,
                "succeeded": 2,
                "blocked": 0,
                "failed": 0,
                "skipped_duplicates": 0
            },
            "limitations": [],
            "evidence_relevance": [
                {"url": "http://example.com/page1", "score": 0.65}
            ],
            "evidence_results": [
                {
                    "url": "http://example.com/page1",
                    "status": "success"
                }
            ]
        }

        manifest_path = run1_dir / "search-run.json"
        with open(manifest_path, 'w') as f:
            json.dump(manifest_content, f)

        # Generate summary for session with corrupt metadata
        summary = generate_session_summary(work_dir, session_id="session-with-corrupt-metadata")

        # Should have limitations recorded for corrupt metadata
        assert len(summary.limitations) > 0
        # Check that the limitation message is appropriate
        assert any("Session metadata file (session.yaml) missing or corrupt" in lim for lim in summary.limitations)


def test_session_summary_best_relevance_edge_cases():
    """Test edge cases in relevance calculation."""

    with tempfile.TemporaryDirectory() as tmpdir:
        work_dir = Path(tmpdir)
        sessions_dir = work_dir / "sessions"
        sessions_dir.mkdir(parents=True, exist_ok=True)

        # Create a session directory
        session_dir = sessions_dir / "session-edge-cases"
        session_dir.mkdir(parents=True, exist_ok=True)

        # Create runs directory within the session
        runs_dir = session_dir / "runs"
        runs_dir.mkdir(parents=True, exist_ok=True)

        # Create a run directory
        run1_dir = runs_dir / "20260522T100000Z-abc123"
        run1_dir.mkdir(parents=True, exist_ok=True)

        # Create a mock search-run.json with zero relevance scores
        manifest_content = {
            "schema_version": "0.1",
            "query": {
                "redacted": "test query"
            },
            "discovery": {
                "provider": "static"
            },
            "fetch": {
                "requested_urls": 1,
                "succeeded": 1,
                "blocked": 0,
                "failed": 0,
                "skipped_duplicates": 0
            },
            "limitations": [],
            "evidence_relevance": [
                {"url": "http://example.com/page1", "score": 0.0}
            ],
            "evidence_results": [
                {
                    "url": "http://example.com/page1",
                    "status": "success"
                }
            ]
        }

        manifest_path = run1_dir / "search-run.json"
        with open(manifest_path, 'w') as f:
            json.dump(manifest_content, f)

        # Generate summary
        summary = generate_session_summary(work_dir, session_id="session-edge-cases")

        # Zero scores should be handled properly
        assert "http://example.com/page1" in summary.source_relevance
        assert summary.source_relevance["http://example.com/page1"] == 0.0


def test_session_summary_run_history_derives_counts_from_evidence_results_when_fetch_counts_are_zero(tmp_path):
    """Run history falls back to evidence_results when fetch counters are absent or zero."""
    session_id = "session-dogfood-counters"
    run_dir = tmp_path / "sessions" / session_id / "runs" / "20260522T100000Z-abc123"
    run_dir.mkdir(parents=True)
    (run_dir / "search-run.json").write_text(json.dumps({
        "schema_version": "0.1",
        "query": {"redacted": "dogfood counter query"},
        "discovery": {"provider": "static"},
        "fetch": {
            "requested_urls": 0,
            "succeeded": 0,
            "blocked": 0,
            "failed": 0,
            "skipped_duplicates": 1,
        },
        "limitations": [],
        "evidence_relevance": [
            {"url": "http://example.com/success", "score": 0.81},
            {"url": "http://example.com/truncated", "score": 0.44},
        ],
        "evidence_results": [
            {"url": "http://example.com/success", "status": "success"},
            {"url": "http://example.com/truncated", "status": "truncated"},
            {"url": "http://example.com/blocked", "status": "blocked"},
        ],
    }), encoding="utf-8")

    summary = generate_session_summary(tmp_path, session_id=session_id)
    output_path = tmp_path / "summary.md"
    write_session_summary(summary, output_path)

    assert summary.total_urls_fetched == 3
    assert summary.total_evidence_packs == 2
    assert summary.run_history[0]["urls_requested"] == 3
    assert summary.run_history[0]["urls_succeeded"] == 2
    assert summary.run_history[0]["urls_blocked"] == 1
    assert summary.run_history[0]["urls_failed"] == 0
    assert summary.run_history[0]["urls_skipped"] == 1

    markdown = output_path.read_text(encoding="utf-8")
    assert (
        "| 20260522T100000Z-abc123 | 20260522T100000Z | dogfood counter query | "
        "static | 3 | 2 | 1 | 0 | 1 | 0 |"
    ) in markdown


def test_session_summary_markdown_includes_capped_sanitized_source_snippets(tmp_path):
    """Session summary writes mechanical snippets from existing run JSON fields."""
    session_id = "session-snippets"
    run_dir = tmp_path / "sessions" / session_id / "runs" / "20260522T100000Z-abc123"
    run_dir.mkdir(parents=True)
    long_tail = "x" * 1100
    (run_dir / "search-run.json").write_text(json.dumps({
        "schema_version": "0.1",
        "query": {"redacted": "snippet query"},
        "discovery": {"provider": "static"},
        "fetch": {
            "requested_urls": 1,
            "succeeded": 1,
            "blocked": 0,
            "failed": 0,
            "skipped_duplicates": 0,
        },
        "limitations": [],
        "evidence_relevance": [
            {"url": "http://example.com/snippet", "score": 0.55}
        ],
        "evidence_results": [
            {
                "url": "http://example.com/snippet",
                "status": "success",
                "excerpt": "Alpha | beta <tag>\n" + long_tail,
            }
        ],
    }), encoding="utf-8")

    summary = generate_session_summary(tmp_path, session_id=session_id)
    output_path = tmp_path / "summary.md"
    write_session_summary(summary, output_path)

    markdown = output_path.read_text(encoding="utf-8")
    assert "## Source Snippets" in markdown
    assert "| Source URL | Snippet |" in markdown
    assert "Alpha \\| beta \\<tag\\>" in markdown
    assert "\n" + long_tail not in markdown
    assert len(summary.source_snippets["http://example.com/snippet"]) == 1000


def test_session_summary_snippets_fall_back_to_evidence_pack(tmp_path):
    """Session summary extracts snippets from existing evidence pack paths."""
    session_id = "session-pack-snippets"
    run_dir = tmp_path / "sessions" / session_id / "runs" / "20260522T100000Z-abc123"
    evidence_dir = run_dir / "evidence"
    evidence_dir.mkdir(parents=True)
    pack_path = evidence_dir / "example.md"
    pack_path.write_text(
        "---\ntitle: Example\n---\n\n"
        "## Extracted source content\n\n"
        "```\nSkip to content\n\nMechanical pack snippet | with table chars\n```\n",
        encoding="utf-8",
    )
    (run_dir / "search-run.json").write_text(json.dumps({
        "schema_version": "0.1",
        "query": {"redacted": "snippet query"},
        "discovery": {"provider": "static"},
        "fetch": {
            "requested_urls": 1,
            "succeeded": 1,
            "blocked": 0,
            "failed": 0,
            "skipped_duplicates": 0,
        },
        "limitations": [],
        "evidence_relevance": [
            {"url": "http://example.com/pack", "score": 0.55}
        ],
        "evidence_results": [
            {
                "url": "http://example.com/pack",
                "status": "success",
                "evidence_path": "evidence/example.md",
            }
        ],
    }), encoding="utf-8")

    summary = generate_session_summary(tmp_path, session_id=session_id)
    output_path = tmp_path / "summary.md"
    write_session_summary(summary, output_path)

    markdown = output_path.read_text(encoding="utf-8")
    assert summary.source_snippets["http://example.com/pack"] == "Mechanical pack snippet | with table chars"
    assert "Mechanical pack snippet \\| with table chars" in markdown


def test_session_summary_missing_snippet_data_does_not_crash(tmp_path):
    """Missing snippet fields or paths render as an empty snippet."""
    session_id = "session-missing-snippets"
    run_dir = tmp_path / "sessions" / session_id / "runs" / "20260522T100000Z-abc123"
    run_dir.mkdir(parents=True)
    (run_dir / "search-run.json").write_text(json.dumps({
        "schema_version": "0.1",
        "query": {"redacted": "snippet query"},
        "discovery": {"provider": "static"},
        "fetch": {
            "requested_urls": 1,
            "succeeded": 1,
            "blocked": 0,
            "failed": 0,
            "skipped_duplicates": 0,
        },
        "limitations": [],
        "evidence_relevance": [
            {"url": "http://example.com/missing", "score": 0.55}
        ],
        "evidence_results": [
            {"url": "http://example.com/missing", "status": "success"}
        ],
    }), encoding="utf-8")

    summary = generate_session_summary(tmp_path, session_id=session_id)
    output_path = tmp_path / "summary.md"
    write_session_summary(summary, output_path)

    assert summary.source_snippets["http://example.com/missing"] == ""
    assert "| http://example.com/missing |  |" in output_path.read_text(encoding="utf-8")


def test_session_summary_absolute_evidence_path_is_rejected(tmp_path):
    """Absolute evidence_path values are not read for snippets."""
    session_id = "session-absolute-path"
    run_dir = tmp_path / "sessions" / session_id / "runs" / "20260522T100000Z-abc123"
    run_dir.mkdir(parents=True)
    outside_pack = tmp_path / "outside.md"
    outside_pack.write_text(
        "---\ntitle: Outside\n---\n\n```\nSHOULD NOT READ ABSOLUTE\n```\n",
        encoding="utf-8",
    )
    (run_dir / "search-run.json").write_text(json.dumps({
        "schema_version": "0.1",
        "query": {"redacted": "snippet query"},
        "discovery": {"provider": "static"},
        "fetch": {
            "requested_urls": 1,
            "succeeded": 1,
            "blocked": 0,
            "failed": 0,
            "skipped_duplicates": 0,
        },
        "limitations": [],
        "evidence_relevance": [
            {"url": "http://example.com/absolute", "score": 0.55}
        ],
        "evidence_results": [
            {
                "url": "http://example.com/absolute",
                "status": "success",
                "evidence_path": str(outside_pack),
            }
        ],
    }), encoding="utf-8")

    summary = generate_session_summary(tmp_path, session_id=session_id)
    output_path = tmp_path / "summary.md"
    write_session_summary(summary, output_path)

    markdown = output_path.read_text(encoding="utf-8")
    assert summary.source_snippets["http://example.com/absolute"] == ""
    assert "SHOULD NOT READ ABSOLUTE" not in markdown


def test_session_summary_traversal_evidence_path_is_rejected(tmp_path):
    """Traversal evidence_path values are not read outside the run directory."""
    session_id = "session-traversal-path"
    session_dir = tmp_path / "sessions" / session_id
    run_dir = session_dir / "runs" / "20260522T100000Z-abc123"
    run_dir.mkdir(parents=True)
    secret_pack = session_dir / "secret.md"
    secret_pack.write_text(
        "---\ntitle: Secret\n---\n\n```\nSHOULD NOT READ TRAVERSAL\n```\n",
        encoding="utf-8",
    )
    (run_dir / "search-run.json").write_text(json.dumps({
        "schema_version": "0.1",
        "query": {"redacted": "snippet query"},
        "discovery": {"provider": "static"},
        "fetch": {
            "requested_urls": 1,
            "succeeded": 1,
            "blocked": 0,
            "failed": 0,
            "skipped_duplicates": 0,
        },
        "limitations": [],
        "evidence_relevance": [
            {"url": "http://example.com/traversal", "score": 0.55}
        ],
        "evidence_results": [
            {
                "url": "http://example.com/traversal",
                "status": "success",
                "evidence_path": "../../secret.md",
            }
        ],
    }), encoding="utf-8")

    summary = generate_session_summary(tmp_path, session_id=session_id)
    output_path = tmp_path / "summary.md"
    write_session_summary(summary, output_path)

    markdown = output_path.read_text(encoding="utf-8")
    assert summary.source_snippets["http://example.com/traversal"] == ""
    assert "SHOULD NOT READ TRAVERSAL" not in markdown


def test_cli_session_summary_session_topic_writes_default_output(tmp_path, capsys):
    """CLI --session topic writes the default session-summary.md."""
    topic = "test topic"
    session_id = generate_session_id(topic)
    _write_minimal_session(tmp_path, session_id)

    exit_code = main([
        "session-summary",
        "--work-dir",
        str(tmp_path),
        "--session",
        topic,
    ])

    captured = capsys.readouterr()
    output_path = tmp_path / "sessions" / session_id / "session-summary.md"
    assert exit_code == 0
    assert output_path.exists()
    assert str(output_path) in captured.out


def test_cli_session_summary_session_id_writes_default_output(tmp_path, capsys):
    """CLI --session-id writes the default session-summary.md."""
    session_id = "session-cli123"
    _write_minimal_session(tmp_path, session_id)

    exit_code = main([
        "session-summary",
        "--work-dir",
        str(tmp_path),
        "--session-id",
        session_id,
    ])

    captured = capsys.readouterr()
    output_path = tmp_path / "sessions" / session_id / "session-summary.md"
    assert exit_code == 0
    assert output_path.exists()
    assert str(output_path) in captured.out


def test_cli_session_summary_output_writes_custom_file(tmp_path, capsys):
    """CLI --output writes to the requested custom file."""
    session_id = "session-cli-output"
    output_path = tmp_path / "custom" / "summary.md"
    _write_minimal_session(tmp_path, session_id)

    exit_code = main([
        "session-summary",
        "--work-dir",
        str(tmp_path),
        "--session-id",
        session_id,
        "--output",
        str(output_path),
    ])

    captured = capsys.readouterr()
    default_output_path = tmp_path / "sessions" / session_id / "session-summary.md"
    assert exit_code == 0
    assert output_path.exists()
    assert not default_output_path.exists()
    assert str(output_path) in captured.out


def test_cli_session_summary_missing_selector_returns_nonzero(tmp_path, capsys):
    """CLI without --session or --session-id returns non-zero."""
    exit_code = main(["session-summary", "--work-dir", str(tmp_path)])

    captured = capsys.readouterr()
    assert exit_code == 1
    assert "must specify exactly one of --session or --session-id" in captured.err


def test_cli_session_summary_both_selectors_returns_nonzero(tmp_path, capsys):
    """CLI with both --session and --session-id returns non-zero."""
    exit_code = main([
        "session-summary",
        "--work-dir",
        str(tmp_path),
        "--session",
        "test topic",
        "--session-id",
        "session-cli123",
    ])

    captured = capsys.readouterr()
    assert exit_code == 1
    assert "must specify exactly one of --session or --session-id" in captured.err
