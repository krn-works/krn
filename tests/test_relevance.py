"""Tests for search_tool/relevance.py — deterministic relevance scoring."""

import json
from pathlib import Path
from unittest.mock import patch

import pytest

from search_tool.discovery import DiscoveryCandidate, DiscoveryResult
from search_tool.relevance import (
    CandidateComponents,
    CandidateRelevance,
    EvidenceComponents,
    EvidenceRelevance,
    QueryTokens,
    STOP_WORDS,
    score_candidate_relevance,
    score_evidence_relevance,
    tokenize_query,
)
from search_tool.search import write_discovery_diagnostics
from search_tool.source_quality import SourceQuality


# --- tokenize_query ---


class TestTokenizeQuery:
    def test_simple_english(self):
        qt = tokenize_query("Building AI Agents")
        assert qt.raw_tokens == ("building", "ai", "agents")
        assert qt.important_tokens == ("building", "ai", "agents")
        assert qt.normalized_query == "building ai agents"

    def test_stop_words_filtered(self):
        qt = tokenize_query("the best way to build an agent")
        assert "the" not in qt.important_tokens
        assert "to" not in qt.important_tokens
        assert "an" not in qt.important_tokens
        assert "best" in qt.important_tokens
        assert "build" in qt.important_tokens
        assert "agent" in qt.important_tokens

    def test_all_stop_words_falls_back_to_raw(self):
        qt = tokenize_query("a an the")
        assert qt.important_tokens == ()
        assert qt.raw_tokens == ("a", "an", "the")
        assert qt.normalized_query == "a an the"

    def test_hyphens_as_separators(self):
        qt = tokenize_query("well-known patterns")
        assert qt.raw_tokens == ("well", "known", "patterns")

    def test_polish_diacritics_preserved(self):
        qt = tokenize_query("Zażółć gęślą jaźń")
        assert "zażółć" in qt.raw_tokens
        assert "gęślą" in qt.raw_tokens
        assert "jaźń" in qt.raw_tokens

    def test_empty_query(self):
        qt = tokenize_query("")
        assert qt.raw_tokens == ()
        assert qt.important_tokens == ()
        assert qt.normalized_query == ""

    def test_whitespace_only(self):
        qt = tokenize_query("   ")
        assert qt.raw_tokens == ()
        assert qt.important_tokens == ()

    def test_single_token(self):
        qt = tokenize_query("Python")
        assert qt.raw_tokens == ("python",)
        assert qt.important_tokens == ("python",)

    def test_mixed_case(self):
        qt = tokenize_query("Building AI Agents")
        assert qt.raw_tokens == ("building", "ai", "agents")

    def test_internal_whitespace_collapsed(self):
        qt = tokenize_query("building   ai    agents")
        assert qt.raw_tokens == ("building", "ai", "agents")


# --- score_candidate_relevance ---


def _candidate(**overrides) -> DiscoveryCandidate:
    defaults = dict(
        rank=1,
        url="https://example.com/docs/building-agents",
        normalized_url="https://example.com/docs/building-agents",
        title="Building AI Agents",
        snippet="A guide to building effective AI agents",
        source_engine="test",
        url_policy="passed",
        blocked_reason=None,
        selected_for_fetch=True,
    )
    defaults.update(overrides)
    return DiscoveryCandidate(**defaults)


def _source_quality(**overrides) -> SourceQuality:
    defaults = dict(
        source_type="unknown",
        authority_score=1,
        is_official=False,
        is_primary_source=False,
        domain="example.com",
        reason="test",
    )
    defaults.update(overrides)
    return SourceQuality(**defaults)


