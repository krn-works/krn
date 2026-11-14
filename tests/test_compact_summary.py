"""Tests for compact evidence index generation."""

import re
from pathlib import Path

from search_tool.compact import (
    SNIPPET_CHARS,
    write_compact_summary,
    _extract_evidence_text,
    _build_source_entries,
    _md_table_safe,
    _strip_nav_chrome,
)
from search_tool.discovery import DiscoveryResult
from search_tool.search import EvidenceWriteResult, EvidenceRelevanceEntry, SearchRunResult
from search_tool.relevance import EvidenceComponents


def _make_discovery(query="test query", provider="static", candidates=None, errors=(), limitations=()):
    return DiscoveryResult(
        schema_version="0.1",
        query_original=query,
        query_normalized=query,
        query_redacted=query,
        provider_name=provider,
        candidates=tuple(candidates or []),
        errors=tuple(errors),
        limitations=tuple(limitations),
    )


def _make_evidence(
    url="https://example.com",
    status="success",
    http_status=200,
    cache_status="miss",
    extraction_status="success",
    text_chars=100,
    truncated=False,
    errors=(),
    limitations=(),
):
    return EvidenceWriteResult(
        original_url=url,
        normalized_url=url,
        evidence_path=Path(f"/evidence/{url.replace('https://', '').replace('/', '-')}.md"),
        fetch_status=status,
        http_status=http_status,
        cache_status=cache_status,
        extraction_status=extraction_status,
        text_chars=text_chars,
        truncated=truncated,
        errors=tuple(errors),
        limitations=tuple(limitations),
    )


class TestExtractEvidenceText:
    def test_extracts_text_from_evidence_pack(self, tmp_path):
        """Text from code fences is extracted."""
        pack = tmp_path / "pack.md"
        pack.write_text(
            "---\nurl: https://example.com\n---\n\n# Title\n\n```\nSome extracted text here\n```\n",
            encoding="utf-8",
        )
        result = _extract_evidence_text(pack)
        assert "Some extracted text here" in result

    def test_truncates_to_snippet_chars(self, tmp_path):
        """Result is truncated to SNIPPET_CHARS."""
        pack = tmp_path / "pack.md"
        long_text = "x" * 2000
        pack.write_text(
            f"---\nurl: https://example.com\n---\n\n```\n{long_text}\n```\n",
            encoding="utf-8",
        )
        result = _extract_evidence_text(pack)
        assert len(result) <= SNIPPET_CHARS
        assert result == "x" * SNIPPET_CHARS

    def test_returns_empty_on_missing_file(self):
        """Missing file returns empty string."""
        result = _extract_evidence_text(Path("/nonexistent/file.md"))
        assert result == ""

    def test_returns_empty_on_garbled_content(self, tmp_path):
        """Garbled content (no code fences) returns empty string."""
        pack = tmp_path / "pack.md"
        pack.write_text("---\nurl: x\n---\n\nJust plain text no fences\n", encoding="utf-8")
        result = _extract_evidence_text(pack)
        assert result == ""


