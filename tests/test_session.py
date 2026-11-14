"""Tests for search_tool/session.py — session directory and metadata."""

import json
from pathlib import Path

import pytest

from search_tool.session import (
    SCHEMA_VERSION,
    SessionMetadata,
    SessionRunRecord,
    _parse_yaml,
    _serialize_yaml,
    _unquote_yaml,
    create_session,
    generate_session_id,
    load_session_metadata,
    recover_session_metadata,
    session_dir_path,
    update_session_metadata,
)


def _sample_run_record(**overrides) -> SessionRunRecord:
    defaults = dict(
        run_id="20260522T120000Z-abc123def456",
        query="test query",
        query_sha256="a" * 64,
        provider="static",
        profile=None,
        status="ok",
        sources_total=3,
        sources_succeeded=3,
        sources_failed=0,
        best_evidence_relevance=0.72,
        created_at="2026-05-22T12:00:00+00:00",
    )
    defaults.update(overrides)
    return SessionRunRecord(**defaults)


def _sample_metadata(**overrides) -> SessionMetadata:
    defaults = dict(
        session_id="session-abc123def456",
        topic="test topic",
        created_at="2026-05-22T12:00:00+00:00",
        updated_at="2026-05-22T12:00:00+00:00",
        status="active",
        runs_total=0,
        runs=[],
    )
    defaults.update(overrides)
    return SessionMetadata(**defaults)


class TestGenerateSessionId:
    def test_deterministic(self):
        assert generate_session_id("topic") == generate_session_id("topic")

    def test_different_topics_differ(self):
        assert generate_session_id("topic a") != generate_session_id("topic b")

    def test_format(self):
        sid = generate_session_id("test")
        assert sid.startswith("session-")
        assert len(sid) == len("session-") + 12


class TestSessionDirPath:
    def test_under_sessions(self, tmp_path):
        result = session_dir_path(tmp_path, "session-abc")
        assert result == tmp_path / "sessions" / "session-abc"


class TestYamlRoundTrip:
    def test_empty_session(self):
        meta = _sample_metadata()
        text = _serialize_yaml(meta)
        parsed = _parse_yaml(text)
        assert parsed.session_id == meta.session_id
        assert parsed.topic == meta.topic
        assert parsed.status == "active"
        assert parsed.runs_total == 0
        assert parsed.runs == []

    def test_with_runs(self):
        meta = _sample_metadata(
            runs_total=2,
            runs=[
                _sample_run_record(run_id="run-1", query="query 1", best_evidence_relevance=0.5),
                _sample_run_record(run_id="run-2", query="query 2", status="partial_success"),
            ],
        )
        text = _serialize_yaml(meta)
        parsed = _parse_yaml(text)
        assert parsed.runs_total == 2
        assert len(parsed.runs) == 2
        assert parsed.runs[0].run_id == "run-1"
        assert parsed.runs[0].query == "query 1"
        assert parsed.runs[0].best_evidence_relevance == 0.5
        assert parsed.runs[1].status == "partial_success"

    def test_special_chars_in_topic(self):
        meta = _sample_metadata(topic='topic with "quotes" and \\backslash')
        text = _serialize_yaml(meta)
        parsed = _parse_yaml(text)
        assert parsed.topic == 'topic with "quotes" and \\backslash'

    def test_special_chars_in_query(self):
        meta = _sample_metadata(
            runs=[_sample_run_record(query="what is \"AI\" and\nhow does it work?")],
        )
        text = _serialize_yaml(meta)
        parsed = _parse_yaml(text)
        assert parsed.runs[0].query == "what is \"AI\" and\nhow does it work?"

    def test_null_profile(self):
        meta = _sample_metadata(runs=[_sample_run_record(profile=None)])
        text = _serialize_yaml(meta)
        parsed = _parse_yaml(text)
        assert parsed.runs[0].profile is None

    def test_with_profile(self):
        meta = _sample_metadata(runs=[_sample_run_record(profile="official-docs")])
        text = _serialize_yaml(meta)
        parsed = _parse_yaml(text)
        assert parsed.runs[0].profile == "official-docs"


