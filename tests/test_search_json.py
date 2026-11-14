"""Tests for search-query --json output."""

import json
from pathlib import Path

from search_tool.search import SearchRunResult, EvidenceWriteResult, DiscoveryResult
from search_tool.cli import _print_search_result_json, _print_search_error_json, main


class TestPrintSearchResultJson:
    """Unit tests for _print_search_result_json."""

    def _make_result(self, evidence_results=None, failures_info=None):
        discovery = DiscoveryResult(
            schema_version="0.1",
            query_original="test query",
            query_normalized="test query",
            query_redacted="test query",
            provider_name="static",
            candidates=tuple(),
            errors=tuple(),
            limitations=("Query redaction is best-effort.",),
        )
        return SearchRunResult(
            discovery=discovery,
            evidence_results=tuple(evidence_results or []),
            manifest_path=None,
            search_manifest_path=Path("/dev/null"),
            limitations=(),
        )

    def test_json_valid_output(self, capsys):
        r = self._make_result()
        _print_search_result_json(r, "test query")
        captured = capsys.readouterr()
        parsed = json.loads(captured.out)
        assert parsed["schema_version"] == "0.1"
        assert parsed["recovery"]["websearch_allowed"] is False

    def test_error_status_no_evidence(self, capsys):
        r = self._make_result()
        _print_search_result_json(r, "test query")
        parsed = json.loads(capsys.readouterr().out)
        assert parsed["status"] == "error"

    def test_ok_status_all_success(self, capsys):
        er = EvidenceWriteResult(
            original_url="https://example.com",
            normalized_url="https://example.com",
            evidence_path=Path("/dev/null"),
            fetch_status="success",
            http_status=200,
            cache_status="miss",
            extraction_status="success",
            text_chars=100,
            truncated=False,
            errors=(),
            limitations=(),
        )
        r = self._make_result(evidence_results=[er])
        _print_search_result_json(r, "test query")
        parsed = json.loads(capsys.readouterr().out)
        assert parsed["status"] == "ok"
        assert len(parsed["evidence_results"]) == 1

    def test_partial_success(self, capsys):
        er1 = EvidenceWriteResult(
            original_url="https://example.com",
            normalized_url="https://example.com",
            evidence_path=Path("/dev/null"),
            fetch_status="success",
            http_status=200,
            cache_status="miss",
            extraction_status="success",
            text_chars=100,
            truncated=False,
            errors=(),
            limitations=(),
        )
        er2 = EvidenceWriteResult(
            original_url="https://blocked.com",
            normalized_url="https://blocked.com",
            evidence_path=Path("/dev/null"),
            fetch_status="blocked",
            http_status=None,
            cache_status="not_written",
            extraction_status="skipped",
            text_chars=0,
            truncated=False,
            errors=("blocked by policy",),
            limitations=(),
        )
        r = self._make_result(evidence_results=[er1, er2])
        _print_search_result_json(r, "test query")
        captured = capsys.readouterr()
        parsed = json.loads(captured.out)
        assert parsed["status"] == "partial_success"
        assert len(parsed["evidence_results"]) == 1
        assert len(parsed["failures"]) == 1

    def test_failures_array(self, capsys):
        er = EvidenceWriteResult(
            original_url="https://fail.com",
            normalized_url="https://fail.com",
            evidence_path=Path("/dev/null"),
            fetch_status="failed",
            http_status=None,
            cache_status="not_written",
            extraction_status="skipped",
            text_chars=0,
            truncated=False,
            errors=("connection error",),
            limitations=(),
        )
        r = self._make_result(evidence_results=[er])
        _print_search_result_json(r, "test query")
        parsed = json.loads(capsys.readouterr().out)
        assert len(parsed["failures"]) == 1
        assert parsed["failures"][0]["url"] == "https://fail.com"

    def test_limitations_included(self, capsys):
        r = self._make_result()
        _print_search_result_json(r, "test query")
        parsed = json.loads(capsys.readouterr().out)
        assert "limitations" in parsed
        assert len(parsed["limitations"]) >= 1

    def test_recovery_websearch_allowed_false(self, capsys):
        r = self._make_result()
        _print_search_result_json(r, "test query")
        parsed = json.loads(capsys.readouterr().out)
        assert parsed["recovery"]["websearch_allowed"] is False

    def test_recovery_next_action_error(self, capsys):
        r = self._make_result()
        _print_search_result_json(r, "test query")
        parsed = json.loads(capsys.readouterr().out)
        assert "No evidence produced" in parsed["recovery"]["next_action"]

    def test_recovery_next_action_ok(self, capsys):
        er = EvidenceWriteResult(
            original_url="https://example.com",
            normalized_url="https://example.com",
            evidence_path=Path("/dev/null"),
            fetch_status="success",
            http_status=200,
            cache_status="miss",
            extraction_status="success",
            text_chars=100,
            truncated=False,
            errors=(),
            limitations=(),
        )
        r = self._make_result(evidence_results=[er])
        _print_search_result_json(r, "test query")
        parsed = json.loads(capsys.readouterr().out)
        assert "Evidence available" in parsed["recovery"]["next_action"]

    def test_source_quality_nested_object(self, capsys):
        er = EvidenceWriteResult(
            original_url="https://docs.python.org/3/library/asyncio.html",
            normalized_url="https://docs.python.org/3/library/asyncio.html",
            evidence_path=Path("/dev/null"),
            fetch_status="success",
            http_status=200,
            cache_status="miss",
            extraction_status="success",
            text_chars=100,
            truncated=False,
            errors=(),
            limitations=(),
        )
        r = self._make_result(evidence_results=[er])
        _print_search_result_json(r, "test query")
        parsed = json.loads(capsys.readouterr().out)
        er_data = parsed["evidence_results"][0]
        sq = er_data["source_quality"]
        assert isinstance(sq, dict)
        assert sq["source_type"] == "official_docs"
        assert sq["authority_score"] == 3
        assert sq["is_official"] is True
        assert sq["is_primary_source"] is True
        assert sq["domain"] == "docs.python.org"
        assert sq["reason"] == "official documentation domain"

    def test_source_quality_keys_stable(self, capsys):
        er = EvidenceWriteResult(
            original_url="https://github.com/owner/repo",
            normalized_url="https://github.com/owner/repo",
            evidence_path=Path("/dev/null"),
            fetch_status="success",
            http_status=200,
            cache_status="miss",
            extraction_status="success",
            text_chars=100,
            truncated=False,
            errors=(),
            limitations=(),
        )
        r = self._make_result(evidence_results=[er])
        _print_search_result_json(r, "test query")
        parsed = json.loads(capsys.readouterr().out)
        sq = parsed["evidence_results"][0]["source_quality"]
        expected_keys = {"source_type", "authority_score", "is_official", "is_primary_source", "domain", "reason"}
        assert set(sq.keys()) == expected_keys

    def test_source_quality_no_secrets(self, capsys):
        er = EvidenceWriteResult(
            original_url="https://user:password@docs.python.org/3/",
            normalized_url="https://docs.python.org/3/",
            evidence_path=Path("/dev/null"),
            fetch_status="success",
            http_status=200,
            cache_status="miss",
            extraction_status="success",
            text_chars=100,
            truncated=False,
            errors=(),
            limitations=(),
        )
        r = self._make_result(evidence_results=[er])
        _print_search_result_json(r, "test query")
        parsed = json.loads(capsys.readouterr().out)
        sq = parsed["evidence_results"][0]["source_quality"]
        assert "password" not in sq.get("domain", "")
        assert "password" not in sq.get("reason", "")

    def test_compact_summary_path_null_by_default(self, capsys):
        r = self._make_result()
        _print_search_result_json(r, "test query")
        parsed = json.loads(capsys.readouterr().out)
        assert "compact_summary_path" in parsed
        assert parsed["compact_summary_path"] is None

    def test_compact_summary_path_set_when_provided(self, capsys):
        r = self._make_result()
        _print_search_result_json(r, "test query", compact_summary_path=Path("/tmp/search-summary-20260514T000000Z-abc123def456.md"))
        parsed = json.loads(capsys.readouterr().out)
        assert parsed["compact_summary_path"] == "/tmp/search-summary-20260514T000000Z-abc123def456.md"

    def test_compact_summary_path_present_in_error_output(self, capsys):
        r = self._make_result()
        _print_search_result_json(r, "test query")
        parsed = json.loads(capsys.readouterr().out)
        assert "compact_summary_path" in parsed

    def test_title_from_evidence_pack_frontmatter(self, capsys, tmp_path):
        """When discovery candidate has no title, title comes from evidence pack frontmatter."""
        pack = tmp_path / "test-pack.md"
        pack.write_text(
            "---\ntitle: \"Building Effective Agents\"\n---\n\n```\nSome content\n```\n",
            encoding="utf-8",
        )
        er = EvidenceWriteResult(
            original_url="https://example.com/article",
            normalized_url="https://example.com/article",
            evidence_path=pack,
            fetch_status="success",
            http_status=200,
            cache_status="miss",
            extraction_status="success",
            text_chars=100,
            truncated=False,
            errors=(),
            limitations=(),
        )
        r = self._make_result(evidence_results=[er])
        _print_search_result_json(r, "test query")
        parsed = json.loads(capsys.readouterr().out)
        assert len(parsed["evidence_results"]) == 1
        assert parsed["evidence_results"][0]["title"] == "Building Effective Agents"

    def test_title_none_when_no_pack_title(self, capsys, tmp_path):
        """When no title is available, title is null."""
        pack = tmp_path / "test-pack.md"
        pack.write_text(
            "---\ntitle: null\n---\n\n```\nSome content\n```\n",
            encoding="utf-8",
        )
        er = EvidenceWriteResult(
            original_url="https://example.com/nopacktitle",
            normalized_url="https://example.com/nopacktitle",
            evidence_path=pack,
            fetch_status="success",
            http_status=200,
            cache_status="miss",
            extraction_status="success",
            text_chars=100,
            truncated=False,
            errors=(),
            limitations=(),
        )
        r = self._make_result(evidence_results=[er])
        _print_search_result_json(r, "test query")
        parsed = json.loads(capsys.readouterr().out)
        assert parsed["evidence_results"][0]["title"] is None

    def test_title_double_backslash_artifact_cleaned(self, capsys, tmp_path):
        """Evidence pack frontmatter with YAML-escaped double backslash separator is cleaned."""
        pack = tmp_path / "test-pack.md"
        # Raw file contains \\ (two backslashes = YAML escape for one)
        pack.write_text(
            "---\ntitle: Building Effective AI Agents \\\\ Anthropic\n---\n\n```\nSome content\n```\n",
            encoding="utf-8",
        )
        er = EvidenceWriteResult(
            original_url="https://example.com/article",
            normalized_url="https://example.com/article",
            evidence_path=pack,
            fetch_status="success",
            http_status=200,
            cache_status="miss",
            extraction_status="success",
            text_chars=100,
            truncated=False,
            errors=(),
            limitations=(),
        )
        r = self._make_result(evidence_results=[er])
        _print_search_result_json(r, "test query")
        parsed = json.loads(capsys.readouterr().out)
        assert parsed["evidence_results"][0]["title"] == "Building Effective AI Agents - Anthropic"

    def test_title_normal_unchanged(self, capsys, tmp_path):
        """Normal titles remain unchanged."""
        pack = tmp_path / "test-pack.md"
        pack.write_text(
            "---\ntitle: \"Building Effective Agents\"\n---\n\n```\nSome content\n```\n",
            encoding="utf-8",
        )
        er = EvidenceWriteResult(
            original_url="https://example.com/article",
            normalized_url="https://example.com/article",
            evidence_path=pack,
            fetch_status="success",
            http_status=200,
            cache_status="miss",
            extraction_status="success",
            text_chars=100,
            truncated=False,
            errors=(),
            limitations=(),
        )
        r = self._make_result(evidence_results=[er])
        _print_search_result_json(r, "test query")
        parsed = json.loads(capsys.readouterr().out)
        assert parsed["evidence_results"][0]["title"] == "Building Effective Agents"

    def test_excerpt_strips_nav_chrome(self, capsys, tmp_path):
        """JSON excerpt should strip nav chrome lines from beginning."""
        pack = tmp_path / "nav-pack.md"
        pack.write_text(
            "---\ntitle: Test\n---\n\n```\nSkip to content\n\nSearch\nNavigation\nReal article content here\n```\n",
            encoding="utf-8",
        )
        er = EvidenceWriteResult(
            original_url="https://example.com",
            normalized_url="https://example.com",
            evidence_path=pack,
            fetch_status="success",
            http_status=200,
            cache_status="miss",
            extraction_status="success",
            text_chars=100,
            truncated=False,
            errors=(),
            limitations=(),
        )
        r = self._make_result(evidence_results=[er])
        _print_search_result_json(r, "test query")
        parsed = json.loads(capsys.readouterr().out)
        excerpt = parsed["evidence_results"][0]["excerpt"]
        assert excerpt is not None
        assert "Skip to content" not in excerpt
        assert "Search" not in excerpt
        assert "Real article content" in excerpt


