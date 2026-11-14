"""Tests for search_tool/search.py — search query composition."""

from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

from search_tool.discovery import (
    DiscoveryError,
    DiscoveryResult,
    RawDiscoveryCandidate,
    StaticDiscoveryProvider,
    urls_for_fetch,
    DiscoveryCandidate,
)
from search_tool.search import (
    SearchRunResult,
    search_query,
    EvidenceWriteResult,
    write_search_run_manifest,
)


def _mock_evidence(url: str, status: str = "success") -> EvidenceWriteResult:
    return EvidenceWriteResult(
        original_url=url,
        normalized_url=url,
        evidence_path=Path(f"evidence/{url.replace('/', '-')}.md"),
        fetch_status=status,
        http_status=200 if status == "success" else None,
        cache_status="miss",
        extraction_status="success" if status == "success" else "skipped",
        text_chars=100 if status == "success" else 0,
        truncated=False,
        errors=(),
        limitations=(),
    )


@pytest.fixture
def mock_public_dns():
    with patch("search_tool.url_policy.socket.getaddrinfo") as mock_dns:
        mock_dns.return_value = [(2, 1, 6, "", ("93.184.216.34", 0))]
        yield mock_dns


class TestSearchRunResultDataclass:
    def test_frozen(self, mock_public_dns):
        provider = StaticDiscoveryProvider(
            name="test",
            candidates=(RawDiscoveryCandidate(url="https://example.com"),),
        )
        result = search_query(
            provider, "test",
            fetcher=lambda u, r, f, **kw: _mock_evidence(u),
        )
        with pytest.raises(AttributeError):
            result.discovery = None  # type: ignore[misc]

    def test_fields_accessible(self, mock_public_dns):
        provider = StaticDiscoveryProvider(
            name="test",
            candidates=(RawDiscoveryCandidate(url="https://example.com"),),
        )
        result = search_query(
            provider, "test",
            fetcher=lambda u, r, f, **kw: _mock_evidence(u),
        )
        assert isinstance(result.discovery, DiscoveryResult)
        assert isinstance(result.evidence_results, tuple)
        assert isinstance(result.limitations, tuple)


class TestSearchQuerySuccess:
    def test_returns_discovery_and_evidence(self, mock_public_dns):
        provider = StaticDiscoveryProvider(
            name="static",
            candidates=(
                RawDiscoveryCandidate(url="https://a.com"),
                RawDiscoveryCandidate(url="https://b.com"),
            ),
        )
        result = search_query(
            provider, "test",
            fetcher=lambda u, r, f, **kw: _mock_evidence(u),
        )
        assert isinstance(result.discovery, DiscoveryResult)
        assert len(result.evidence_results) == 2
        assert all(isinstance(r, EvidenceWriteResult) for r in result.evidence_results)

    def test_manifest_writer_called_with_results(self, mock_public_dns):
        provider = StaticDiscoveryProvider(
            name="static",
            candidates=(RawDiscoveryCandidate(url="https://example.com"),),
        )
        mock_writer = MagicMock(return_value=Path("evidence/manifest-test.md"))
        result = search_query(
            provider, "test",
            fetcher=lambda u, r, f, **kw: _mock_evidence(u),
            manifest_writer=mock_writer,
        )
        mock_writer.assert_called_once()
        call_args = mock_writer.call_args
        assert len(call_args[0][0]) == 1
        assert call_args[0][1] == "search-query"
        assert result.manifest_path == Path("evidence/manifest-test.md")

    def test_search_query_returns_search_manifest_path(self, mock_public_dns):
        provider = StaticDiscoveryProvider(
            name="static",
            candidates=(RawDiscoveryCandidate(url="https://example.com"),),
        )
        mock_search_writer = MagicMock(return_value=Path("evidence/search-run.md"))
        result = search_query(
            provider, "test",
            fetcher=lambda u, r, f, **kw: _mock_evidence(u),
            search_manifest_writer=mock_search_writer,
        )
        assert result.search_manifest_path == Path("evidence/search-run.md")
        mock_search_writer.assert_called_once()