class TestUnquoteYaml:
    def test_plain(self):
        assert _unquote_yaml("hello") == "hello"

    def test_escaped_quote(self):
        assert _unquote_yaml('say \\"hi\\"') == 'say "hi"'

    def test_escaped_backslash(self):
        assert _unquote_yaml("path\\\\file") == "path\\file"

    def test_escaped_newline(self):
        assert _unquote_yaml("line1\\nline2") == "line1\nline2"

    def test_backslash_n_literal(self):
        # Original had literal backslash+n (not newline).
        # Escaped form is \\n (2 backslashes + n).
        assert _unquote_yaml("hello\\\\nworld") == "hello\\nworld"


class TestCreateSession:
    def test_creates_directory(self, tmp_path):
        session_dir, meta = create_session(tmp_path, "test topic")
        assert session_dir.exists()
        assert (session_dir / "runs").exists()
        assert (session_dir / "session.yaml").exists()

    def test_metadata_fields(self, tmp_path):
        session_dir, meta = create_session(tmp_path, "test topic")
        assert meta.session_id == generate_session_id("test topic")
        assert meta.topic == "test topic"
        assert meta.status == "active"
        assert meta.runs_total == 0
        assert meta.schema_version == SCHEMA_VERSION

    def test_idempotent_same_topic(self, tmp_path):
        dir1, meta1 = create_session(tmp_path, "topic x")
        dir2, meta2 = create_session(tmp_path, "topic x")
        assert dir1 == dir2
        assert meta1.session_id == meta2.session_id

    def test_different_topics_different_dirs(self, tmp_path):
        dir1, _ = create_session(tmp_path, "topic a")
        dir2, _ = create_session(tmp_path, "topic b")
        assert dir1 != dir2

    def test_corrupted_metadata_recovers_from_runs(self, tmp_path):
        """create_session recovers run artifacts when session.yaml is corrupted."""
        session_id = generate_session_id("recovery topic")
        session_dir = tmp_path / "sessions" / session_id
        run_dir = session_dir / "runs" / "20260522T120000Z-existing"
        run_dir.mkdir(parents=True)

        run_json = {
            "status": "ok",
            "query": {"redacted": "existing query", "hash_sha256": "d" * 64},
            "discovery": {"provider": "static"},
            "evidence_results": [{"url": "https://example.com", "status": "success"}],
            "failures": [],
            "evidence_relevance": [{"url": "https://example.com", "score": 0.55}],
        }
        (run_dir / "search-run.json").write_text(
            json.dumps(run_json), encoding="utf-8",
        )

        # Write corrupted session.yaml
        (session_dir / "session.yaml").write_text("{{{{junk", encoding="utf-8")

        _, meta = create_session(tmp_path, "recovery topic")
        # Must recover the existing run, not discard it.
        assert meta.runs_total >= 1
        run_ids = [r.run_id for r in meta.runs]
        assert "20260522T120000Z-existing" in run_ids
        # Topic should be filled from caller.
        assert meta.topic == "recovery topic"

    def test_corrupted_metadata_no_runs_creates_fresh(self, tmp_path):
        """create_session creates fresh metadata when corrupted and no run artifacts."""
        session_id = generate_session_id("fresh after corrupt")
        session_dir = tmp_path / "sessions" / session_id
        session_dir.mkdir(parents=True)
        (session_dir / "session.yaml").write_text("{{{{junk", encoding="utf-8")

        _, meta = create_session(tmp_path, "fresh after corrupt")
        assert meta.session_id == session_id
        assert meta.topic == "fresh after corrupt"
        assert meta.runs_total == 0


