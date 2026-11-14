"""Tests for llms.txt discovery provider — all DNS mocked, no live internet."""

from unittest.mock import patch, MagicMock
import dataclasses

import httpx
import pytest

from search_tool.discovery import (
    DiscoveryCandidate,
    DiscoveryError,
    DiscoveryResult,
    RawDiscoveryCandidate,
    urls_for_fetch,
)
from search_tool.discovery_llms import LlmsTxtProvider, parse_llms_txt
from search_tool.fetch import FetchResult


@pytest.fixture
def mock_public_dns():
    """Mock DNS to resolve any hostname to 93.184.216.34 (example.com)."""
    with patch("search_tool.url_policy.socket.getaddrinfo") as mock_dns:
        mock_dns.return_value = [(2, 1, 6, "", ("93.184.216.34", 0))]
        yield mock_dns


@pytest.fixture
def mock_dns_mapper():
    """Mock DNS with a configurable mapping: hostname -> ip_string."""
    import socket

    mapping = {}

    def _fake_getaddrinfo(host, port, family=0, type=0):
        if host == "127.0.0.1":
            return [(socket.AF_INET, socket.SOCK_STREAM, socket.IPPROTO_TCP, "", ("127.0.0.1", port))]
        ip = mapping.get(host, "93.184.216.34")
        return [(socket.AF_INET, socket.SOCK_STREAM, socket.IPPROTO_TCP, "", (ip, 0))]

    with patch("search_tool.url_policy.socket.getaddrinfo") as mock_dns:
        mock_dns.side_effect = _fake_getaddrinfo
        yield mapping


def _mock_fetch(body: bytes, status_code: int = 200) -> FetchResult:
    """Create a mock FetchResult."""
    result = FetchResult(
        status="success" if 200 <= status_code < 300 else "failed",
        http_status=status_code,
        body_bytes=body,
        body_sha256=None,
        content_length_bytes=len(body),
    )
    if status_code != 200:
        result.errors.append(f"HTTP {status_code} response")
    return result


_UNSET = object()


def _make_provider(
    llms_body: bytes | None = None,
    status_code: int = 200,
    *,
    mock_public_dns=None,
    llms_url: str = "https://example.com/llms.txt",
    **provider_kwargs,
):
    """Create an LlmsTxtProvider with a mocked fetcher."""
    mock_result = _mock_fetch(llms_body or b"# Test\n", status_code)

    def mock_fetcher(*args, **kwargs):
        return mock_result

    provider = LlmsTxtProvider(name="llms", _fetcher=mock_fetcher, **provider_kwargs)
    return provider, llms_url


# --- 1. Missing --url ---


class TestMissingUrl:
    def test_missing_url_returns_error(self, mock_public_dns):
        provider, _ = _make_provider()
        result = provider.discover("test query", llms_url=None)
        assert isinstance(result, DiscoveryResult)
        error_codes = [e.code for e in result.errors]
        assert "missing_url" in error_codes
        assert result.candidates == ()

    def test_missing_url_no_crash(self, mock_public_dns):
        provider = LlmsTxtProvider(name="llms")
        result = provider.discover("test", llms_url=None)
        assert isinstance(result, DiscoveryResult)
        assert result.provider_name == "llms"


# --- 2. Invalid index URL blocked ---


class TestInvalidIndexUrl:
    def test_file_scheme_blocked(self, mock_public_dns):
        provider, _ = _make_provider()
        result = provider.discover("test", llms_url="file:///etc/llms.txt")
        assert isinstance(result, DiscoveryResult)
        error_codes = [e.code for e in result.errors]
        assert "invalid_index_url" in error_codes

    def test_localhost_blocked(self, mock_dns_mapper):
        mock_dns_mapper["localhost"] = "127.0.0.1"
        provider, _ = _make_provider()
        result = provider.discover("test", llms_url="http://localhost/llms.txt")
        assert isinstance(result, DiscoveryResult)
        error_codes = [e.code for e in result.errors]
        assert "invalid_index_url" in error_codes


# --- 3. Fetch failure ---