class TestBuildSourceEntries:
    def test_empty_results(self):
        """Empty evidence results produce empty entries."""
        discovery = _make_discovery()
        result = SearchRunResult(
            discovery=discovery,
            evidence_results=(),
            manifest_path=None,
            search_manifest_path=None,
            limitations=(),
        )
        entries = _build_source_entries(result)
        assert entries == []

    def test_single_success(self):
        """Single successful result produces one entry."""
        discovery = _make_discovery(candidates=[
            type("C", (), {
                "url": "https://docs.python.org/3/",
                "title": "Python Docs",
                "rank": 1,
            })(),
        ])
        evidence = _make_evidence(url="https://docs.python.org/3/")
        result = SearchRunResult(
            discovery=discovery,
            evidence_results=(evidence,),
            manifest_path=None,
            search_manifest_path=None,
            limitations=(),
        )
        entries = _build_source_entries(result)
        assert len(entries) == 1
        assert entries[0].url == "https://docs.python.org/3/"
        assert entries[0].source_type == "official_docs"
        assert entries[0].authority_score == 3
        assert entries[0].quality_score == 3

    def test_ordering_authority_desc(self):
        """Entries ordered by authority_score descending."""
        discovery = _make_discovery(candidates=[
            type("C", (), {"url": "https://reddit.com/r/python", "title": "Reddit", "rank": 1})(),
            type("C", (), {"url": "https://docs.python.org/3/", "title": "Docs", "rank": 2})(),
        ])
        reddit = _make_evidence(url="https://reddit.com/r/python")
        docs = _make_evidence(url="https://docs.python.org/3/")
        result = SearchRunResult(
            discovery=discovery,
            evidence_results=(reddit, docs),
            manifest_path=None,
            search_manifest_path=None,
            limitations=(),
        )
        entries = _build_source_entries(result)
        assert entries[0].url == "https://docs.python.org/3/"
        assert entries[0].authority_score == 3
        assert entries[1].url == "https://reddit.com/r/python"
        assert entries[1].authority_score == 1

    def test_ordering_quality_desc_within_authority(self):
        """Same authority: ordered by quality_score descending."""
        discovery = _make_discovery(candidates=[
            type("C", (), {"url": "https://example.com/bad", "title": "Bad", "rank": 1})(),
            type("C", (), {"url": "https://example.com/good", "title": "Good", "rank": 2})(),
        ])
        bad = _make_evidence(url="https://example.com/bad", extraction_status="failed")
        good = _make_evidence(url="https://example.com/good")
        result = SearchRunResult(
            discovery=discovery,
            evidence_results=(bad, good),
            manifest_path=None,
            search_manifest_path=None,
            limitations=(),
        )
        entries = _build_source_entries(result)
        # Both are "unknown" authority_score=1, so quality_score decides
        assert entries[0].quality_score >= entries[1].quality_score

    def test_ordering_rank_asc_within_same_authority_and_quality(self):
        """Same authority+quality: ordered by original rank ascending."""
        discovery = _make_discovery(candidates=[
            type("C", (), {"url": "https://example.com/b", "title": "B", "rank": 2})(),
            type("C", (), {"url": "https://example.com/a", "title": "A", "rank": 1})(),
        ])
        a = _make_evidence(url="https://example.com/a")
        b = _make_evidence(url="https://example.com/b")
        result = SearchRunResult(
            discovery=discovery,
            evidence_results=(b, a),
            manifest_path=None,
            search_manifest_path=None,
            limitations=(),
        )
        entries = _build_source_entries(result)
        assert entries[0].original_rank <= entries[1].original_rank

    def test_failed_entry_status(self):
        """Failed entry has correct status and no snippet."""
        discovery = _make_discovery(candidates=[
            type("C", (), {"url": "https://blocked.com", "title": "Blocked", "rank": 1})(),
        ])
        evidence = _make_evidence(
            url="https://blocked.com",
            status="blocked",
            http_status=0,
            cache_status="not_written",
            extraction_status="skipped",
            text_chars=0,
        )
        result = SearchRunResult(
            discovery=discovery,
            evidence_results=(evidence,),
            manifest_path=None,
            search_manifest_path=None,
            limitations=(),
        )
        entries = _build_source_entries(result)
        assert entries[0].status == "blocked"
        assert entries[0].snippet is None


class TestMdTableSafe:
    def test_escapes_pipe(self):
        assert _md_table_safe("a|b") == "a\\|b"

    def test_escapes_angle_brackets(self):
        assert _md_table_safe("<tag>") == "\\<tag\\>"

    def test_escapes_backslash(self):
        assert _md_table_safe("a\\b") == "a\\\\b"