class TestLoadSessionMetadata:
    def test_loads_existing(self, tmp_path):
        _, original = create_session(tmp_path, "topic")
        session_dir = session_dir_path(tmp_path, generate_session_id("topic"))
        loaded = load_session_metadata(session_dir)
        assert loaded is not None
        assert loaded.session_id == original.session_id
        assert loaded.topic == original.topic

    def test_returns_none_missing(self, tmp_path):
        result = load_session_metadata(tmp_path / "nonexistent")
        assert result is None

    def test_returns_none_corrupted(self, tmp_path):
        session_id = generate_session_id("corrupted topic")
        session_dir = tmp_path / "sessions" / session_id
        session_dir.mkdir(parents=True)
        (session_dir / "session.yaml").write_text("{{{{invalid yaml", encoding="utf-8")
        result = load_session_metadata(session_dir)
        assert result is None

    def test_returns_none_arbitrary_junk(self, tmp_path):
        """Arbitrary junk that doesn't raise an exception still returns None."""
        session_id = generate_session_id("junk topic")
        session_dir = tmp_path / "sessions" / session_id
        session_dir.mkdir(parents=True)
        (session_dir / "session.yaml").write_text(
            "hello world\nthis is not yaml\n", encoding="utf-8",
        )
        result = load_session_metadata(session_dir)
        assert result is None

    def test_returns_none_session_id_mismatch(self, tmp_path):
        """session.yaml with session_id not matching directory name is corrupted."""
        session_dir = tmp_path / "sessions" / "session-expected"
        session_dir.mkdir(parents=True)
        meta = _sample_metadata(session_id="session-different")
        (session_dir / "session.yaml").write_text(
            _serialize_yaml(meta), encoding="utf-8",
        )
        result = load_session_metadata(session_dir)
        assert result is None

    def test_returns_none_empty_session_id(self, tmp_path):
        """session.yaml with empty session_id is corrupted."""
        session_dir = tmp_path / "sessions" / "session-empty"
        session_dir.mkdir(parents=True)
        meta = _sample_metadata(session_id="")
        (session_dir / "session.yaml").write_text(
            _serialize_yaml(meta), encoding="utf-8",
        )
        result = load_session_metadata(session_dir)
        assert result is None


class TestUpdateSessionMetadata:
    def test_appends_run_record(self, tmp_path):
        session_dir, _ = create_session(tmp_path, "topic")
        record = _sample_run_record()
        result = update_session_metadata(session_dir, record)
        assert result is not None
        assert result.runs_total == 1
        assert result.runs[0].run_id == record.run_id

    def test_multiple_runs(self, tmp_path):
        session_dir, _ = create_session(tmp_path, "topic")
        r1 = _sample_run_record(run_id="run-1")
        r2 = _sample_run_record(run_id="run-2")
        update_session_metadata(session_dir, r1)
        result = update_session_metadata(session_dir, r2)
        assert result is not None
        assert result.runs_total == 2

    def test_updated_at_changes(self, tmp_path):
        session_dir, original = create_session(tmp_path, "topic")
        record = _sample_run_record()
        result = update_session_metadata(session_dir, record)
        assert result is not None
        assert result.updated_at != original.updated_at

    def test_best_effort_write_failure(self, tmp_path):
        session_dir, _ = create_session(tmp_path, "topic")
        # Make session.yaml read-only directory
        (session_dir / "session.yaml").chmod(0o444)
        session_dir.chmod(0o555)
        record = _sample_run_record()
        try:
            result = update_session_metadata(session_dir, record)
            # Should return None on write failure (best-effort)
            assert result is None
        finally:
            session_dir.chmod(0o755)