class TestScoreCandidateRelevance:
    def test_all_terms_in_title_high_score(self):
        qt = tokenize_query("Building AI Agents")
        c = _candidate(title="Building AI Agents Guide")
        sq = _source_quality()
        cr = score_candidate_relevance(qt, c, sq)
        assert cr.score > 0.6
        assert cr.components.title_overlap == 1.0

    def test_no_title_overlap_zero(self):
        qt = tokenize_query("Python async await")
        c = _candidate(title=None)
        sq = _source_quality()
        cr = score_candidate_relevance(qt, c, sq)
        assert cr.components.title_overlap == 0.0

    def test_exact_phrase_in_title(self):
        qt = tokenize_query("Building AI Agents")
        c = _candidate(title="Building AI Agents")
        sq = _source_quality()
        cr = score_candidate_relevance(qt, c, sq)
        assert cr.components.exact_phrase_in_title is True

    def test_exact_phrase_in_snippet(self):
        qt = tokenize_query("Building AI Agents")
        c = _candidate(snippet="Learn about building ai agents today")
        sq = _source_quality()
        cr = score_candidate_relevance(qt, c, sq)
        assert cr.components.exact_phrase_in_snippet is True

    def test_generic_listing_title_penalty(self):
        qt = tokenize_query("Python web frameworks")
        c = _candidate(title="Top 10 Python Web Frameworks")
        sq = _source_quality()
        cr = score_candidate_relevance(qt, c, sq)
        assert cr.components.generic_page_penalty == -0.15

    def test_seo_source_type_modifier(self):
        qt = tokenize_query("Python web frameworks")
        c = _candidate(title="Python Web Frameworks")
        sq = _source_quality(source_type="seo")
        cr = score_candidate_relevance(qt, c, sq)
        assert cr.components.source_quality_modifier == -0.20

    def test_official_docs_positive_modifier(self):
        qt = tokenize_query("Python async")
        c = _candidate(title="Python Async IO")
        sq = _source_quality(source_type="official_docs", is_official=True)
        cr = score_candidate_relevance(qt, c, sq)
        assert cr.components.source_quality_modifier == 0.10

    def test_forum_low_authority_modifier(self):
        qt = tokenize_query("Python async")
        c = _candidate(title="Python Async Discussion")
        sq = _source_quality(source_type="forum", authority_score=1)
        cr = score_candidate_relevance(qt, c, sq)
        assert cr.components.source_quality_modifier == -0.10

    def test_forum_high_authority_no_modifier(self):
        qt = tokenize_query("Python async")
        c = _candidate(title="Python Async Discussion")
        sq = _source_quality(source_type="forum", authority_score=2)
        cr = score_candidate_relevance(qt, c, sq)
        assert cr.components.source_quality_modifier == 0.0

    def test_empty_snippet_overlap_zero(self):
        qt = tokenize_query("Python async")
        c = _candidate(snippet=None)
        sq = _source_quality()
        cr = score_candidate_relevance(qt, c, sq)
        assert cr.components.snippet_overlap == 0.0

    def test_empty_query_score_zero(self):
        qt = tokenize_query("")
        c = _candidate()
        sq = _source_quality()
        cr = score_candidate_relevance(qt, c, sq)
        assert cr.score == 0.0

    def test_all_stop_words_uses_raw_tokens(self):
        qt = tokenize_query("a an the")
        c = _candidate(title="A An The Guide")
        sq = _source_quality()
        cr = score_candidate_relevance(qt, c, sq)
        assert cr.components.title_overlap > 0.0

    def test_url_path_overlap(self):
        qt = tokenize_query("python async")
        c = _candidate(url="https://example.com/docs/python-async-guide")
        sq = _source_quality()
        cr = score_candidate_relevance(qt, c, sq)
        assert cr.components.url_path_overlap > 0.0

    def test_generic_path_segment_penalty(self):
        qt = tokenize_query("python async")
        c = _candidate(url="https://example.com/category/python-async")
        sq = _source_quality()
        cr = score_candidate_relevance(qt, c, sq)
        assert cr.components.generic_page_penalty == -0.15

    def test_score_clamped_to_0_and_1(self):
        qt = tokenize_query("test")
        c = _candidate(title="test", snippet="test")
        sq = _source_quality()
        cr = score_candidate_relevance(qt, c, sq)
        assert 0.0 <= cr.score <= 1.0

    def test_generic_path_search_penalty(self):
        qt = tokenize_query("python tutorial")
        c = _candidate(url="https://example.com/search?q=python")
        sq = _source_quality()
        cr = score_candidate_relevance(qt, c, sq)
        assert cr.components.generic_page_penalty == -0.15

    def test_empty_snippet_penalty(self):
        qt = tokenize_query("python async")
        c = _candidate(snippet=None, title="Python Async")
        sq = _source_quality()
        cr = score_candidate_relevance(qt, c, sq)
        assert cr.components.generic_page_penalty == -0.10

    def test_penalty_not_cumulative_uses_largest(self):
        qt = tokenize_query("python")
        c = _candidate(title="Top 10 Python Tools", snippet=None, url="https://example.com/category/python")
        sq = _source_quality()
        cr = score_candidate_relevance(qt, c, sq)
        assert cr.components.generic_page_penalty == -0.15

    def test_short_token_does_not_match_inside_word(self):
        qt = tokenize_query("AI agents")
        c = _candidate(
            title="Main available pages",
            snippet="Said chair remains available",
            url="https://example.com/main-available",
        )
        sq = _source_quality()
        cr = score_candidate_relevance(qt, c, sq)
        assert cr.components.title_overlap == 0.0
        assert cr.components.snippet_overlap == 0.0

    def test_short_token_matches_as_whole_token(self):
        qt = tokenize_query("AI agents")
        c = _candidate(
            title="AI agents guide",
            snippet="Building AI agents",
            url="https://example.com/ai-agents",
        )
        sq = _source_quality()
        cr = score_candidate_relevance(qt, c, sq)
        assert cr.components.title_overlap == 1.0

    def test_hyphenated_text_matches_tokens(self):
        qt = tokenize_query("web frameworks")
        c = _candidate(
            title="Best web-frameworks for Python",
            snippet="Comparing web-frameworks",
            url="https://example.com/web-frameworks",
        )
        sq = _source_quality()
        cr = score_candidate_relevance(qt, c, sq)
        assert cr.components.title_overlap == 1.0
        assert cr.components.snippet_overlap == 1.0