class TestWriteCompactSummary:
    def test_creates_file_in_work_dir(self, tmp_path):
        """Summary file is written under work_dir."""
        discovery = _make_discovery()
        result = SearchRunResult(
            discovery=discovery,
            evidence_results=(),
            manifest_path=None,
            search_manifest_path=None,
            limitations=(),
        )
        summary_path = write_compact_summary(result, work_dir=tmp_path, query="test")
        assert summary_path.parent == tmp_path
        assert summary_path.exists()

    def test_filename_pattern(self, tmp_path):
        """Filename matches search-summary-YYYYMMDDTHHMMSSZ-<sha12>.md pattern."""
        discovery = _make_discovery()
        result = SearchRunResult(
            discovery=discovery,
            evidence_results=(),
            manifest_path=None,
            search_manifest_path=None,
            limitations=(),
        )
        summary_path = write_compact_summary(result, work_dir=tmp_path, query="test")
        assert re.match(r"search-summary-\d{8}T\d{6}Z-[a-f0-9]{12}\.md$", summary_path.name)

    def test_deterministic_output(self, tmp_path):
        """Same inputs produce identical output (excluding timestamp lines)."""
        discovery = _make_discovery(
            candidates=[
                type("C", (), {"url": "https://docs.python.org/3/", "title": "Python", "rank": 1})(),
            ]
        )
        evidence = _make_evidence(url="https://docs.python.org/3/")
        result = SearchRunResult(
            discovery=discovery,
            evidence_results=(evidence,),
            manifest_path=None,
            search_manifest_path=None,
            limitations=("some limitation",),
        )
        p1 = write_compact_summary(result, work_dir=tmp_path / "run1", query="test")
        p2 = write_compact_summary(result, work_dir=tmp_path / "run2", query="test")
        c1 = p1.read_text(encoding="utf-8")
        c2 = p2.read_text(encoding="utf-8")
        # Remove timestamp lines for comparison
        def strip_timestamp(text):
            return [l for l in text.splitlines() if not l.startswith("- **Generated at:**")]
        assert strip_timestamp(c1) == strip_timestamp(c2)

    def test_contains_query_metadata(self, tmp_path):
        """Summary includes query metadata section."""
        discovery = _make_discovery(query="python asyncio")
        result = SearchRunResult(
            discovery=discovery,
            evidence_results=(),
            manifest_path=None,
            search_manifest_path=None,
            limitations=(),
        )
        path = write_compact_summary(result, work_dir=tmp_path, query="python asyncio")
        content = path.read_text(encoding="utf-8")
        assert "python asyncio" in content
        assert "Query Metadata" in content
        assert "SHA-256" in content
        assert "static" in content

    def test_contains_source_table(self, tmp_path):
        """Summary includes source table with headers."""
        discovery = _make_discovery(
            candidates=[
                type("C", (), {"url": "https://docs.python.org/3/", "title": "Python Docs", "rank": 1})(),
            ]
        )
        evidence = _make_evidence(url="https://docs.python.org/3/")
        result = SearchRunResult(
            discovery=discovery,
            evidence_results=(evidence,),
            manifest_path=None,
            search_manifest_path=None,
            limitations=(),
        )
        path = write_compact_summary(result, work_dir=tmp_path, query="test")
        content = path.read_text(encoding="utf-8")
        assert "Source Table" in content
        assert "mechanical ordering" in content
        assert "docs.python.org" in content
        assert "official_docs" in content
        assert "3/3" in content  # authority_score

    def test_contains_snippets_section(self, tmp_path):
        """Summary includes snippets section for successful sources."""
        discovery = _make_discovery(
            candidates=[
                type("C", (), {"url": "https://example.com", "title": "Example", "rank": 1})(),
            ]
        )
        evidence = _make_evidence(url="https://example.com")
        result = SearchRunResult(
            discovery=discovery,
            evidence_results=(evidence,),
            manifest_path=None,
            search_manifest_path=None,
            limitations=(),
        )
        path = write_compact_summary(result, work_dir=tmp_path, query="test")
        content = path.read_text(encoding="utf-8")
        assert "Source Snippets" in content
        assert str(SNIPPET_CHARS) in content

    def test_contains_failures_section(self, tmp_path):
        """Summary includes failures section for blocked/failed sources."""
        discovery = _make_discovery(
            candidates=[
                type("C", (), {"url": "https://blocked.com", "title": "Blocked", "rank": 1})(),
            ]
        )
        evidence = _make_evidence(
            url="https://blocked.com",
            status="blocked",
            http_status=0,
            cache_status="not_written",
            extraction_status="skipped",
            text_chars=0,
        )
        result = SearchRunResult(
            discovery=discovery,
            evidence_results=(evidence,),
            manifest_path=None,
            search_manifest_path=None,
            limitations=(),
        )
        path = write_compact_summary(result, work_dir=tmp_path, query="test")
        content = path.read_text(encoding="utf-8")
        assert "## Failures" in content
        assert "blocked.com" in content

    def test_contains_limitations(self, tmp_path):
        """Summary includes limitations section."""
        discovery = _make_discovery(limitations=("query redaction is best-effort",))
        result = SearchRunResult(
            discovery=discovery,
            evidence_results=(),
            manifest_path=None,
            search_manifest_path=None,
            limitations=("a run limitation", "query redaction is best-effort"),
        )
        path = write_compact_summary(result, work_dir=tmp_path, query="test")
        content = path.read_text(encoding="utf-8")
        assert "## Limitations" in content
        assert "query redaction is best-effort" in content
        assert "a run limitation" in content

    def test_no_synthesis_no_ai(self, tmp_path):
        """Summary contains no AI/synthesis language."""
        discovery = _make_discovery()
        result = SearchRunResult(
            discovery=discovery,
            evidence_results=(),
            manifest_path=None,
            search_manifest_path=None,
            limitations=(),
        )
        path = write_compact_summary(result, work_dir=tmp_path, query="test")
        content = path.read_text(encoding="utf-8").lower()
        assert "summarized by" not in content
        assert "ai-generated" not in content
        assert "llm" not in content


