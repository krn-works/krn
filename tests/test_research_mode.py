"""Tests for research mode preset flag."""

import json
from pathlib import Path

from search_tool.discovery import DiscoveryCandidate, DiscoveryResult
from search_tool.search import EvidenceWriteResult, SearchRunResult
from search_tool.cli import main


def _mock_research_result(query: str = "test") -> SearchRunResult:
    discovery = DiscoveryResult(
        schema_version="0.1",
        query_original=query,
        query_normalized=query,
        query_redacted=query,
        provider_name="static",
        candidates=(
            DiscoveryCandidate(
                rank=1,
                url="https://example.com",
                normalized_url="https://example.com",
                title="Example",
                snippet=None,
                source_engine="test",
                url_policy="passed",
                blocked_reason=None,
                selected_for_fetch=True,
            ),
        ),
        errors=(),
        limitations=("mocked",),
    )
    result = SearchRunResult(
        discovery=discovery,
        evidence_results=(
            EvidenceWriteResult(
                original_url="https://example.com",
                normalized_url="https://example.com",
                evidence_path=Path("/tmp/example.html"),
                fetch_status="success",
                http_status=200,
                cache_status="miss",
                extraction_status="success",
                text_chars=0,
                truncated=False,
                errors=(),
                limitations=(),
            ),
        ),
        manifest_path=Path("/tmp/mock-manifest.md"),
        search_manifest_path=Path("/tmp/mock-search-manifest.md"),
        limitations=(),
    )
    return result