# --- Integration: diagnostics output ---


class TestDiagnosticsCandidateRelevance:
    def test_selected_candidate_has_relevance(self, tmp_path):
        discovery = DiscoveryResult(
            schema_version="0.1",
            query_original="Building AI Agents",
            query_normalized="building ai agents",
            query_redacted="Building AI Agents",
            provider_name="static",
            candidates=(
                DiscoveryCandidate(
                    rank=1,
                    url="https://docs.example.com/building-agents",
                    normalized_url="https://docs.example.com/building-agents",
                    title="Building AI Agents",
                    snippet="A guide to building effective AI agents",
                    source_engine="static",
                    url_policy="passed",
                    blocked_reason=None,
                    selected_for_fetch=True,
                ),
            ),
            errors=(),
            limitations=(),
        )
        path = write_discovery_diagnostics(
            discovery=discovery,
            query="Building AI Agents",
            target_dir=tmp_path,
        )
        data = json.loads(path.read_text(encoding="utf-8"))
        selected = data["selected_candidates"]
        assert len(selected) == 1
        cr = selected[0]["candidate_relevance"]
        assert "score" in cr
        assert "components" in cr
        comp = cr["components"]
        assert "title_overlap" in comp
        assert "snippet_overlap" in comp
        assert "url_path_overlap" in comp
        assert "exact_phrase_in_title" in comp
        assert "exact_phrase_in_snippet" in comp
        assert "source_quality_modifier" in comp
        assert "generic_page_penalty" in comp
        assert cr["score"] > 0.0

    def test_empty_query_relevance_score_zero(self, tmp_path):
        discovery = DiscoveryResult(
            schema_version="0.1",
            query_original="",
            query_normalized="",
            query_redacted="",
            provider_name="static",
            candidates=(
                DiscoveryCandidate(
                    rank=1,
                    url="https://example.com/a",
                    normalized_url="https://example.com/a",
                    title="Example",
                    snippet="snippet",
                    source_engine="static",
                    url_policy="passed",
                    blocked_reason=None,
                    selected_for_fetch=True,
                ),
            ),
            errors=(),
            limitations=(),
        )
        path = write_discovery_diagnostics(
            discovery=discovery,
            query="",
            target_dir=tmp_path,
        )
        data = json.loads(path.read_text(encoding="utf-8"))
        cr = data["selected_candidates"][0]["candidate_relevance"]
        assert cr["score"] == 0.0

    def test_multiple_candidates_each_have_relevance(self, tmp_path):
        discovery = DiscoveryResult(
            schema_version="0.1",
            query_original="Python async",
            query_normalized="python async",
            query_redacted="Python async",
            provider_name="static",
            candidates=(
                DiscoveryCandidate(
                    rank=1,
                    url="https://docs.python.org/async",
                    normalized_url="https://docs.python.org/async",
                    title="Python Async IO",
                    snippet="Async programming in Python",
                    source_engine="static",
                    url_policy="passed",
                    blocked_reason=None,
                    selected_for_fetch=True,
                ),
                DiscoveryCandidate(
                    rank=2,
                    url="https://example.com/unrelated",
                    normalized_url="https://example.com/unrelated",
                    title="Cooking Recipes",
                    snippet="Best recipes for dinner",
                    source_engine="static",
                    url_policy="passed",
                    blocked_reason=None,
                    selected_for_fetch=True,
                ),
            ),
            errors=(),
            limitations=(),
        )
        path = write_discovery_diagnostics(
            discovery=discovery,
            query="Python async",
            target_dir=tmp_path,
        )
        data = json.loads(path.read_text(encoding="utf-8"))
        selected = data["selected_candidates"]
        assert len(selected) == 2
        assert selected[0]["candidate_relevance"]["score"] > selected[1]["candidate_relevance"]["score"]