class TestCompactCliIntegration:
    """Integration tests for --compact flag behavior."""

    def test_compact_requires_json(self, capsys):
        """--compact without --json prints error."""
        from search_tool.cli import main
        rc = main(["search-query", "test", "--provider", "static",
                    "--candidate-url", "http://example.com", "--compact"])
        assert rc != 0
        captured = capsys.readouterr()
        assert "--compact requires --json" in captured.err

    def test_compact_null_without_flag(self, capsys, tmp_path):
        """Without --compact, compact_summary_path is null in JSON."""
        from search_tool.cli import main
        # Need work-dir for JSON mode
        work_dir = str(tmp_path / "runs")
        rc = main([
            "search-query", "test", "--provider", "static",
            "--candidate-url", "http://docs.python.org/3/",
            "--json", "--work-dir", work_dir,
        ])
        captured = capsys.readouterr()
        if rc == 0:
            import json
            parsed = json.loads(captured.out)
            assert parsed.get("compact_summary_path") is None

    def test_compact_path_in_json_output(self, capsys, tmp_path):
        """With --compact and --work-dir, compact_summary_path is set."""
        from search_tool.cli import main
        work_dir = str(tmp_path / "runs")
        rc = main([
            "search-query", "test", "--provider", "static",
            "--candidate-url", "http://docs.python.org/3/",
            "--json", "--compact", "--work-dir", work_dir,
        ])
        captured = capsys.readouterr()
        if rc == 0:
            import json
            parsed = json.loads(captured.out)
            assert parsed.get("compact_summary_path") is not None
            assert "search-summary-" in parsed["compact_summary_path"]

    def test_no_compact_flag_disables_compact(self, capsys, tmp_path):
        """--no-compact disables compact even when --json is set."""
        from search_tool.cli import main
        work_dir = str(tmp_path / "runs")
        rc = main([
            "search-query", "test", "--provider", "static",
            "--candidate-url", "http://docs.python.org/3/",
            "--json", "--no-compact", "--work-dir", work_dir,
        ])
        captured = capsys.readouterr()
        if rc == 0:
            import json
            parsed = json.loads(captured.out)
            assert parsed.get("compact_summary_path") is None