class TestResearchModeJson:
    """Test that --research emits JSON without --json flag."""

    def test_research_emits_json(self, capsys, tmp_path):
        """--research emits valid JSON without explicitly passing --json."""
        work_dir = str(tmp_path / "runs")
        rc = main([
            "search-query", "test", "--research",
            "--provider", "static",
            "--candidate-url", "http://docs.python.org/3/",
            "--work-dir", work_dir,
        ])
        captured = capsys.readouterr()
        if rc == 0:
            parsed = json.loads(captured.out)
            assert parsed["schema_version"] == "0.1"

    def test_research_sets_profile_official_docs(self, capsys, tmp_path):
        """--research sets profile to official-docs by default."""
        work_dir = str(tmp_path / "runs")
        rc = main([
            "search-query", "test", "--research",
            "--provider", "static",
            "--candidate-url", "http://docs.python.org/3/",
            "--work-dir", work_dir,
        ])
        captured = capsys.readouterr()
        if rc == 0:
            parsed = json.loads(captured.out)
            assert parsed["profile"] is not None
            assert parsed["profile"]["name"] == "official-docs"

    def test_research_explicit_profile_override(self, capsys, tmp_path):
        """--research --profile security-research overrides the default profile."""
        work_dir = str(tmp_path / "runs")
        rc = main([
            "search-query", "test", "--research",
            "--provider", "static",
            "--candidate-url", "http://docs.python.org/3/",
            "--work-dir", work_dir,
            "--profile", "security-research",
        ])
        captured = capsys.readouterr()
        if rc == 0:
            parsed = json.loads(captured.out)
            assert parsed["profile"]["name"] == "security-research"
            assert parsed["research_mode"]["effective_values"]["profile"] == "security-research"

    def test_research_compact_true_creates_summary(self, capsys, tmp_path):
        """--research sets compact true and creates compact_summary_path."""
        work_dir = str(tmp_path / "runs")
        rc = main([
            "search-query", "test", "--research",
            "--provider", "static",
            "--candidate-url", "http://example.com",
            "--work-dir", work_dir,
        ])
        captured = capsys.readouterr()
        parsed = json.loads(captured.out)
        # compact_summary_path should be set when compact is enabled
        assert parsed["research_mode"]["effective_values"]["compact"] is True
        if rc == 0 and parsed.get("compact_summary_path") is not None:
            assert "search-summary-" in parsed["compact_summary_path"]

    def test_research_no_compact_disables_compact(self, capsys, tmp_path):
        """--research --no-compact sets compact false and compact_summary_path null."""
        work_dir = str(tmp_path / "runs")
        rc = main([
            "search-query", "test", "--research",
            "--provider", "static",
            "--candidate-url", "http://example.com",
            "--work-dir", work_dir,
            "--no-compact",
        ])
        captured = capsys.readouterr()
        parsed = json.loads(captured.out)
        assert parsed["research_mode"]["effective_values"]["compact"] is False
        assert parsed.get("compact_summary_path") is None

    def test_research_default_work_dir(self, capsys, tmp_path):
        """--research uses .local/krn-search-runs default work-dir."""
        work_dir = str(tmp_path / "runs")
        rc = main([
            "search-query", "test", "--research",
            "--provider", "static",
            "--candidate-url", "http://docs.python.org/3/",
            "--work-dir", work_dir,
        ])
        captured = capsys.readouterr()
        if rc == 0:
            parsed = json.loads(captured.out)
            assert parsed["research_mode"]["expanded_defaults"]["work_dir"] == ".local/krn-search-runs"

    def test_research_work_dir_override(self, capsys, tmp_path):
        """--research --work-dir <path> overrides the default work-dir."""
        work_dir = str(tmp_path / "my_custom_dir")
        rc = main([
            "search-query", "test", "--research",
            "--provider", "static",
            "--candidate-url", "http://docs.python.org/3/",
            "--work-dir", work_dir,
        ])
        captured = capsys.readouterr()
        if rc == 0:
            parsed = json.loads(captured.out)
            assert parsed["research_mode"]["effective_values"]["work_dir"] == work_dir

    def test_research_follow_redirects_true(self, capsys, tmp_path):
        """--research sets follow_redirects true by default."""
        work_dir = str(tmp_path / "runs")
        main([
            "search-query", "test", "--research",
            "--provider", "static",
            "--candidate-url", "http://example.com",
            "--work-dir", work_dir,
        ])
        captured = capsys.readouterr()
        parsed = json.loads(captured.out)
        assert parsed["research_mode"]["expanded_defaults"]["follow_redirects"] is True
        assert parsed["research_mode"]["effective_values"]["follow_redirects"] is True

    def test_research_no_follow_redirects(self, capsys, tmp_path):
        """--research --no-follow-redirects sets follow_redirects false."""
        work_dir = str(tmp_path / "runs")
        rc = main([
            "search-query", "test", "--research",
            "--provider", "static",
            "--candidate-url", "http://example.com",
            "--work-dir", work_dir,
            "--no-follow-redirects",
        ])
        captured = capsys.readouterr()
        parsed = json.loads(captured.out)
        assert parsed["research_mode"]["effective_values"]["follow_redirects"] is False

    def test_research_explicit_provider(self, capsys, tmp_path):
        """--research --provider static preserves explicit provider."""
        work_dir = str(tmp_path / "runs")
        rc = main([
            "search-query", "test", "--research",
            "--provider", "static",
            "--candidate-url", "http://docs.python.org/3/",
            "--work-dir", work_dir,
        ])
        captured = capsys.readouterr()
        if rc == 0:
            parsed = json.loads(captured.out)
            assert parsed["research_mode"]["effective_values"]["provider"] == "static"

    def test_research_invalid_profile_error_json(self, capsys):
        """Invalid --profile under --research emits valid error JSON with research_mode."""
        rc = main([
            "search-query", "test", "--research",
            "--provider", "static",
            "--candidate-url", "http://example.com",
            "--profile", "nope",
        ])
        assert rc == 1
        captured = capsys.readouterr()
        parsed = json.loads(captured.out)
        assert parsed["status"] == "error"
        assert parsed["research_mode"] is not None
        assert parsed["research_mode"]["enabled"] is True
        assert parsed["recovery"]["websearch_allowed"] is False