class TestPrintSearchErrorJson:
    """Unit tests for _print_search_error_json."""

    def test_print_search_error_json_valid(self, capsys):
        _print_search_error_json("test query", "preflight", "some error")
        parsed = json.loads(capsys.readouterr().out)
        assert parsed["schema_version"] == "0.1"

    def test_print_search_error_json_status_error(self, capsys):
        _print_search_error_json("test query", "preflight", "some error")
        parsed = json.loads(capsys.readouterr().out)
        assert parsed["status"] == "error"

    def test_print_search_error_json_websearch_allowed_false(self, capsys):
        _print_search_error_json("test query", "preflight", "some error")
        parsed = json.loads(capsys.readouterr().out)
        assert parsed["recovery"]["websearch_allowed"] is False

    def test_print_search_error_json_empty_evidence(self, capsys):
        _print_search_error_json("test query", "preflight", "some error")
        parsed = json.loads(capsys.readouterr().out)
        assert parsed["evidence_results"] == []
        assert len(parsed["failures"]) == 1

    def test_print_search_error_json_failure_has_stage_reason(self, capsys):
        _print_search_error_json("test query", "provider_resolution", "no candidates")
        parsed = json.loads(capsys.readouterr().out)
        f = parsed["failures"][0]
        assert f["stage"] == "provider_resolution"
        assert f["reason"] == "no candidates"

    def test_print_search_error_json_query_hash(self, capsys):
        _print_search_error_json("test query", "preflight", "err")
        parsed = json.loads(capsys.readouterr().out)
        assert parsed["query"]["redacted"] == "test query"
        assert len(parsed["query"]["hash_sha256"]) == 64

    def test_print_search_error_json_research_mode_null_by_default(self, capsys):
        """Error JSON without research_mode parameter has research_mode null."""
        _print_search_error_json("test query", "preflight", "err")
        parsed = json.loads(capsys.readouterr().out)
        assert parsed["research_mode"] is None

    def test_print_search_error_json_research_mode_present(self, capsys):
        """Error JSON with research_mode parameter includes it."""
        from search_tool.cli import _build_research_mode_json
        rm = _build_research_mode_json(True, {"json": True}, {"json": True, "provider": "static"})
        _print_search_error_json("test query", "preflight", "err", research_mode=rm)
        parsed = json.loads(capsys.readouterr().out)
        assert parsed["research_mode"] is not None
        assert parsed["research_mode"]["enabled"] is True