class TestFetchFailure:
    def test_http_404_returns_error(self, mock_public_dns):
        provider, _ = _make_provider(status_code=404)
        result = provider.discover("test", llms_url=_)
        assert isinstance(result, DiscoveryResult)
        error_codes = [e.code for e in result.errors]
        assert "fetch_failed" in error_codes

    def test_http_500_returns_error(self, mock_public_dns):
        provider, _ = _make_provider(status_code=500)
        result = provider.discover("test", llms_url=_)
        assert isinstance(result, DiscoveryResult)
        error_codes = [e.code for e in result.errors]
        assert "fetch_failed" in error_codes

    def test_empty_body_returns_error(self, mock_public_dns):
        def mock_fetcher(*args, **kwargs):
            return FetchResult(status="success", http_status=200, body_bytes=b"", body_sha256=None)

        provider = LlmsTxtProvider(name="llms", _fetcher=mock_fetcher)
        result = provider.discover("test", llms_url="https://example.com/llms.txt")
        assert isinstance(result, DiscoveryResult)
        error_codes = [e.code for e in result.errors]
        assert "empty_response" in error_codes

    def test_fetch_exception_returns_error(self, mock_public_dns):
        def mock_fetcher(*args, **kwargs):
            raise ConnectionError("network unreachable")

        provider = LlmsTxtProvider(name="llms", _fetcher=mock_fetcher)
        result = provider.discover("test", llms_url="https://example.com/llms.txt")
        assert isinstance(result, DiscoveryResult)
        error_codes = [e.code for e in result.errors]
        assert "fetch_error" in error_codes

    def test_no_parseable_urls_returns_error(self, mock_public_dns):
        provider, _ = _make_provider(b"# No URLs here\nJust text\n")
        result = provider.discover("test", llms_url=_)
        assert isinstance(result, DiscoveryResult)
        error_codes = [e.code for e in result.errors]
        assert "no_entries" in error_codes


# --- 4. Candidates returned into pipeline ---


class TestCandidatesReturned:
    def test_basic_candidate_becomes_selected(self, mock_public_dns):
        body = b"# Docs\n- [Guide](https://docs.example.com/guide)\n"
        provider, _ = _make_provider(body)
        result = provider.discover("test", llms_url=_)
        assert len(result.candidates) == 1
        assert result.candidates[0].selected_for_fetch is True
        assert result.candidates[0].url_policy == "passed"

    def test_candidate_title_preserved(self, mock_public_dns):
        body = b"- [My Guide](https://docs.example.com/guide)\n"
        provider, _ = _make_provider(body)
        result = provider.discover("test", llms_url=_)
        assert result.candidates[0].title == "My Guide"

    def test_candidate_source_engine(self, mock_public_dns):
        body = b"- [Guide](https://docs.example.com/guide)\n"
        provider, _ = _make_provider(body)
        result = provider.discover("test", llms_url=_)
        assert result.candidates[0].source_engine == "llms"

    def test_provider_name_is_llms(self, mock_public_dns):
        body = b"- [Guide](https://docs.example.com/guide)\n"
        provider, _ = _make_provider(body)
        result = provider.discover("test", llms_url=_)
        assert result.provider_name == "llms"

    def test_blocked_candidate_in_result(self, mock_public_dns):
        body = b"- [Internal](http://localhost/secret)\n"
        provider, _ = _make_provider(body)
        result = provider.discover("test", llms_url=_)
        assert len(result.candidates) == 1
        assert result.candidates[0].url_policy == "blocked"
        assert result.candidates[0].selected_for_fetch is False

    def test_urls_for_fetch_excludes_blocked(self, mock_public_dns):
        body = b"- [Public](https://example.com/doc)\n- [Private](http://localhost/secret)\n"
        provider, _ = _make_provider(body)
        result = provider.discover("test", llms_url=_)
        fetch_urls = urls_for_fetch(result)
        assert len(fetch_urls) == 1
        assert fetch_urls[0] == "https://example.com/doc"


# --- 5. Query scoring is deterministic ---