# --- score_evidence_relevance ---


def _write_evidence_pack(tmp_path: Path, text: str) -> Path:
    """Write a minimal evidence pack with the given extracted text."""
    content = (
        "---\n"
        'schema_version: "0.1"\n'
        "fetch:\n"
        '  status: "success"\n'
        "extraction:\n"
        '  status: "success"\n'
        "---\n"
        "# Evidence Pack\n"
        "## Extracted source content\n"
        "```\n"
        f"{text}\n"
        "```\n"
    )
    path = tmp_path / "evidence-test.md"
    path.write_text(content, encoding="utf-8")
    return path


class TestScoreEvidenceRelevance:
    def test_terms_in_text_high_overlap(self, tmp_path):
        qt = tokenize_query("Building AI Agents")
        path = _write_evidence_pack(tmp_path, "Building AI Agents Guide\n\nThis is about building AI agents.")
        ev = score_evidence_relevance(qt, path)
        assert ev.score > 0.5
        assert ev.components.text_overlap > 0.0

    def test_failed_fetch_score_zero(self, tmp_path):
        qt = tokenize_query("Building AI Agents")
        path = _write_evidence_pack(tmp_path, "Building AI Agents content")
        ev = score_evidence_relevance(qt, path, fetch_status="failed")
        assert ev.score == 0.0

    def test_failed_extraction_score_zero(self, tmp_path):
        qt = tokenize_query("Building AI Agents")
        path = _write_evidence_pack(tmp_path, "Building AI Agents content")
        ev = score_evidence_relevance(qt, path, extraction_status="failed")
        assert ev.score == 0.0

    def test_blocked_fetch_score_zero(self, tmp_path):
        qt = tokenize_query("Building AI Agents")
        path = _write_evidence_pack(tmp_path, "content")
        ev = score_evidence_relevance(qt, path, fetch_status="blocked")
        assert ev.score == 0.0

    def test_skipped_duplicate_score_zero(self, tmp_path):
        qt = tokenize_query("Building AI Agents")
        path = _write_evidence_pack(tmp_path, "content")
        ev = score_evidence_relevance(qt, path, fetch_status="skipped_duplicate")
        assert ev.score == 0.0

    def test_truncated_extraction_scores_content(self, tmp_path):
        qt = tokenize_query("Building AI Agents")
        path = _write_evidence_pack(
            tmp_path,
            "Building AI Agents Guide\n\nThis is about building AI agents.",
        )
        ev = score_evidence_relevance(
            qt, path,
            fetch_status="success",
            extraction_status="truncated",
        )
        assert ev.score > 0.0
        assert ev.components.text_overlap > 0.0

    def test_empty_text_penalty(self, tmp_path):
        qt = tokenize_query("Building AI Agents")
        path = _write_evidence_pack(tmp_path, "")
        ev = score_evidence_relevance(qt, path)
        assert ev.components.low_content_penalty == -0.20

    def test_short_text_penalty(self, tmp_path):
        qt = tokenize_query("Building AI Agents")
        path = _write_evidence_pack(tmp_path, "Short text")
        ev = score_evidence_relevance(qt, path)
        assert ev.components.low_content_penalty == -0.20

    def test_nav_only_content_penalty(self, tmp_path):
        lines = ["Skip to main content", "Navigation", "Menu", "Search...", "Sign in"]
        text = "\n".join(lines * 10)
        qt = tokenize_query("Building AI Agents")
        path = _write_evidence_pack(tmp_path, text)
        ev = score_evidence_relevance(qt, path)
        assert ev.components.content_density < 0.3
        assert ev.components.low_content_penalty == -0.20

    def test_heading_match(self, tmp_path):
        text = "# Building AI Agents\n\nSome content about the topic."
        qt = tokenize_query("Building AI Agents")
        path = _write_evidence_pack(tmp_path, text)
        ev = score_evidence_relevance(qt, path)
        assert ev.components.heading_match > 0.0

    def test_no_heading_match(self, tmp_path):
        text = "Some content about unrelated things.\n" * 20
        qt = tokenize_query("Building AI Agents")
        path = _write_evidence_pack(tmp_path, text)
        ev = score_evidence_relevance(qt, path)
        assert ev.components.heading_match == 0.0

    def test_exact_phrase_in_text(self, tmp_path):
        text = "This document covers building ai agents in depth.\n" * 20
        qt = tokenize_query("Building AI Agents")
        path = _write_evidence_pack(tmp_path, text)
        ev = score_evidence_relevance(qt, path)
        assert ev.components.exact_phrase_in_text is True

    def test_exact_phrase_not_in_text(self, tmp_path):
        text = "This document covers AI systems and machine learning.\n" * 20
        qt = tokenize_query("Building AI Agents")
        path = _write_evidence_pack(tmp_path, text)
        ev = score_evidence_relevance(qt, path)
        assert ev.components.exact_phrase_in_text is False

    def test_early_content_higher_than_full(self, tmp_path):
        # Query terms in first 2000 chars but not in the rest
        prefix = "building ai agents " * 100
        suffix = "unrelated content " * 200
        text = prefix + suffix
        qt = tokenize_query("Building AI Agents")
        path = _write_evidence_pack(tmp_path, text)
        ev = score_evidence_relevance(qt, path)
        assert ev.components.early_content_overlap >= ev.components.text_overlap

    def test_content_density_good(self, tmp_path):
        text = "\n".join(
            f"Line {i} about building AI agents and related topics."
            for i in range(50)
        )
        qt = tokenize_query("Building AI Agents")
        path = _write_evidence_pack(tmp_path, text)
        ev = score_evidence_relevance(qt, path)
        assert ev.components.content_density > 0.5

    def test_empty_query_score_zero(self, tmp_path):
        qt = tokenize_query("")
        path = _write_evidence_pack(tmp_path, "Some content about things.")
        ev = score_evidence_relevance(qt, path)
        assert ev.score == 0.0

    def test_score_clamped_0_to_1(self, tmp_path):
        qt = tokenize_query("test")
        path = _write_evidence_pack(tmp_path, "test " * 500)
        ev = score_evidence_relevance(qt, path)
        assert 0.0 <= ev.score <= 1.0

    def test_nonexistent_file_zero_score(self, tmp_path):
        qt = tokenize_query("Building AI Agents")
        path = tmp_path / "nonexistent.md"
        ev = score_evidence_relevance(qt, path)
        assert ev.score == 0.0

    def test_short_text_early_equals_text_overlap(self, tmp_path):
        text = "Building AI agents is the topic here."
        qt = tokenize_query("Building AI Agents")
        path = _write_evidence_pack(tmp_path, text)
        ev = score_evidence_relevance(qt, path)
        assert ev.components.early_content_overlap == ev.components.text_overlap

    def test_h2_heading_extracted(self, tmp_path):
        text = "## Building AI Agents\n\nContent about the topic.\n" * 20
        qt = tokenize_query("Building AI Agents")
        path = _write_evidence_pack(tmp_path, text)
        ev = score_evidence_relevance(qt, path)
        assert ev.components.heading_match > 0.0

    def test_h3_heading_extracted(self, tmp_path):
        text = "### Building AI Agents\n\nContent about the topic.\n" * 20
        qt = tokenize_query("Building AI Agents")
        path = _write_evidence_pack(tmp_path, text)
        ev = score_evidence_relevance(qt, path)
        assert ev.components.heading_match > 0.0