class TestRecoverSessionMetadata:
    def test_from_run_artifacts(self, tmp_path):
        session_id = generate_session_id("recovery test")
        session_dir = session_dir_path(tmp_path, session_id)
        run_dir = session_dir / "runs" / "20260522T120000Z-abc123def456"
        run_dir.mkdir(parents=True)

        # Write a search-run.json
        run_json = {
            "schema_version": "0.1",
            "status": "ok",
            "query": {"redacted": "test query", "hash_sha256": "b" * 64},
            "discovery": {"provider": "static"},
            "evidence_results": [
                {"url": "https://example.com", "status": "success"},
                {"url": "https://example.org", "status": "success"},
            ],
            "failures": [],
            "evidence_relevance": [
                {"url": "https://example.com", "score": 0.65},
                {"url": "https://example.org", "score": 0.72},
            ],
            "profile": {"name": "official-docs"},
        }
        (run_dir / "search-run.json").write_text(
            json.dumps(run_json), encoding="utf-8",
        )

        result = recover_session_metadata(session_dir)
        assert result is not None
        assert result.status == "recovered"
        assert result.runs_total == 1
        assert result.runs[0].query == "test query"
        assert result.runs[0].provider == "static"
        assert result.runs[0].sources_total == 2
        assert result.runs[0].sources_succeeded == 2
        assert result.runs[0].best_evidence_relevance == 0.72
        assert result.runs[0].profile == "official-docs"
        # Should also write recovered session.yaml
        assert (session_dir / "session.yaml").exists()

    def test_empty_runs_dir(self, tmp_path):
        session_id = generate_session_id("empty recovery")
        session_dir = session_dir_path(tmp_path, session_id)
        (session_dir / "runs").mkdir(parents=True)
        result = recover_session_metadata(session_dir)
        assert result is None

    def test_missing_runs_dir(self, tmp_path):
        session_dir = tmp_path / "sessions" / "session-nope"
        result = recover_session_metadata(session_dir)
        assert result is None

    def test_corrupted_json_skipped(self, tmp_path):
        session_id = generate_session_id("corrupt recovery")
        session_dir = session_dir_path(tmp_path, session_id)
        run_dir = session_dir / "runs" / "20260522T120000Z-bad"
        run_dir.mkdir(parents=True)
        (run_dir / "search-run.json").write_text("not json{{{", encoding="utf-8")
        result = recover_session_metadata(session_dir)
        assert result is None

    def test_recovery_used_on_corrupted_metadata(self, tmp_path):
        """update_session_metadata falls back to recovery when metadata is corrupted."""
        session_id = generate_session_id("fallback")
        session_dir = session_dir_path(tmp_path, session_id)
        run_dir = session_dir / "runs" / "20260522T120000Z-existing"
        run_dir.mkdir(parents=True)

        run_json = {
            "status": "ok",
            "query": {"redacted": "existing", "hash_sha256": "c" * 64},
            "discovery": {"provider": "searxng"},
            "evidence_results": [],
            "failures": [],
            "evidence_relevance": [],
        }
        (run_dir / "search-run.json").write_text(
            json.dumps(run_json), encoding="utf-8",
        )

        # Delete session.yaml to trigger recovery
        result = update_session_metadata(session_dir, _sample_run_record())
        assert result is not None
        assert result.status == "recovered"
        assert result.runs_total == 2  # 1 recovered + 1 new