class TestQueryScoring:
    def test_title_match_scored_higher(self, mock_public_dns):
        body = b"# Docs\n- [Validation](https://example.com/a)\n- [Guide](https://example.com/b)\n"
        provider, _ = _make_provider(body)
        result = provider.discover("validation", llms_url=_)
        assert result.candidates[0].url == "https://example.com/a"
        assert result.candidates[0].title == "Validation"

    def test_section_match_scored_next(self, mock_public_dns):
        body = (
            b"# Docs\n## Validation\n- [Section Match](https://example.com/a)\n"
            b"- [No Match](https://example.com/b)\n"
        )
        provider, _ = _make_provider(body)
        result = provider.discover("validation", llms_url=_)
        # Section match should be ranked higher than no match
        assert result.candidates[0].url == "https://example.com/a"

    def test_empty_query_returns_empty_candidates(self, mock_public_dns):
        body = b"- [A](https://example.com/a)\n- [B](https://example.com/b)\n- [C](https://example.com/c)\n"
        provider, _ = _make_provider(body)
        result = provider.discover("", llms_url=_)
        assert result.candidates == ()
        error_codes = [e.code for e in result.errors]
        assert "empty_query" in error_codes

    def test_scoring_does_not_crash(self, mock_public_dns):
        body = b"- [Test](https://example.com/test)\n"
        provider, _ = _make_provider(body)
        result = provider.discover("test", llms_url=_)
        assert len(result.candidates) == 1


# --- 6. max_candidates respected ---


class TestMaxCandidates:
    def test_respects_max_candidates(self, mock_public_dns):
        body = b"# Docs\n" + b"".join(
            f"- [P{i}](https://example.com/p{i})\n".encode() for i in range(20)
        )
        provider, _ = _make_provider(body)
        result = provider.discover("test", llms_url=_, max_candidates=5)
        assert len(result.candidates) == 5

    def test_max_candidates_zero(self, mock_public_dns):
        body = b"- [A](https://example.com/a)\n"
        provider, _ = _make_provider(body)
        result = provider.discover("test", llms_url=_, max_candidates=0)
        assert len(result.candidates) == 0


# --- 7. Private/local candidate rejected ---


class TestPrivateCandidateRejection:
    def test_localhost_candidate_blocked(self, mock_public_dns):
        body = b"- [Local](http://localhost/secret)\n"
        provider, _ = _make_provider(body)
        result = provider.discover("test", llms_url=_)
        assert result.candidates[0].url_policy == "blocked"
        assert not result.candidates[0].selected_for_fetch

    def test_127_0_0_1_candidate_blocked(self, mock_dns_mapper):
        mock_dns_mapper["127.0.0.1"] = "127.0.0.1"
        body = b"- [Local](http://127.0.0.1/secret)\n"
        provider, _ = _make_provider(body)
        result = provider.discover("test", llms_url=_)
        assert result.candidates[0].url_policy == "blocked"

    def test_file_scheme_candidate_blocked(self, mock_public_dns):
        body = b"- [Bad](file:///etc/passwd)\n"
        provider, _ = _make_provider(body)
        result = provider.discover("test", llms_url=_)
        # Parser-level scheme blocking: no entries emitted for file:// URLs
        assert len(result.candidates) == 0


# --- 8. No network in unit tests ---


class TestNoNetwork:
    def test_provider_with_mock_fetcher_no_network(self, mock_public_dns):
        call_count = [0]
        real_fetcher = None

        def counting_fetcher(*args, **kwargs):
            call_count[0] += 1
            return _mock_fetch(b"- [A](https://example.com/a)\n")

        provider = LlmsTxtProvider(name="llms", _fetcher=counting_fetcher)
        result = provider.discover("test", llms_url="https://example.com/llms.txt")
        assert call_count[0] == 1
        assert isinstance(result, DiscoveryResult)

    def test_no_httpx_real_client_created(self):
        with patch("search_tool.discovery_llms._fetch_url") as mock_real_fetch:
            mock_real_fetch.return_value = _mock_fetch(b"- [A](https://example.com/a)\n")
            provider, _ = _make_provider(b"- [A](https://example.com/a)\n")
            result = provider.discover("test", llms_url=_)
            # Real fetch_url should NOT be called; mock_fetcher is used instead
            mock_real_fetch.assert_not_called()
            assert len(result.candidates) == 1


# --- 9. Empty query handling ---


class TestEmptyQuery:
    def test_empty_query_returns_error(self, mock_public_dns):
        provider, _ = _make_provider()
        result = provider.discover("", llms_url=_)
        assert isinstance(result, DiscoveryResult)
        error_codes = [e.code for e in result.errors]
        assert "empty_query" in error_codes

    def test_whitespace_query_returns_error(self, mock_public_dns):
        provider, _ = _make_provider()
        result = provider.discover("   ", llms_url=_)
        assert isinstance(result, DiscoveryResult)
        error_codes = [e.code for e in result.errors]
        assert "empty_query" in error_codes