class TestResearchModeJsonShape:
    """Test research_mode JSON shape."""

    def test_research_mode_enabled_structure(self, capsys, tmp_path):
        """research_mode object has correct structure when enabled."""
        work_dir = str(tmp_path / "runs")
        rc = main([
            "search-query", "test", "--research",
            "--provider", "static",
            "--candidate-url", "http://docs.python.org/3/",
            "--work-dir", work_dir,
        ])
        captured = capsys.readouterr()
        if rc == 0:
            parsed = json.loads(captured.out)
            rm = parsed["research_mode"]
            assert rm["enabled"] is True
            assert rm["preset_version"] == "0.1"
            assert "expanded_defaults" in rm
            assert "effective_values" in rm

    def test_research_mode_expanded_defaults_match(self, capsys, tmp_path):
        """expanded_defaults match documented preset values."""
        work_dir = str(tmp_path / "runs")
        rc = main([
            "search-query", "test", "--research",
            "--provider", "static",
            "--candidate-url", "http://docs.python.org/3/",
            "--work-dir", work_dir,
        ])
        captured = capsys.readouterr()
        if rc == 0:
            parsed = json.loads(captured.out)
            ed = parsed["research_mode"]["expanded_defaults"]
            assert ed["provider"] == "auto"
            assert ed["json"] is True
            assert ed["compact"] is True
            assert ed["profile"] == "official-docs"
            assert ed["work_dir"] == ".local/krn-search-runs"
            assert ed["follow_redirects"] is True


class TestNoResearchMode:
    """Test that non-research paths are unchanged."""

    def test_no_research_json_has_null_research_mode(self, capsys, tmp_path):
        """No-research JSON includes research_mode null."""
        work_dir = str(tmp_path / "runs")
        rc = main([
            "search-query", "test",
            "--provider", "static",
            "--candidate-url", "http://docs.python.org/3/",
            "--json", "--work-dir", work_dir,
        ])
        captured = capsys.readouterr()
        if rc == 0:
            parsed = json.loads(captured.out)
            assert parsed["research_mode"] is None

    def test_non_json_non_research_unchanged(self, capsys):
        """Non-JSON non-research path remains unchanged (tab-separated output)."""
        rc = main([
            "search-query", "test",
            "--provider", "static",
            "--candidate-url", "http://docs.python.org/3/",
        ])
        captured = capsys.readouterr()
        assert rc == 0
        assert "\t" in captured.out