class TestSessionIntegration:
    """CLI-level session integration via main()."""

    def test_session_with_research(self, capsys, tmp_path):
        from search_tool.cli import main

        work_dir = str(tmp_path / "runs")
        rc = main([
            "search-query", "test query", "--research",
            "--provider", "static",
            "--candidate-url", "http://example.com",
            "--work-dir", work_dir,
            "--session", "test session",
        ])
        captured = capsys.readouterr()
        if rc == 0:
            parsed = json.loads(captured.out)
            assert parsed["session"] is not None
            assert parsed["session"]["session_id"] == generate_session_id("test session")
            assert parsed["session"]["topic"] == "test session"
            assert parsed["session"]["run_number"] == 1
            assert parsed["session"]["metadata_status"] == "ok"

    def test_session_creates_directory_structure(self, tmp_path):
        from search_tool.cli import main

        work_dir = str(tmp_path / "runs")
        main([
            "search-query", "test", "--research",
            "--provider", "static",
            "--candidate-url", "http://example.com",
            "--work-dir", work_dir,
            "--session", "structure test",
        ])

        session_id = generate_session_id("structure test")
        session_dir = Path(work_dir) / "sessions" / session_id
        assert session_dir.exists()
        assert (session_dir / "session.yaml").exists()
        assert (session_dir / "runs").exists()
        # Run directory should exist under session
        run_dirs = list((session_dir / "runs").iterdir())
        assert len(run_dirs) == 1

    def test_session_multi_run(self, capsys, tmp_path):
        from search_tool.cli import main

        work_dir = str(tmp_path / "runs")
        topic = "multi run session"

        for i in range(3):
            rc = main([
                "search-query", f"query {i}", "--research",
                "--provider", "static",
                "--candidate-url", "http://example.com",
                "--work-dir", work_dir,
                "--session", topic,
            ])
            assert rc == 0

        session_id = generate_session_id(topic)
        session_dir = Path(work_dir) / "sessions" / session_id
        meta = load_session_metadata(session_dir)
        assert meta is not None
        assert meta.runs_total == 3
        assert len(meta.runs) == 3
        assert meta.runs[0].query == "query 0"
        assert meta.runs[2].query == "query 2"

    def test_session_shared_cache(self, tmp_path):
        """Session runs use the shared work-dir cache, not session-scoped."""
        from search_tool.cli import main

        work_dir = str(tmp_path / "runs")
        main([
            "search-query", "test", "--research",
            "--provider", "static",
            "--candidate-url", "http://example.com",
            "--work-dir", work_dir,
            "--session", "cache test",
        ])

        # Shared cache should be at work-dir/cache
        assert (Path(work_dir) / "cache").exists()
        # No session-scoped cache
        session_id = generate_session_id("cache test")
        session_dir = Path(work_dir) / "sessions" / session_id
        assert not (session_dir / "cache").exists()

    def test_session_json_run_number(self, capsys, tmp_path):
        from search_tool.cli import main

        work_dir = str(tmp_path / "runs")
        topic = "run number test"

        # Run 1
        main([
            "search-query", "q1", "--research",
            "--provider", "static",
            "--candidate-url", "http://example.com",
            "--work-dir", work_dir,
            "--session", topic,
        ])
        captured = capsys.readouterr()
        p1 = json.loads(captured.out)
        assert p1["session"]["run_number"] == 1

        # Run 2
        main([
            "search-query", "q2", "--research",
            "--provider", "static",
            "--candidate-url", "http://example.com",
            "--work-dir", work_dir,
            "--session", topic,
        ])
        captured = capsys.readouterr()
        p2 = json.loads(captured.out)
        assert p2["session"]["run_number"] == 2

    def test_session_without_work_dir_error(self, capsys):
        from search_tool.cli import main

        rc = main([
            "search-query", "test",
            "--provider", "static",
            "--candidate-url", "http://example.com",
            "--session", "no work dir",
        ])
        assert rc != 0
        captured = capsys.readouterr()
        assert "--session requires --work-dir" in captured.err

    def test_session_empty_topic_error(self, capsys, tmp_path):
        from search_tool.cli import main

        rc = main([
            "search-query", "test", "--research",
            "--provider", "static",
            "--candidate-url", "http://example.com",
            "--session", "",
        ])
        assert rc != 0

    def test_no_session_json_is_null(self, capsys, tmp_path):
        from search_tool.cli import main

        work_dir = str(tmp_path / "runs")
        rc = main([
            "search-query", "test", "--research",
            "--provider", "static",
            "--candidate-url", "http://example.com",
            "--work-dir", work_dir,
        ])
        captured = capsys.readouterr()
        if rc == 0:
            parsed = json.loads(captured.out)
            assert parsed["session"] is None