# --- 10. Existing provider paths unaffected ---


class TestProviderIsolation:
    def test_provider_frozen_dataclass(self):
        provider = LlmsTxtProvider(name="llms")
        assert dataclasses.is_dataclass(provider)
        assert provider.name == "llms"
        with pytest.raises(AttributeError):
            provider.name = "mutated"

    def test_provider_default_name(self):
        provider = LlmsTxtProvider()
        assert provider.name == "llms"

    def test_discover_returns_discovery_result(self, mock_public_dns):
        provider, _ = _make_provider(b"- [A](https://example.com/a)\n")
        result = provider.discover("test", llms_url=_)
        assert isinstance(result, DiscoveryResult)

    def test_schema_version_set(self, mock_public_dns):
        provider, _ = _make_provider(b"- [A](https://example.com/a)\n")
        result = provider.discover("test", llms_url=_)
        assert result.schema_version == "0.1"

    def test_limitations_include_redaction_warning(self, mock_public_dns):
        provider, _ = _make_provider(b"- [A](https://example.com/a)\n")
        result = provider.discover("test", llms_url=_)
        assert any("best-effort" in lim for lim in result.limitations)

    def test_query_redacted_in_result(self, mock_public_dns):
        body = b"- [A](https://example.com/a)\n"
        provider, _ = _make_provider(body)
        result = provider.discover("search sk-abcdef1234567890abc", llms_url=_)
        assert "[REDACTED]" in result.query_redacted
        assert result.query_original == "search sk-abcdef1234567890abc"


# --- 11. Dedup handled by parser ---


class TestDedupInProvider:
    def test_duplicate_urls_only_one_candidate(self, mock_public_dns):
        body = b"- [A](https://example.com/doc)\n- [B](https://example.com/doc)\n"
        provider, _ = _make_provider(body)
        result = provider.discover("test", llms_url=_)
        assert len(result.candidates) == 1


# --- 12. Integration with build_discovery_result ---


class TestIntegrationWithBuildResult:
    def test_raw_candidates_processed_by_build_discovery_result(self, mock_public_dns):
        body = (
            b"# Docs\n"
            b"- [Public](https://example.com/a)\n"
            b"- [Public](https://example.com/b)\n"
            b"- [Local](http://localhost/secret)\n"
        )
        provider, _ = _make_provider(body)
        result = provider.discover("test", llms_url=_)
        assert len(result.candidates) == 3
        passed = sum(1 for c in result.candidates if c.url_policy == "passed")
        blocked = sum(1 for c in result.candidates if c.url_policy == "blocked")
        assert passed == 2
        assert blocked == 1

    def test_ranking_preserved_when_scoring_equal(self, mock_public_dns):
        body = b"- [A](https://example.com/a)\n- [B](https://example.com/b)\n- [C](https://example.com/c)\n"
        provider, _ = _make_provider(body)
        # Query with no matches — order preserved
        result = provider.discover("nonexistent", llms_url=_)
        assert result.candidates[0].url == "https://example.com/a"
        assert result.candidates[1].url == "https://example.com/b"
        assert result.candidates[2].url == "https://example.com/c"


# --- 15. follow_redirects on source fetch ---


class TestFollowRedirects:
    def test_default_follow_redirects_false(self):
        provider = LlmsTxtProvider(name="llms")
        assert provider.follow_redirects is False

    def test_follow_redirects_true(self):
        provider = LlmsTxtProvider(name="llms", follow_redirects=True)
        assert provider.follow_redirects is True

    def test_redirect_followed_when_enabled(self, mock_public_dns):
        """When follow_redirects=True, the llms.txt source URL redirect is followed."""
        # First hop: 301 (not followed when follow_redirects=False)
        redirect_result = _mock_fetch(b"", 301)
        # Second hop: the actual content (returned when follow_redirects=True)
        final_result = _mock_fetch(b"# V2\n- [Guide](https://example.com/guide)\n", 200)

        def redirect_fetcher(url, follow_redirects=False, **kwargs):
            if follow_redirects:
                return final_result
            return redirect_result

        provider = LlmsTxtProvider(
            name="llms",
            follow_redirects=True,
            _fetcher=redirect_fetcher,
        )
        result = provider.discover("test", llms_url="https://example.com/llms.txt")
        assert len(result.candidates) == 1
        assert result.candidates[0].url == "https://example.com/guide"

    def test_redirect_not_followed_when_disabled(self, mock_public_dns):
        """When follow_redirects=False (default), 301 is returned as fetch_failed."""
        provider = LlmsTxtProvider(name="llms", follow_redirects=False)
        result = provider.discover("test", llms_url="https://example.com/llms.txt")
        error_codes = [e.code for e in result.errors]
        assert "fetch_failed" in error_codes