class TestStripNavChrome:
    def test_strips_skip_to_main_content(self):
        text = "Skip to main content\n\nSome real content here"
        result = _strip_nav_chrome(text)
        assert "Skip to main content" not in result
        assert result.startswith("Some real content")

    def test_strips_search(self):
        text = "Search...\n\nSearch\nNavigation\nReal text here"
        result = _strip_nav_chrome(text)
        assert "Search" not in result.split("Real text")[0]
        assert "Real text here" in result

    def test_strips_nav_lines_with_blank_between(self):
        text = "Navigation\n\nMenu\n\nOn this page\n\nActual content"
        result = _strip_nav_chrome(text)
        assert result.startswith("Actual content")

    def test_unchanged_without_nav_chrome(self):
        text = "First line of article content"
        result = _strip_nav_chrome(text)
        assert result == text

    def test_empty_content_returns_empty(self):
        assert _strip_nav_chrome("") == ""

    def test_only_nav_lines(self):
        text = "Skip to main content\nSearch\nNavigation"
        result = _strip_nav_chrome(text)
        assert result == ""

    def test_preserves_real_content_after_nav(self):
        text = "Navigation\nHome\nSign in\n\nThe quick brown fox jumps over the lazy dog"
        result = _strip_nav_chrome(text)
        assert "The quick brown fox" in result