class TestSearchQueryMaxCandidates:
    def test_max_candidates_passed_to_provider(self, mock_public_dns):
        provider = StaticDiscoveryProvider(
            name="static",
            candidates=tuple(RawDiscoveryCandidate(url=f"https://example.com/{i}") for i in range(20)),
        )
        result = search_query(
            provider, "test",
            max_candidates=3,
            fetcher=lambda u, r, f, **kw: _mock_evidence(u),
        )
        assert len(result.evidence_results) == 3


class TestSearchQueryFetchOptions:
    def test_refresh_passed_to_fetcher(self, mock_public_dns):
        captured = {}
        def _fetch(url, refresh, follow_redirects, **kw):
            captured["refresh"] = refresh
            captured["follow_redirects"] = follow_redirects
            return _mock_evidence(url)

        provider = StaticDiscoveryProvider(
            name="static",
            candidates=(RawDiscoveryCandidate(url="https://example.com"),),
        )
        search_query(provider, "test", refresh=True, follow_redirects=True, fetcher=_fetch)
        assert captured["refresh"] is True
        assert captured["follow_redirects"] is True

    def test_default_fetch_options(self, mock_public_dns):
        captured = {}
        def _fetch(url, refresh, follow_redirects, **kw):
            captured["refresh"] = refresh
            captured["follow_redirects"] = follow_redirects
            return _mock_evidence(url)

        provider = StaticDiscoveryProvider(
            name="static",
            candidates=(RawDiscoveryCandidate(url="https://example.com"),),
        )
        search_query(provider, "test", fetcher=_fetch)
        assert captured["refresh"] is False
        assert captured["follow_redirects"] is False


class TestSearchQueryProviderError:
    def test_provider_errors_zero_urls_no_fetch(self, mock_public_dns):
        provider = MagicMock()
        provider.name = "mock"
        provider.discover.return_value = DiscoveryResult(
            schema_version="0.1",
            query_original="test",
            query_normalized="test",
            query_redacted="test",
            provider_name="mock",
            candidates=(),
            errors=(DiscoveryError(code="server_error", message="down"),),
            limitations=("Provider failed.",),
        )
        fetch_calls = []
        result = search_query(
            provider, "test",
            fetcher=lambda u, r, f, **kw: (fetch_calls.append(u), _mock_evidence(u))[1],
        )
        assert len(result.evidence_results) == 0
        assert len(fetch_calls) == 0
        assert result.discovery.errors[0].code == "server_error"


class TestSearchQueryPartialFetch:
    def test_partial_failure_returns_all_results(self, mock_public_dns):
        call_count = 0
        def _fetch(url, refresh, follow_redirects, **kw):
            nonlocal call_count
            call_count += 1
            if call_count == 1:
                return _mock_evidence(url, status="failed")
            return _mock_evidence(url, status="success")

        provider = StaticDiscoveryProvider(
            name="static",
            candidates=(
                RawDiscoveryCandidate(url="https://fail.com"),
                RawDiscoveryCandidate(url="https://ok.com"),
            ),
        )
        result = search_query(provider, "test", fetcher=_fetch)
        assert len(result.evidence_results) == 2
        assert result.evidence_results[0].fetch_status == "failed"
        assert result.evidence_results[1].fetch_status == "success"


class TestSearchQueryDuplicateUrls:
    def test_duplicates_fetched_once(self, mock_public_dns):
        fetch_calls = []
        def _fetch(url, refresh, follow_redirects, **kw):
            fetch_calls.append(url)
            return _mock_evidence(url)

        provider = StaticDiscoveryProvider(
            name="static",
            candidates=(
                RawDiscoveryCandidate(url="https://example.com"),
                RawDiscoveryCandidate(url="https://example.com/"),
            ),
        )
        result = search_query(provider, "test", fetcher=_fetch)
        assert len(fetch_calls) == 1
        assert len(result.evidence_results) == 1