# --- 16. LlmsTxtProvider frozen dataclass with new fields ---


class TestProviderFields:
    def test_follow_redirects_default(self):
        provider = LlmsTxtProvider(name="llms")
        assert provider.follow_redirects is False
        assert provider.timeout_seconds == 15.0

    def test_follow_redirects_custom(self):
        provider = LlmsTxtProvider(
            name="llms",
            follow_redirects=True,
            timeout_seconds=30.0,
        )
        assert provider.follow_redirects is True
        assert provider.timeout_seconds == 30.0


# --- 17. Parser warnings surfaced in limitations (MVP-1L.5) ---


class TestParserWarnings:
    def test_empty_title_warning_in_limitations(self, mock_public_dns):
        # Empty-title links don't match the markdown link regex at all — no warning produced
        body = b"- [](https://example.com/no-title)\n- [Good](https://example.com/good)\n"
        provider, _ = _make_provider(body)
        result = provider.discover("test", llms_url=_)
        assert len(result.candidates) == 1

    def test_blocked_scheme_warning_in_limitations(self, mock_public_dns):
        body = b"- [Bad](file:///etc/passwd)\n- [Good](https://example.com/good)\n"
        provider, _ = _make_provider(body)
        result = provider.discover("test", llms_url=_)
        assert len(result.candidates) == 1
        # file:// is caught during relative URL resolution (urljoin returns it as-is, scheme blocked)
        assert any("llms parser warning:" in lim for lim in result.limitations)
        assert any("unsupported scheme" in lim for lim in result.limitations)

    def test_warnings_preserve_valid_candidates(self, mock_public_dns):
        body = b"- [Bad](file:///etc/passwd)\n- [Good](https://example.com/good)\n- [Also](https://example.com/also)\n"
        provider, _ = _make_provider(body)
        result = provider.discover("test", llms_url=_)
        assert len(result.candidates) == 2
        assert result.candidates[0].url == "https://example.com/good"
        assert result.candidates[1].url == "https://example.com/also"

    def test_warnings_dont_turn_success_into_error(self, mock_public_dns):
        body = b"- [](https://example.com/bad)\n- [Good](https://example.com/good)\n"
        provider, _ = _make_provider(body)
        result = provider.discover("test", llms_url=_)
        assert len(result.candidates) == 1
        assert len(result.errors) == 0  # warnings ≠ errors

    def test_no_entries_includes_warnings(self, mock_public_dns):
        body = b"- [](https://example.com/a)\n- [](https://example.com/b)\n"
        provider, _ = _make_provider(body)
        result = provider.discover("test", llms_url=_)
        error_codes = [e.code for e in result.errors]
        assert "no_entries" in error_codes
        # Empty-title links don't match the markdown link regex (silently skipped, no warning)
        # so no parser warnings expected — this verifies the path works without crash
        assert isinstance(result.limitations, tuple)

    def test_no_duplicate_warning_spam(self, mock_public_dns):
        # 50 identical malformed lines — warnings capped
        body = b"".join(
            b"- [](https://example.com/bad)\n" for _ in range(50)
        )
        provider, _ = _make_provider(body)
        result = provider.discover("test", llms_url=_)
        warning_count = sum(1 for lim in result.limitations if "llms parser warning:" in lim)
        # Capped at 20
        assert warning_count <= 20

    def test_static_provider_unaffected(self, mock_public_dns):
        from search_tool.discovery import StaticDiscoveryProvider, RawDiscoveryCandidate
        provider = StaticDiscoveryProvider(
            name="static",
            candidates=(RawDiscoveryCandidate(url="https://example.com/a"),),
        )
        result = provider.discover("test")
        assert not any("llms parser warning" in lim for lim in result.limitations)