class TestSearchQueryJsonErrors:
    """Integration tests: CLI search-query --json error paths."""

    def test_auto_provider_json_emits_json_on_failure(self, capsys, monkeypatch):
        monkeypatch.setenv("SEARXNG_URL", "http://localhost:19999")
        rc = main(["search-query", "x", "--provider", "auto", "--json"])
        captured = capsys.readouterr()
        assert rc != 0
        parsed = json.loads(captured.out)
        assert parsed["status"] == "error"
        assert parsed["recovery"]["websearch_allowed"] is False

    def test_static_no_candidate_url_json(self, capsys):
        rc = main(["search-query", "x", "--provider", "static", "--json"])
        captured = capsys.readouterr()
        assert rc != 0
        parsed = json.loads(captured.out)
        assert parsed["status"] == "error"
        assert "candidate-url" in parsed["failures"][0]["reason"].lower()

    def test_searxng_no_url_json(self, capsys):
        rc = main(["search-query", "x", "--provider", "searxng", "--json"])
        captured = capsys.readouterr()
        assert rc != 0
        parsed = json.loads(captured.out)
        assert parsed["status"] == "error"
        assert "searxng-url" in parsed["failures"][0]["reason"].lower()

    def test_empty_query_json(self, capsys):
        rc = main(["search-query", "", "--provider", "static", "--json", "--candidate-url", "http://x"])
        captured = capsys.readouterr()
        assert rc != 0
        parsed = json.loads(captured.out)
        assert parsed["status"] == "error"
        assert parsed["failures"][0]["stage"] == "preflight"

    def test_auto_provider_no_json_no_json_stdout(self, capsys, monkeypatch):
        monkeypatch.setenv("SEARXNG_URL", "http://localhost:19999")
        rc = main(["search-query", "x", "--provider", "auto"])
        captured = capsys.readouterr()
        assert rc != 0
        assert captured.out == ""
        assert "error" in captured.err.lower()