class TestSearchQueryBlockedUrls:
    def test_blocked_urls_not_fetched(self):
        provider = StaticDiscoveryProvider(
            name="static",
            candidates=(RawDiscoveryCandidate(url="file:///etc/passwd"),),
        )
        fetch_calls = []
        result = search_query(
            provider, "test",
            fetcher=lambda u, r, f, **kw: (fetch_calls.append(u), _mock_evidence(u))[1],
        )
        assert len(fetch_calls) == 0
        assert len(result.evidence_results) == 0


class TestWriteSearchRunManifest:
    def test_writes_file_with_frontmatter(self, tmp_path, monkeypatch):
        monkeypatch.setattr("search_tool.search.EVIDENCE_DIR", tmp_path / "evidence")
        (tmp_path / "evidence").mkdir()

        discovery = DiscoveryResult(
            schema_version="0.1",
            query_original="test secret key sk-123",
            query_normalized="test secret key sk-123",
            query_redacted="test secret key [REDACTED]",
            provider_name="static",
            candidates=(
                DiscoveryCandidate(
                    rank=1, url="https://example.com", normalized_url="https://example.com/",
                    title="Example", snippet="Snippet", source_engine="static",
                    url_policy="passed", blocked_reason=None, selected_for_fetch=True
                ),
            ),
            errors=(),
            limitations=("Redaction warning",)
        )
        evidence = (_mock_evidence("https://example.com"),)

        path = write_search_run_manifest(
            discovery=discovery,
            evidence_results=evidence,
            fetch_list_manifest=Path("evidence/manifest-abc.md"),
            query="test secret key sk-123",
            provider_config={"max_candidates": 10},
        )

        assert path.exists()
        content = path.read_text()
        assert "artifact_type: \"search_run_manifest\"" in content
        assert "original_sha256:" in content
        # Original query text should not be there
        assert "sk-123" not in content
        # Redacted query should be there
        assert "test secret key [REDACTED]" in content
        assert "selected_for_fetch: 1" in content
        assert "fetch_list_manifest: \"evidence/manifest-abc.md\"" in content

    def test_searxng_config_redaction_in_manifest(self, tmp_path, monkeypatch):
        monkeypatch.setattr("search_tool.search.EVIDENCE_DIR", tmp_path / "evidence")
        (tmp_path / "evidence").mkdir()

        discovery = DiscoveryResult(
            schema_version="0.1", query_original="q", query_normalized="q", query_redacted="q",
            provider_name="searxng", candidates=(), errors=(), limitations=()
        )

        path = write_search_run_manifest(
            discovery=discovery,
            evidence_results=(),
            fetch_list_manifest=None,
            query="q",
            provider_config={"searxng_url_redacted": "https://search.example.com"},
        )

        content = path.read_text()
        assert "Instance: https://search.example.com" in content or "**Instance:** https://search.example.com" in content

    def test_original_query_never_stored(self, tmp_path, monkeypatch):
        monkeypatch.setattr("search_tool.search.EVIDENCE_DIR", tmp_path / "evidence")
        (tmp_path / "evidence").mkdir()

        discovery = DiscoveryResult(
            schema_version="0.1", query_original="secret query", query_normalized="secret query", query_redacted="[REDACTED] query",
            provider_name="test", candidates=(), errors=(), limitations=()
        )

        path = write_search_run_manifest(
            discovery=discovery,
            evidence_results=(),
            fetch_list_manifest=None,
            query="secret query",
        )

        content = path.read_text()
        assert "secret query" not in content
        assert "[REDACTED] query" in content
        assert "original_sha256:" in content

    def test_discovery_summary_counts(self, tmp_path, monkeypatch):
        monkeypatch.setattr("search_tool.search.EVIDENCE_DIR", tmp_path / "evidence")
        (tmp_path / "evidence").mkdir()

        discovery = DiscoveryResult(
            schema_version="0.1", query_original="q", query_normalized="q", query_redacted="q",
            provider_name="test",
            candidates=(
                DiscoveryCandidate(
                    rank=1, url="https://ok.com", normalized_url="https://ok.com/",
                    title=None, snippet=None, source_engine=None, url_policy="passed",
                    blocked_reason=None, selected_for_fetch=True
                ),
                DiscoveryCandidate(
                    rank=2, url="file:///etc/passwd", normalized_url=None,
                    title=None, snippet=None, source_engine=None, url_policy="blocked",
                    blocked_reason="scheme not allowed", selected_for_fetch=False
                ),
                DiscoveryCandidate(
                    rank=3, url="https://ok.com", normalized_url="https://ok.com/",
                    title=None, snippet=None, source_engine=None, url_policy="passed",
                    blocked_reason=None, selected_for_fetch=False, duplicate_of="https://ok.com/"
                ),
            ),
            errors=(DiscoveryError(code="test_err", message="msg"),),
            limitations=()
        )

        path = write_search_run_manifest(
            discovery=discovery, evidence_results=(), fetch_list_manifest=None, query="q"
        )
        content = path.read_text()
        assert "candidates_total: 3" in content
        assert "selected_for_fetch: 1" in content
        assert "blocked: 1" in content
        assert "duplicates: 1" in content
        assert "errors: 1" in content
        assert "### Selected URLs" in content
        assert "### Blocked Candidates" in content
        assert "### Duplicate Candidates" in content
        assert "### Discovery Errors" in content

    def test_fetch_summary_counts(self, tmp_path, monkeypatch):
        monkeypatch.setattr("search_tool.search.EVIDENCE_DIR", tmp_path / "evidence")
        (tmp_path / "evidence").mkdir()

        discovery = DiscoveryResult(
            schema_version="0.1", query_original="q", query_normalized="q", query_redacted="q",
            provider_name="test", candidates=(), errors=(), limitations=()
        )
        evidence = (
            _mock_evidence("https://ok.com", status="success"),
            _mock_evidence("https://fail.com", status="failed"),
            EvidenceWriteResult(
                original_url="file://x", normalized_url="file://x", evidence_path=Path("x"),
                fetch_status="blocked", http_status=None, cache_status="not_written",
                extraction_status="skipped", text_chars=0, truncated=False, errors=(), limitations=()
            )
        )

        path = write_search_run_manifest(
            discovery=discovery, evidence_results=evidence, fetch_list_manifest=None, query="q"
        )
        content = path.read_text()
        assert "requested_urls: 3" in content
        assert "evidence_packs: 1" in content
        assert "succeeded: 1" in content
        assert "blocked: 1" in content
        assert "failed: 1" in content


class TestSearchQueryEmptyManifest:
    def test_no_manifest_writer_returns_none(self, mock_public_dns):
        provider = StaticDiscoveryProvider(
            name="static",
            candidates=(RawDiscoveryCandidate(url="https://example.com"),),
        )
        result = search_query(
            provider, "test",
            fetcher=lambda u, r, f, **kw: _mock_evidence(u),
            manifest_writer=None,
        )
        assert result.manifest_path is None

    def test_manifest_writer_called_for_zero_urls(self, mock_public_dns):
        mock_writer = MagicMock(return_value=Path("evidence/manifest-empty.md"))
        provider = StaticDiscoveryProvider(
            name="static",
            candidates=(RawDiscoveryCandidate(url="file:///etc/passwd"),),
        )
        result = search_query(
            provider, "test",
            fetcher=lambda u, r, f, **kw: _mock_evidence(u),
            manifest_writer=mock_writer,
        )
        mock_writer.assert_called_once()
        assert result.manifest_path == Path("evidence/manifest-empty.md")
