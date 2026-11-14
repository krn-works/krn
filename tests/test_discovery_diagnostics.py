"""Tests for discovery diagnostics artifact — MVP-1P.1."""

import json
from pathlib import Path
from unittest.mock import patch

import pytest

from search_tool.discovery import (
    DiscoveryCandidate,
    DiscoveryError,
    DiscoveryResult,
    RawDiscoveryCandidate,
    StaticDiscoveryProvider,
)
from search_tool.search import (
    EvidenceWriteResult,
    SearchRunResult,
    search_query,
    write_discovery_diagnostics,
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


def _make_discovery(**overrides) -> DiscoveryResult:
    defaults = dict(
        schema_version="0.1",
        query_original="test query",
        query_normalized="test query",
        query_redacted="test query",
        provider_name="static",
        candidates=(
            DiscoveryCandidate(
                rank=1, url="https://example.com/a",
                normalized_url="https://example.com/a",
                title="Example A", snippet="snip A",
                source_engine="static", url_policy="passed",
                blocked_reason=None, selected_for_fetch=True,
            ),
            DiscoveryCandidate(
                rank=2, url="http://evil.local/b",
                normalized_url=None,
                title="Blocked", snippet=None,
                source_engine="static", url_policy="blocked",
                blocked_reason="private network", selected_for_fetch=False,
            ),
            DiscoveryCandidate(
                rank=3, url="https://example.com/a?ref=spam",
                normalized_url="https://example.com/a",
                title="Dup A", snippet=None,
                source_engine="static", url_policy="passed",
                blocked_reason=None, selected_for_fetch=False,
                duplicate_of="https://example.com/a",
            ),
        ),
        errors=(
            DiscoveryError(code="test_error", message="something went wrong"),
        ),
        limitations=("Query redaction is best-effort.",),
    )
    defaults.update(overrides)
    return DiscoveryResult(**defaults)


class TestWriteDiscoveryDiagnostics:
    def test_writes_json_file(self, tmp_path):
        discovery = _make_discovery()
        path = write_discovery_diagnostics(
            discovery=discovery, query="test query", target_dir=tmp_path,
        )
        assert path == tmp_path / "discovery-diagnostics.json"
        assert path.exists()
        data = json.loads(path.read_text(encoding="utf-8"))
        assert data["schema_version"] == "0.1"
        assert data["artifact_type"] == "discovery_diagnostics"

    def test_query_hash_and_redacted(self, tmp_path):
        discovery = _make_discovery()
        path = write_discovery_diagnostics(
            discovery=discovery, query="test query", target_dir=tmp_path,
        )
        data = json.loads(path.read_text(encoding="utf-8"))
        import hashlib
        expected_hash = hashlib.sha256("test query".encode()).hexdigest()
        assert data["query"]["hash_sha256"] == expected_hash
        assert data["query"]["redacted"] == "test query"

    def test_provider_name(self, tmp_path):
        discovery = _make_discovery()
        path = write_discovery_diagnostics(
            discovery=discovery, query="test query", target_dir=tmp_path,
        )
        data = json.loads(path.read_text(encoding="utf-8"))
        assert data["provider_name"] == "static"

    def test_candidates_total(self, tmp_path):
        discovery = _make_discovery()
        path = write_discovery_diagnostics(
            discovery=discovery, query="test query", target_dir=tmp_path,
        )
        data = json.loads(path.read_text(encoding="utf-8"))
        assert data["candidates_total"] == 3

    def test_selected_for_fetch_count(self, tmp_path):
        discovery = _make_discovery()
        path = write_discovery_diagnostics(
            discovery=discovery, query="test query", target_dir=tmp_path,
        )
        data = json.loads(path.read_text(encoding="utf-8"))
        assert data["selected_for_fetch"] == 1

    def test_blocked_candidates(self, tmp_path):
        discovery = _make_discovery()
        path = write_discovery_diagnostics(
            discovery=discovery, query="test query", target_dir=tmp_path,
        )
        data = json.loads(path.read_text(encoding="utf-8"))
        blocked = data["blocked_candidates"]
        assert len(blocked) == 1
        assert blocked[0]["rank"] == 2
        assert blocked[0]["url"] == "http://evil.local/b"
        assert blocked[0]["reason"] == "private network"

    def test_duplicate_candidates(self, tmp_path):
        discovery = _make_discovery()
        path = write_discovery_diagnostics(
            discovery=discovery, query="test query", target_dir=tmp_path,
        )
        data = json.loads(path.read_text(encoding="utf-8"))
        dups = data["duplicate_candidates"]
        assert len(dups) == 1
        assert dups[0]["rank"] == 3
        assert dups[0]["url"] == "https://example.com/a?ref=spam"
        assert dups[0]["duplicate_of"] == "https://example.com/a"

    def test_selected_candidates_with_source_quality(self, tmp_path):
        discovery = _make_discovery()
        path = write_discovery_diagnostics(
            discovery=discovery, query="test query", target_dir=tmp_path,
        )
        data = json.loads(path.read_text(encoding="utf-8"))
        selected = data["selected_candidates"]
        assert len(selected) == 1
        s = selected[0]
        assert s["rank"] == 1
        assert s["url"] == "https://example.com/a"
        assert s["title"] == "Example A"
        assert s["snippet"] == "snip A"
        assert s["source_engine"] == "static"
        assert "source_quality" in s
        sq = s["source_quality"]
        assert "source_type" in sq
        assert "authority_score" in sq
        assert "domain" in sq

    def test_discovery_errors(self, tmp_path):
        discovery = _make_discovery()
        path = write_discovery_diagnostics(
            discovery=discovery, query="test query", target_dir=tmp_path,
        )
        data = json.loads(path.read_text(encoding="utf-8"))
        errors = data["discovery_errors"]
        assert len(errors) == 1
        assert errors[0]["code"] == "test_error"
        assert errors[0]["message"] == "something went wrong"

    def test_discovery_limitations(self, tmp_path):
        discovery = _make_discovery()
        path = write_discovery_diagnostics(
            discovery=discovery, query="test query", target_dir=tmp_path,
        )
        data = json.loads(path.read_text(encoding="utf-8"))
        assert data["discovery_limitations"] == ["Query redaction is best-effort."]

    def test_no_secrets_in_output(self, tmp_path):
        discovery = _make_discovery(
            query_original="secret sk-1234567890abcdef1234567890 query",
            query_redacted="secret [REDACTED] query",
        )
        path = write_discovery_diagnostics(
            discovery=discovery,
            query="secret sk-1234567890abcdef1234567890 query",
            target_dir=tmp_path,
        )
        content = path.read_text(encoding="utf-8")
        assert "sk-1234567890" not in content
        assert "[REDACTED]" in content

    def test_credentials_in_blocked_candidate_are_redacted(self, tmp_path):
        discovery = DiscoveryResult(
            schema_version="0.1",
            query_original="test query",
            query_normalized="test query",
            query_redacted="test query",
            provider_name="static",
            candidates=(
                DiscoveryCandidate(
                    rank=1,
                    url="https://user:pass@example.com/private",
                    normalized_url=None,
                    title="Secret",
                    snippet=None,
                    source_engine="static",
                    url_policy="blocked",
                    blocked_reason="credentials in URL",
                    selected_for_fetch=False,
                ),
            ),
            errors=(),
            limitations=(),
        )
        path = write_discovery_diagnostics(
            discovery=discovery, query="test query", target_dir=tmp_path,
        )
        content = path.read_text(encoding="utf-8")
        assert "user:pass" not in content
        assert "user" not in content.split("example.com")[0].split("//")[-1]
        assert "https://example.com/private" in content

    def test_credentials_in_selected_candidate_are_redacted(self, tmp_path):
        discovery = DiscoveryResult(
            schema_version="0.1",
            query_original="test query",
            query_normalized="test query",
            query_redacted="test query",
            provider_name="static",
            candidates=(
                DiscoveryCandidate(
                    rank=1,
                    url="https://admin:s3cret@docs.example.com/guide",
                    normalized_url="https://docs.example.com/guide",
                    title="Guide",
                    snippet="snip",
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
            discovery=discovery, query="test query", target_dir=tmp_path,
        )
        content = path.read_text(encoding="utf-8")
        assert "admin" not in content
        assert "s3cret" not in content
        assert "docs.example.com/guide" in content

    def test_credentials_in_duplicate_candidate_are_redacted(self, tmp_path):
        discovery = DiscoveryResult(
            schema_version="0.1",
            query_original="test query",
            query_normalized="test query",
            query_redacted="test query",
            provider_name="static",
            candidates=(
                DiscoveryCandidate(
                    rank=1,
                    url="https://example.com/a",
                    normalized_url="https://example.com/a",
                    title="A",
                    snippet=None,
                    source_engine="static",
                    url_policy="passed",
                    blocked_reason=None,
                    selected_for_fetch=True,
                ),
                DiscoveryCandidate(
                    rank=2,
                    url="https://bot:token123@example.com/a?ref=x",
                    normalized_url="https://bot:token123@example.com/a",
                    title="Dup A",
                    snippet=None,
                    source_engine="static",
                    url_policy="passed",
                    blocked_reason=None,
                    selected_for_fetch=False,
                    duplicate_of="https://example.com/a",
                ),
            ),
            errors=(),
            limitations=(),
        )
        path = write_discovery_diagnostics(
            discovery=discovery, query="test query", target_dir=tmp_path,
        )
        content = path.read_text(encoding="utf-8")
        assert "bot:token123" not in content
        assert "token123" not in content
        data = json.loads(content)
        dup = data["duplicate_candidates"][0]
        assert dup["duplicate_of"] == "https://example.com/a"
        assert "example.com/a" in dup["url"]

    def test_empty_discovery(self, tmp_path):
        discovery = DiscoveryResult(
            schema_version="0.1",
            query_original="",
            query_normalized="",
            query_redacted="",
            provider_name="static",
            candidates=(),
            errors=(),
            limitations=(),
        )
        path = write_discovery_diagnostics(
            discovery=discovery, query="", target_dir=tmp_path,
        )
        data = json.loads(path.read_text(encoding="utf-8"))
        assert data["candidates_total"] == 0
        assert data["selected_for_fetch"] == 0
        assert data["blocked_candidates"] == []
        assert data["duplicate_candidates"] == []
        assert data["selected_candidates"] == []
        assert data["discovery_errors"] == []
        assert data["discovery_limitations"] == []

    def test_creates_target_dir(self, tmp_path):
        target = tmp_path / "nested" / "dir"
        discovery = _make_discovery()
        path = write_discovery_diagnostics(
            discovery=discovery, query="test query", target_dir=target,
        )
        assert path.exists()


class TestDiagnosticsInSearchQuery:
    def test_diagnostics_written_with_evidence_dir(self, tmp_path, mock_public_dns):
        evidence_dir = tmp_path / "evidence"
        provider = StaticDiscoveryProvider(
            name="test",
            candidates=(RawDiscoveryCandidate(url="https://example.com"),),
        )
        result = search_query(
            provider, "test query",
            fetcher=lambda u, r, f, **kw: _mock_evidence(u),
            evidence_dir=evidence_dir,
        )
        assert result.discovery_diagnostics_path is not None
        assert result.discovery_diagnostics_path.exists()
        assert result.discovery_diagnostics_path.name == "discovery-diagnostics.json"

    def test_diagnostics_not_written_without_evidence_dir(self, mock_public_dns):
        provider = StaticDiscoveryProvider(
            name="test",
            candidates=(RawDiscoveryCandidate(url="https://example.com"),),
        )
        result = search_query(
            provider, "test query",
            fetcher=lambda u, r, f, **kw: _mock_evidence(u),
        )
        assert result.discovery_diagnostics_path is None

    def test_diagnostics_written_even_with_no_fetch_urls(self, tmp_path, mock_public_dns):
        evidence_dir = tmp_path / "evidence"
        provider = StaticDiscoveryProvider(name="test", candidates=())
        result = search_query(
            provider, "test query",
            fetcher=lambda u, r, f, **kw: _mock_evidence(u),
            evidence_dir=evidence_dir,
        )
        assert result.discovery_diagnostics_path is not None
        assert result.discovery_diagnostics_path.exists()
        data = json.loads(result.discovery_diagnostics_path.read_text(encoding="utf-8"))
        assert data["candidates_total"] == 0

    def test_diagnostics_writer_failure_does_not_crash(self, mock_public_dns):
        provider = StaticDiscoveryProvider(
            name="test",
            candidates=(RawDiscoveryCandidate(url="https://example.com"),),
        )
        result = search_query(
            provider, "test query",
            fetcher=lambda u, r, f, **kw: _mock_evidence(u),
            evidence_dir=Path("/nonexistent/path/that/cannot/be/created/xyz"),
        )
        # Writer should fail gracefully
        assert result.discovery_diagnostics_path is None