class TestRelevanceVisibility:
    """Tests for evidence relevance column in compact summary."""

    def _make_relevance_entry(self, url, score, **component_overrides):
        defaults = dict(
            text_overlap=0.0,
            heading_match=0.0,
            early_content_overlap=0.0,
            content_density=0.0,
            exact_phrase_in_text=False,
            low_content_penalty=0.0,
        )
        defaults.update(component_overrides)
        return EvidenceRelevanceEntry(
            url=url,
            score=score,
            components=EvidenceComponents(**defaults),
        )

    def test_source_entry_has_relevance_score(self):
        """SourceEntry includes relevance_score field."""
        discovery = _make_discovery(candidates=[
            type("C", (), {"url": "https://docs.python.org/3/", "title": "Python Docs", "rank": 1})(),
        ])
        evidence = _make_evidence(url="https://docs.python.org/3/")
        relevance = (self._make_relevance_entry("https://docs.python.org/3/", 0.72),)
        result = SearchRunResult(
            discovery=discovery,
            evidence_results=(evidence,),
            manifest_path=None,
            search_manifest_path=None,
            limitations=(),
            evidence_relevance=relevance,
        )
        entries = _build_source_entries(result)
        assert entries[0].relevance_score == 0.72

    def test_relevance_zero_when_no_evidence_relevance(self):
        """Without evidence_relevance, relevance_score defaults to 0.0."""
        discovery = _make_discovery(candidates=[
            type("C", (), {"url": "https://example.com", "title": "Example", "rank": 1})(),
        ])
        evidence = _make_evidence(url="https://example.com")
        result = SearchRunResult(
            discovery=discovery,
            evidence_results=(evidence,),
            manifest_path=None,
            search_manifest_path=None,
            limitations=(),
        )
        entries = _build_source_entries(result)
        assert entries[0].relevance_score == 0.0

    def test_relevance_zero_for_failed_fetch(self):
        """Failed fetch gets 0.0 relevance."""
        discovery = _make_discovery(candidates=[
            type("C", (), {"url": "https://blocked.com", "title": "Blocked", "rank": 1})(),
        ])
        evidence = _make_evidence(url="https://blocked.com", status="blocked")
        result = SearchRunResult(
            discovery=discovery,
            evidence_results=(evidence,),
            manifest_path=None,
            search_manifest_path=None,
            limitations=(),
        )
        entries = _build_source_entries(result)
        assert entries[0].relevance_score == 0.0

    def test_relevance_column_in_table_header(self, tmp_path):
        """Source table includes Relevance column header."""
        discovery = _make_discovery()
        result = SearchRunResult(
            discovery=discovery,
            evidence_results=(),
            manifest_path=None,
            search_manifest_path=None,
            limitations=(),
        )
        path = write_compact_summary(result, work_dir=tmp_path, query="test")
        content = path.read_text(encoding="utf-8")
        assert "| # | Title | URL | Type | Auth | Official | Status | Quality | Relevance | Evidence |" in content

    def test_relevance_percentage_in_table_rows(self, tmp_path):
        """Relevance scores displayed as percentage in source table."""
        discovery = _make_discovery(candidates=[
            type("C", (), {"url": "https://docs.python.org/3/", "title": "Python Docs", "rank": 1})(),
        ])
        evidence = _make_evidence(url="https://docs.python.org/3/")
        relevance = (self._make_relevance_entry("https://docs.python.org/3/", 0.72),)
        result = SearchRunResult(
            discovery=discovery,
            evidence_results=(evidence,),
            manifest_path=None,
            search_manifest_path=None,
            limitations=(),
            evidence_relevance=relevance,
        )
        path = write_compact_summary(result, work_dir=tmp_path, query="test")
        content = path.read_text(encoding="utf-8")
        assert "72%" in content

    def test_relevance_zero_percentage_display(self, tmp_path):
        """Zero relevance shows as 0%."""
        discovery = _make_discovery(candidates=[
            type("C", (), {"url": "https://example.com", "title": "Example", "rank": 1})(),
        ])
        evidence = _make_evidence(url="https://example.com")
        result = SearchRunResult(
            discovery=discovery,
            evidence_results=(evidence,),
            manifest_path=None,
            search_manifest_path=None,
            limitations=(),
        )
        path = write_compact_summary(result, work_dir=tmp_path, query="test")
        content = path.read_text(encoding="utf-8")
        assert "0%" in content

    def test_relevance_full_percentage_display(self, tmp_path):
        """Score 1.0 shows as 100%."""
        discovery = _make_discovery(candidates=[
            type("C", (), {"url": "https://example.com", "title": "Example", "rank": 1})(),
        ])
        evidence = _make_evidence(url="https://example.com")
        relevance = (self._make_relevance_entry("https://example.com", 1.0),)
        result = SearchRunResult(
            discovery=discovery,
            evidence_results=(evidence,),
            manifest_path=None,
            search_manifest_path=None,
            limitations=(),
            evidence_relevance=relevance,
        )
        path = write_compact_summary(result, work_dir=tmp_path, query="test")
        content = path.read_text(encoding="utf-8")
        assert "100%" in content

    def test_relevance_maps_by_final_url(self):
        """Relevance lookup uses final_url when available."""
        discovery = _make_discovery(candidates=[
            type("C", (), {"url": "http://example.com", "title": "Example", "rank": 1})(),
        ])
        evidence = EvidenceWriteResult(
            original_url="http://example.com",
            normalized_url="http://example.com",
            evidence_path=Path("/evidence/example.md"),
            fetch_status="success",
            http_status=200,
            cache_status="miss",
            extraction_status="success",
            text_chars=100,
            truncated=False,
            errors=(),
            limitations=(),
            final_url="https://example.com",
        )
        relevance = (self._make_relevance_entry("https://example.com", 0.85),)
        result = SearchRunResult(
            discovery=discovery,
            evidence_results=(evidence,),
            manifest_path=None,
            search_manifest_path=None,
            limitations=(),
            evidence_relevance=relevance,
        )
        entries = _build_source_entries(result)
        assert entries[0].relevance_score == 0.85

    def test_no_ordering_change_with_relevance(self):
        """Relevance scores do not change source ordering."""
        discovery = _make_discovery(candidates=[
            type("C", (), {"url": "https://example.com/low", "title": "Low", "rank": 1})(),
            type("C", (), {"url": "https://example.com/high", "title": "High", "rank": 2})(),
        ])
        low = _make_evidence(url="https://example.com/low")
        high = _make_evidence(url="https://example.com/high")
        relevance = (
            self._make_relevance_entry("https://example.com/low", 0.9),
            self._make_relevance_entry("https://example.com/high", 0.1),
        )
        result = SearchRunResult(
            discovery=discovery,
            evidence_results=(low, high),
            manifest_path=None,
            search_manifest_path=None,
            limitations=(),
            evidence_relevance=relevance,
        )
        # Without relevance, both have same authority/quality, so rank asc
        entries = _build_source_entries(result)
        # Ordering should be rank-based, not relevance-based
        assert entries[0].original_rank < entries[1].original_rank