# --- Integration: SearchRunResult evidence_relevance ---


class TestSearchRunResultEvidenceRelevance:
    def test_search_run_result_has_evidence_relevance(self):
        from search_tool.search import SearchRunResult, EvidenceRelevanceEntry
        from search_tool.discovery import DiscoveryResult, DiscoveryCandidate

        discovery = DiscoveryResult(
            schema_version="0.1",
            query_original="test",
            query_normalized="test",
            query_redacted="test",
            provider_name="static",
            candidates=(),
            errors=(),
            limitations=(),
        )

        ev_comp = EvidenceComponents(
            text_overlap=0.5,
            heading_match=0.3,
            early_content_overlap=0.6,
            content_density=0.8,
            exact_phrase_in_text=True,
            low_content_penalty=0.0,
        )
        entry = EvidenceRelevanceEntry(
            url="https://example.com",
            score=0.72,
            components=ev_comp,
        )

        result = SearchRunResult(
            discovery=discovery,
            evidence_results=(),
            manifest_path=None,
            search_manifest_path=None,
            limitations=(),
            evidence_relevance=(entry,),
        )
        assert len(result.evidence_relevance) == 1
        assert result.evidence_relevance[0].url == "https://example.com"
        assert result.evidence_relevance[0].score == 0.72


class TestManifestEvidenceRelevance:
    def test_manifest_includes_evidence_relevance_summary(self, tmp_path):
        from search_tool.search import (
            write_search_run_manifest,
            EvidenceRelevanceEntry,
            EvidenceWriteResult,
        )
        from search_tool.discovery import DiscoveryResult

        discovery = DiscoveryResult(
            schema_version="0.1",
            query_original="Building AI Agents",
            query_normalized="building ai agents",
            query_redacted="Building AI Agents",
            provider_name="static",
            candidates=(),
            errors=(),
            limitations=(),
        )

        ev_comp = EvidenceComponents(
            text_overlap=0.67,
            heading_match=1.0,
            early_content_overlap=0.83,
            content_density=0.71,
            exact_phrase_in_text=True,
            low_content_penalty=0.0,
        )
        relevance = (
            EvidenceRelevanceEntry(
                url="https://example.com/docs/building-agents",
                score=0.72,
                components=ev_comp,
            ),
        )

        manifest_path = write_search_run_manifest(
            discovery=discovery,
            evidence_results=(),
            fetch_list_manifest=None,
            query="Building AI Agents",
            evidence_dir=tmp_path,
            evidence_relevance=relevance,
        )

        content = manifest_path.read_text(encoding="utf-8")
        assert "evidence_relevance:" in content
        assert "score: 0.72" in content

    def test_manifest_no_component_details(self, tmp_path):
        from search_tool.search import (
            write_search_run_manifest,
            EvidenceRelevanceEntry,
        )
        from search_tool.discovery import DiscoveryResult

        discovery = DiscoveryResult(
            schema_version="0.1",
            query_original="test",
            query_normalized="test",
            query_redacted="test",
            provider_name="static",
            candidates=(),
            errors=(),
            limitations=(),
        )

        ev_comp = EvidenceComponents(
            text_overlap=0.5,
            heading_match=0.3,
            early_content_overlap=0.6,
            content_density=0.8,
            exact_phrase_in_text=True,
            low_content_penalty=0.0,
        )
        relevance = (
            EvidenceRelevanceEntry(
                url="https://example.com",
                score=0.5,
                components=ev_comp,
            ),
        )

        manifest_path = write_search_run_manifest(
            discovery=discovery,
            evidence_results=(),
            fetch_list_manifest=None,
            query="test",
            evidence_dir=tmp_path,
            evidence_relevance=relevance,
        )

        content = manifest_path.read_text(encoding="utf-8")
        assert "text_overlap:" not in content
        assert "heading_match:" not in content
        assert "content_density:" not in content
        assert "early_content_overlap:" not in content

    def test_manifest_no_evidence_relevance_omits_section(self, tmp_path):
        from search_tool.search import write_search_run_manifest
        from search_tool.discovery import DiscoveryResult

        discovery = DiscoveryResult(
            schema_version="0.1",
            query_original="test",
            query_normalized="test",
            query_redacted="test",
            provider_name="static",
            candidates=(),
            errors=(),
            limitations=(),
        )

        manifest_path = write_search_run_manifest(
            discovery=discovery,
            evidence_results=(),
            fetch_list_manifest=None,
            query="test",
            evidence_dir=tmp_path,
            evidence_relevance=(),
        )

        content = manifest_path.read_text(encoding="utf-8")
        assert "evidence_relevance:" not in content