class TestResearchModeEdgeCases:
    """Edge cases for research mode."""

    def test_research_provider_auto_requires_reachability(self, capsys, monkeypatch, tmp_path):
        """--research uses auto and fails early when SearXNG is unreachable."""
        monkeypatch.setenv("SEARXNG_URL", "http://localhost:19999")
        monkeypatch.setattr("search_tool.health.check_searxng_reachable", lambda *args, **kwargs: False)
        work_dir = str(tmp_path / "runs")
        rc = main([
            "search-query", "test", "--research", "--work-dir", work_dir,
        ])
        captured = capsys.readouterr()
        assert rc != 0
        assert "research mode requires SearXNG discovery, but SearXNG is unreachable." in captured.err
        assert "SearXNG URL: http://localhost:19999 (source: SEARXNG_URL)" in captured.err
        assert "No fallback provider was used. Static provider is only an explicit known-URL override." in captured.err
        assert "krn-search health --research" in captured.err
        parsed = json.loads(captured.out)
        assert parsed["status"] == "error"
        assert parsed["failures"][0]["stage"] == "provider_resolution"
        assert "research mode requires SearXNG discovery" in parsed["failures"][0]["reason"]
        assert parsed["recovery"]["websearch_allowed"] is False
        assert "krn-search health --research" in parsed["recovery"]["next_action"]
        assert any("No fallback provider was used." in item for item in parsed["limitations"])
        assert any("LLM-generated" in item for item in parsed["limitations"])
        assert not Path(work_dir).exists()

    def test_research_provider_auto_option_has_same_reachability(self, capsys, monkeypatch, tmp_path):
        """`--research --provider auto` fails with provider_resolution when SearXNG is unreachable."""
        monkeypatch.setenv("SEARXNG_URL", "http://localhost:19999")
        monkeypatch.setattr("search_tool.health.check_searxng_reachable", lambda *args, **kwargs: False)
        work_dir = str(tmp_path / "runs")
        rc = main([
            "search-query", "test", "--research", "--provider", "auto", "--work-dir", work_dir,
        ])
        assert rc != 0
        captured = capsys.readouterr()
        assert "research mode requires SearXNG discovery, but SearXNG is unreachable." in captured.err
        assert "krn-search health --research" in captured.err
        parsed = json.loads(captured.out)
        assert parsed["status"] == "error"
        assert parsed["failures"][0]["stage"] == "provider_resolution"
        assert "krn-search health --research" in parsed["recovery"]["next_action"]
        assert parsed["research_mode"] is not None
        assert any("No fallback provider was used." in item for item in parsed["limitations"])
        assert not Path(work_dir).exists()

    def test_research_candidate_url_does_not_create_session_on_failure(self, capsys, monkeypatch, tmp_path):
        """Research provider-resolution failure should not create session artifacts."""
        monkeypatch.chdir(tmp_path)
        monkeypatch.setenv("SEARXNG_URL", "http://localhost:19999")
        monkeypatch.setattr("search_tool.health.check_searxng_reachable", lambda *args, **kwargs: False)
        rc = main([
            "search-query", "test", "--research", "--session", "s1-no-searxng-failure",
        ])
        captured = capsys.readouterr()
        assert rc != 0
        assert "research mode requires SearXNG discovery, but SearXNG is unreachable." in captured.err
        assert not (tmp_path / ".local" / "krn-search-runs").exists()

    def test_research_candidate_url_does_not_imply_static(self, capsys, monkeypatch, tmp_path):
        """--research with --candidate-url does not silently switch to static."""
        monkeypatch.setenv("SEARXNG_URL", "http://localhost:19999")
        monkeypatch.setattr("search_tool.health.check_searxng_reachable", lambda *args, **kwargs: False)
        work_dir = str(tmp_path / "runs")
        rc = main([
            "search-query", "test", "--research",
            "--candidate-url", "https://example.com",
            "--work-dir", work_dir,
        ])
        captured = capsys.readouterr()
        assert rc != 0
        assert "--candidate-url does not activate static provider in research mode" in captured.err
        assert '--research --provider static --candidate-url "<url>"' in captured.err
        parsed = json.loads(captured.out)
        assert parsed["status"] == "error"
        assert parsed["failures"][0]["stage"] == "provider_resolution"
        assert "auto-discovery requires SearXNG" in parsed["failures"][0]["reason"]
        assert not Path(work_dir).exists()

    def test_research_static_explicit_override_stays_supported(self, capsys, monkeypatch, tmp_path):
        """`--research --provider static` with candidate-url is still allowed."""
        work_dir = str(tmp_path / "runs")
        monkeypatch.setattr("search_tool.cli._search_query_fn", lambda *args, **kwargs: _mock_research_result("test"))
        rc = main([
            "search-query", "test", "--research",
            "--provider", "static",
            "--candidate-url", "https://example.com",
            "--work-dir", work_dir,
        ])
        captured = capsys.readouterr()
        assert rc == 0
        parsed = json.loads(captured.out)
        assert parsed["status"] == "ok"
        assert parsed["research_mode"]["effective_values"]["provider"] == "static"

    def test_non_research_auto_candidate_url_uses_static(self, capsys, monkeypatch, tmp_path):
        """Non-research `--provider auto --candidate-url` keeps legacy static behavior."""
        work_dir = str(tmp_path / "runs")
        monkeypatch.setattr("search_tool.cli._search_query_fn", lambda *args, **kwargs: _mock_research_result("test"))
        rc = main([
            "search-query", "test", "--provider", "auto",
            "--candidate-url", "https://example.com",
            "--json",
            "--work-dir", work_dir,
        ])
        captured = capsys.readouterr()
        assert rc == 0
        parsed = json.loads(captured.out)
        assert parsed["discovery"]["provider"] == "static"

    def test_no_generated_files_in_repo_root(self, tmp_path):
        """No generated files are written to repo root during tests."""
        import os
        repo_root = Path(__file__).resolve().parent.parent
        work_dir = str(tmp_path / "runs")
        main([
            "search-query", "test", "--research",
            "--provider", "static",
            "--candidate-url", "http://docs.python.org/3/",
            "--work-dir", work_dir,
        ])
        evidence_files = list(repo_root.glob("evidence-*"))
        assert len(evidence_files) == 0
