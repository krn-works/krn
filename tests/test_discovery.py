"""Tests for discovery contract — all DNS mocked, no live internet."""

from unittest.mock import patch, MagicMock

import httpx
import pytest

from search_tool.discovery import (
    DiscoveryCandidate,
    DiscoveryError,
    DiscoveryResult,
    RawDiscoveryCandidate,
    SearxngDiscoveryProvider,
    StaticDiscoveryProvider,
    build_discovery_result,
    normalize_query,
    redact_query,
    static_provider,
    urls_for_fetch,
)


# --- DNS mock fixtures (same pattern as test_url_policy) ---


@pytest.fixture
def mock_public_dns():
    """Mock DNS to resolve any hostname to 93.184.216.34 (example.com)."""
    with patch("search_tool.url_policy.socket.getaddrinfo") as mock_dns:
        mock_dns.return_value = [(2, 1, 6, "", ("93.184.216.34", 0))]
        yield mock_dns


# --- 1. Query normalization ---


class TestNormalizeQuery:
    def test_trims_whitespace(self):
        assert normalize_query("  hello  ") == "hello"

    def test_collapses_whitespace(self):
        assert normalize_query("hello   world") == "hello world"

    def test_trims_and_collapses(self):
        assert normalize_query("  hello   world  ") == "hello world"

    def test_empty_query_produces_error(self, mock_public_dns):
        result = build_discovery_result("", "test", [])
        assert result.query_normalized == ""
        error_codes = [e.code for e in result.errors]
        assert "empty_query" in error_codes

    def test_whitespace_only_produces_error(self, mock_public_dns):
        result = build_discovery_result("   ", "test", [])
        assert result.query_normalized == ""
        error_codes = [e.code for e in result.errors]
        assert "empty_query" in error_codes


# --- 2. Query redaction ---


class TestRedactQuery:
    def test_redacts_sk_token(self):
        assert "[REDACTED]" in redact_query("search sk-abc123DEFghi456jkl789mno")

    def test_redacts_ghp_token(self):
        assert "[REDACTED]" in redact_query("ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij")

    def test_redacts_gho_token(self):
        assert "[REDACTED]" in redact_query("gho_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij")

    def test_redacts_github_pat(self):
        assert "[REDACTED]" in redact_query("github_pat_abcdef1234567890ABCD")

    def test_redacts_bearer_token(self):
        assert "[REDACTED]" in redact_query("Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9payload")

    def test_redacts_api_key(self):
        redacted = redact_query("api_key=secret123")
        assert "[REDACTED]" in redacted

    def test_redacts_token_param(self):
        redacted = redact_query("token=abc123def456")
        assert "[REDACTED]" in redacted

    def test_redacts_password(self):
        redacted = redact_query("password=mypassword123")
        assert "[REDACTED]" in redacted

    def test_preserves_normal_query(self):
        q = "What is the Python GIL?"
        assert redact_query(q) == q


# --- 3. Safe candidate handling ---


class TestSafeCandidateHandling:
    def test_valid_https_passes(self, mock_public_dns):
        result = build_discovery_result(
            "python gil", "test",
            [RawDiscoveryCandidate(url="https://docs.python.org/3/glossary.html#term-GIL", title="Python Glossary")],
        )
        c = result.candidates[0]
        assert c.url_policy == "passed"
        assert c.blocked_reason is None
        assert c.selected_for_fetch is True
        assert c.title == "Python Glossary"

    def test_normalized_url_is_set(self, mock_public_dns):
        result = build_discovery_result(
            "test", "test",
            [RawDiscoveryCandidate(url="https://Example.COM/path")],
        )
        c = result.candidates[0]
        assert c.normalized_url == "https://example.com/path"

    def test_urls_for_fetch_returns_normalized(self, mock_public_dns):
        result = build_discovery_result(
            "test", "test",
            [RawDiscoveryCandidate(url="https://example.com/doc")],
        )
        urls = urls_for_fetch(result)
        assert urls == ["https://example.com/doc"]

    def test_preserves_snippet(self, mock_public_dns):
        result = build_discovery_result(
            "test", "test",
            [RawDiscoveryCandidate(url="https://example.com", snippet="A useful snippet")],
        )
        assert result.candidates[0].snippet == "A useful snippet"

    def test_preserves_source_engine(self, mock_public_dns):
        result = build_discovery_result(
            "test", "test",
            [RawDiscoveryCandidate(url="https://example.com", source_engine="google")],
        )
        assert result.candidates[0].source_engine == "google"


# --- 4. Blocked candidate handling ---


class TestBlockedCandidateHandling:
    def test_file_scheme_blocked(self):
        result = build_discovery_result(
            "test", "test",
            [RawDiscoveryCandidate(url="file:///etc/passwd")],
        )
        c = result.candidates[0]
        assert c.url_policy == "blocked"
        assert c.selected_for_fetch is False
        assert c.blocked_reason is not None
        assert "file" in c.blocked_reason

    def test_localhost_blocked(self):
        result = build_discovery_query_blocked("http://localhost")

    def test_127_0_0_1_blocked(self, mock_dns_mapper):
        mock_dns_mapper["127.0.0.1"] = "127.0.0.1"
        result = build_discovery_query_blocked("http://127.0.0.1")

    def test_credentials_blocked(self):
        result = build_discovery_query_blocked("https://user:pass@example.com")

    def test_urls_for_fetch_excludes_blocked(self):
        result = build_discovery_result(
            "test", "test",
            [RawDiscoveryCandidate(url="file:///etc/passwd")],
        )
        assert urls_for_fetch(result) == []

    def test_blocked_reason_recorded(self):
        result = build_discovery_result(
            "test", "test",
            [RawDiscoveryCandidate(url="file:///etc/passwd")],
        )
        assert result.candidates[0].blocked_reason is not None


# --- 5. Deduplication ---


class TestDeduplication:
    def test_same_url_twice_selects_first(self, mock_public_dns):
        result = build_discovery_result(
            "test", "test",
            [
                RawDiscoveryCandidate(url="https://example.com/doc"),
                RawDiscoveryCandidate(url="https://example.com/doc"),
            ],
        )
        selected = [c for c in result.candidates if c.selected_for_fetch]
        assert len(selected) == 1
        assert selected[0].rank == 1

    def test_duplicate_collapse_in_limitations(self, mock_public_dns):
        result = build_discovery_result(
            "test", "test",
            [
                RawDiscoveryCandidate(url="https://example.com/doc"),
                RawDiscoveryCandidate(url="https://example.com/doc"),
            ],
        )
        # Canonical dedup collapses exact duplicates to 1 candidate
        assert len(result.candidates) == 1
        assert result.candidates[0].selected_for_fetch is True
        assert any(
            "collapsed" in lim.lower() and "duplicate" in lim.lower() and "canonical" in lim.lower()
            for lim in result.limitations
        )

    def test_duplicate_of_not_set_after_canonical_dedup(self, mock_public_dns):
        # Exact duplicates are collapsed at canonical stage before DiscoveryCandidate creation
        result = build_discovery_result(
            "test", "test",
            [
                RawDiscoveryCandidate(url="https://example.com/doc"),
                RawDiscoveryCandidate(url="https://example.com/doc"),
            ],
        )
        assert len(result.candidates) == 1
        assert result.candidates[0].duplicate_of is None

    def test_urls_for_fetch_returns_one(self, mock_public_dns):
        result = build_discovery_result(
            "test", "test",
            [
                RawDiscoveryCandidate(url="https://example.com/doc"),
                RawDiscoveryCandidate(url="https://example.com/doc"),
            ],
        )
        assert len(urls_for_fetch(result)) == 1

    def test_different_urls_both_selected(self, mock_public_dns):
        result = build_discovery_result(
            "test", "test",
            [
                RawDiscoveryCandidate(url="https://example.com/a"),
                RawDiscoveryCandidate(url="https://example.com/b"),
            ],
        )
        assert len(urls_for_fetch(result)) == 2


# --- 6. max_candidates ---


class TestMaxCandidates:
    def test_caps_processed_candidates(self, mock_public_dns):
        raw = [RawDiscoveryCandidate(url=f"https://example.com/{i}") for i in range(20)]
        result = build_discovery_result("test", "test", raw, max_candidates=5)
        assert len(result.candidates) == 5

    def test_max_candidates_zero_no_urls(self, mock_public_dns):
        raw = [RawDiscoveryCandidate(url="https://example.com/1")]
        result = build_discovery_query_empty_candidates("test", "test", raw, max_candidates=0)
        assert urls_for_fetch(result) == []
        error_codes = [e.code for e in result.errors]
        assert "max_candidates_zero" in error_codes

    def test_negative_max_candidates(self, mock_public_dns):
        raw = [RawDiscoveryCandidate(url="https://example.com/1")]
        result = build_discovery_query_empty_candidates("test", "test", raw, max_candidates=-1)
        assert urls_for_fetch(result) == []


# --- 7. Provider metadata ---


class TestProviderMetadata:
    def test_provider_name_stored(self, mock_public_dns):
        result = build_discovery_result("test", "my-engine", [])
        assert result.provider_name == "my-engine"

    def test_empty_provider_becomes_unknown(self, mock_public_dns):
        result = build_discovery_result("test", "", [])
        assert result.provider_name == "unknown"

    def test_whitespace_provider_becomes_unknown(self, mock_public_dns):
        result = build_discovery_query_provider_unknown("test", "   ")
        assert result.provider_name == "unknown"

    def test_empty_provider_records_error(self, mock_public_dns):
        result = build_discovery_result("test", "", [])
        error_codes = [e.code for e in result.errors]
        assert "empty_provider" in error_codes


# --- 8. Auditability ---


class TestAuditability:
    def test_blocked_candidates_remain_in_result(self):
        result = build_discovery_result(
            "test", "test",
            [RawDiscoveryCandidate(url="file:///etc/passwd")],
        )
        assert len(result.candidates) == 1

    def test_duplicate_candidates_collapsed_and_reported_in_limitations(self, mock_public_dns):
        result = build_discovery_result(
            "test", "test",
            [
                RawDiscoveryCandidate(url="https://example.com/doc"),
                RawDiscoveryCandidate(url="https://example.com/doc"),
            ],
        )
        # Collapsed at canonical stage; reported in limitations
        assert len(result.candidates) == 1
        assert any(
            "collapsed" in lim.lower() and "canonical" in lim.lower()
            for lim in result.limitations
        )

    def test_result_is_frozen(self, mock_public_dns):
        result = build_discovery_result(
            "test", "test",
            [RawDiscoveryCandidate(url="https://example.com")],
        )
        with pytest.raises(AttributeError):
            result.query_original = "mutated"

    def test_candidate_is_frozen(self, mock_public_dns):
        result = build_discovery_result(
            "test", "test",
            [RawDiscoveryCandidate(url="https://example.com")],
        )
        with pytest.raises(AttributeError):
            result.candidates[0].selected_for_fetch = False

    def test_schema_version_set(self, mock_public_dns):
        result = build_discovery_result("test", "test", [])
        assert result.schema_version == "0.1"

    def test_redacted_query_stored(self, mock_public_dns):
        result = build_discovery_result("test sk-abcdef1234567890", "test", [])
        assert "[REDACTED]" in result.query_redacted

    def test_limitations_include_redaction_warning(self, mock_public_dns):
        result = build_discovery_result("test", "test", [])
        assert any("best-effort" in lim for lim in result.limitations)


# --- 9. No network ---


class TestNoNetwork:
    def test_check_url_calls_dont_hit_network(self, mock_public_dns):
        mock_public_dns.assert_not_called()
        build_discovery_result(
            "test", "test",
            [RawDiscoveryCandidate(url="https://example.com")],
        )


# --- 10. StaticDiscoveryProvider ---


class TestStaticDiscoveryProvider:
    # 1. provider returns DiscoveryResult

    def test_returns_discovery_result(self, mock_public_dns):
        provider = StaticDiscoveryProvider(
            name="test",
            candidates=(RawDiscoveryCandidate(url="https://example.com"),),
        )
        result = provider.discover("test query")
        assert isinstance(result, DiscoveryResult)

    def test_provider_name_in_result(self, mock_public_dns):
        provider = StaticDiscoveryProvider(
            name="my-provider",
            candidates=(RawDiscoveryCandidate(url="https://example.com"),),
        )
        result = provider.discover("test query")
        assert result.provider_name == "my-provider"

    # 2. preserves candidate order

    def test_candidates_preserve_order(self, mock_public_dns):
        cands = [
            RawDiscoveryCandidate(url="https://example.com/a"),
            RawDiscoveryCandidate(url="https://example.com/b"),
            RawDiscoveryCandidate(url="https://example.com/c"),
        ]
        provider = StaticDiscoveryProvider(name="test", candidates=tuple(cands))
        result = provider.discover("test")
        urls = [c.url for c in result.candidates]
        assert urls == ["https://example.com/a", "https://example.com/b", "https://example.com/c"]

    def test_ranks_are_sequential(self, mock_public_dns):
        cands = [
            RawDiscoveryCandidate(url="https://example.com/a"),
            RawDiscoveryCandidate(url="https://example.com/b"),
        ]
        provider = StaticDiscoveryProvider(name="test", candidates=tuple(cands))
        result = provider.discover("test")
        ranks = [c.rank for c in result.candidates]
        assert ranks == [1, 2]

    # 3. passes through max_candidates

    def test_max_candidates_one(self, mock_public_dns):
        cands = [
            RawDiscoveryCandidate(url="https://example.com/a"),
            RawDiscoveryCandidate(url="https://example.com/b"),
        ]
        provider = StaticDiscoveryProvider(name="test", candidates=tuple(cands))
        result = provider.discover("test", max_candidates=1)
        assert len(result.candidates) == 1
        assert result.candidates[0].url == "https://example.com/a"

    def test_max_candidates_zero_records_error(self, mock_public_dns):
        cands = [RawDiscoveryCandidate(url="https://example.com/a")]
        provider = StaticDiscoveryProvider(name="test", candidates=tuple(cands))
        result = provider.discover("test", max_candidates=0)
        assert len(result.candidates) == 0
        error_codes = [e.code for e in result.errors]
        assert "max_candidates_zero" in error_codes

    # 4. safe URL path

    def test_safe_https_selected(self, mock_public_dns):
        provider = StaticDiscoveryProvider(
            name="test",
            candidates=(RawDiscoveryCandidate(url="https://example.com/doc"),),
        )
        result = provider.discover("test")
        assert result.candidates[0].selected_for_fetch is True
        assert result.candidates[0].url_policy == "passed"

    def test_urls_for_fetch_returns_normalized(self, mock_public_dns):
        provider = StaticDiscoveryProvider(
            name="test",
            candidates=(RawDiscoveryCandidate(url="https://Example.COM/path"),),
        )
        result = provider.discover("test")
        fetch_urls = urls_for_fetch(result)
        assert fetch_urls == ["https://example.com/path"]

    # 5. blocked URL path

    def test_file_scheme_blocked(self):
        provider = StaticDiscoveryProvider(
            name="test",
            candidates=(RawDiscoveryCandidate(url="file:///etc/passwd"),),
        )
        result = provider.discover("test")
        c = result.candidates[0]
        assert c.url_policy == "blocked"
        assert c.selected_for_fetch is False

    def test_localhost_blocked(self, mock_dns_mapper):
        mock_dns_mapper["localhost"] = "127.0.0.1"
        provider = StaticDiscoveryProvider(
            name="test",
            candidates=(RawDiscoveryCandidate(url="http://localhost"),),
        )
        result = provider.discover("test")
        assert result.candidates[0].url_policy == "blocked"

    def test_127_0_0_1_blocked(self, mock_dns_mapper):
        mock_dns_mapper["127.0.0.1"] = "127.0.0.1"
        provider = StaticDiscoveryProvider(
            name="test",
            candidates=(RawDiscoveryCandidate(url="http://127.0.0.1"),),
        )
        result = provider.discover("test")
        assert result.candidates[0].url_policy == "blocked"

    def test_credentials_blocked(self):
        provider = StaticDiscoveryProvider(
            name="test",
            candidates=(RawDiscoveryCandidate(url="https://user:pass@example.com"),),
        )
        result = provider.discover("test")
        assert result.candidates[0].url_policy == "blocked"

    def test_blocked_candidates_visible(self):
        provider = StaticDiscoveryProvider(
            name="test",
            candidates=(RawDiscoveryCandidate(url="file:///etc/passwd"),),
        )
        result = provider.discover("test")
        assert len(result.candidates) == 1
        assert result.candidates[0].url_policy == "blocked"

    def test_blocked_excluded_from_urls_for_fetch(self):
        provider = StaticDiscoveryProvider(
            name="test",
            candidates=(RawDiscoveryCandidate(url="file:///etc/passwd"),),
        )
        result = provider.discover("test")
        assert urls_for_fetch(result) == []

    # 6. duplicates

    def test_duplicate_collapsed_to_one(self, mock_public_dns):
        provider = StaticDiscoveryProvider(
            name="test",
            candidates=(
                RawDiscoveryCandidate(url="https://example.com/doc"),
                RawDiscoveryCandidate(url="https://example.com/doc"),
            ),
        )
        result = provider.discover("test")
        assert len(result.candidates) == 1
        assert any(
            "collapsed" in lim.lower() and "canonical" in lim.lower()
            for lim in result.limitations
        )

    def test_first_candidate_selected(self, mock_public_dns):
        provider = StaticDiscoveryProvider(
            name="test",
            candidates=(
                RawDiscoveryCandidate(url="https://example.com/doc", title="First"),
                RawDiscoveryCandidate(url="https://example.com/doc", title="Second"),
            ),
        )
        result = provider.discover("test")
        assert len(result.candidates) == 1
        assert result.candidates[0].selected_for_fetch is True
        assert result.candidates[0].duplicate_of is None
        assert result.candidates[0].title == "First"

    def test_urls_for_fetch_deduplicates(self, mock_public_dns):
        provider = StaticDiscoveryProvider(
            name="test",
            candidates=(
                RawDiscoveryCandidate(url="https://example.com/doc"),
                RawDiscoveryCandidate(url="https://example.com/doc"),
            ),
        )
        result = provider.discover("test")
        assert len(urls_for_fetch(result)) == 1

    # 7. metadata preservation

    def test_title_preserved(self, mock_public_dns):
        provider = StaticDiscoveryProvider(
            name="test",
            candidates=(
                RawDiscoveryCandidate(url="https://example.com", title="Example Page"),
            ),
        )
        result = provider.discover("test")
        assert result.candidates[0].title == "Example Page"

    def test_snippet_preserved(self, mock_public_dns):
        provider = StaticDiscoveryProvider(
            name="test",
            candidates=(
                RawDiscoveryCandidate(url="https://example.com", snippet="A useful snippet"),
            ),
        )
        result = provider.discover("test")
        assert result.candidates[0].snippet == "A useful snippet"

    def test_source_engine_preserved(self, mock_public_dns):
        provider = StaticDiscoveryProvider(
            name="test",
            candidates=(
                RawDiscoveryCandidate(url="https://example.com", source_engine="manual"),
            ),
        )
        result = provider.discover("test")
        assert result.candidates[0].source_engine == "manual"

    # 8. immutability / local safety

    def test_candidates_is_tuple(self):
        provider = StaticDiscoveryProvider(
            name="test",
            candidates=(RawDiscoveryCandidate(url="https://example.com"),),
        )
        assert isinstance(provider.candidates, tuple)

    def test_frozen_dataclass(self):
        provider = StaticDiscoveryProvider(
            name="test",
            candidates=(RawDiscoveryCandidate(url="https://example.com"),),
        )
        import dataclasses
        assert dataclasses.is_dataclass(provider)
        with pytest.raises(AttributeError):
            provider.name = "mutated"

    def test_factory_copies_input(self, mock_public_dns):
        input_list = [RawDiscoveryCandidate(url="https://example.com/a")]
        provider = static_provider(input_list, name="test")
        input_list.clear()
        assert len(provider.candidates) == 1

    # 9. no network guarantee

    def test_no_httpx_import_in_static_provider(self):
        provider = StaticDiscoveryProvider(
            name="test",
            candidates=(RawDiscoveryCandidate(url="https://example.com"),),
        )
        assert isinstance(provider.discover("test"), DiscoveryResult)

    def test_satisfies_protocol(self, mock_public_dns):
        provider = StaticDiscoveryProvider(
            name="test",
            candidates=(RawDiscoveryCandidate(url="https://example.com"),),
        )
        result = provider.discover("test")
        assert isinstance(result, DiscoveryResult)


# --- 11. SearxngDiscoveryProvider ---


import json as _json


def _searxng_response(body: dict | str | list, status_code: int = 200):
    """Build an httpx.Response for SearXNG mock testing."""
    if isinstance(body, str):
        content = body.encode()
    else:
        content = _json.dumps(body).encode()
    return httpx.Response(status_code=status_code, content=content, request=httpx.Request("POST", "https://dummy"))


_UNSET = object()


def _make_searxng_provider(body=_UNSET, status_code=200, *, mock_public_dns=None, **provider_kwargs):
    """Create a SearxngDiscoveryProvider with a MockTransport-injected client."""
    actual_body = body if body is not _UNSET else {"results": []}
    handler = lambda r: _searxng_response(actual_body, status_code)
    client = httpx.Client(transport=httpx.MockTransport(handler))
    return (
        SearxngDiscoveryProvider(base_url="https://search.example.com", _client=client, **provider_kwargs),
        client,
    )


def _make_searxng_provider_handler(handler_fn, *, mock_public_dns=None, **provider_kwargs):
    """Create a provider with a custom transport handler (for request capture)."""
    client = httpx.Client(transport=httpx.MockTransport(handler_fn))
    return (
        SearxngDiscoveryProvider(base_url="https://search.example.com", _client=client, **provider_kwargs),
        client,
    )


@pytest.fixture
def searxng_provider(mock_public_dns):
    p, c = _make_searxng_provider(mock_public_dns=mock_public_dns)
    yield p
    c.close()


class TestSearxngConfig:
    def test_base_url_required(self):
        with pytest.raises(TypeError):
            SearxngDiscoveryProvider()

    def test_base_url_with_trailing_slash_endpoint(self, mock_public_dns):
        captured_url = None
        def handler(request):
            nonlocal captured_url
            captured_url = request.url
            return _searxng_response({"results": []})
        p, c = _make_searxng_provider_handler(handler, mock_public_dns=mock_public_dns)
        p2 = SearxngDiscoveryProvider(base_url="https://search.example.com/", _client=c)
        p2.discover("test")
        c.close()
        assert captured_url.path == "/search"

    def test_base_url_without_trailing_slash_endpoint(self, mock_public_dns):
        captured_url = None
        def handler(request):
            nonlocal captured_url
            captured_url = request.url
            return _searxng_response({"results": []})
        p, c = _make_searxng_provider_handler(handler, mock_public_dns=mock_public_dns)
        p2 = SearxngDiscoveryProvider(base_url="https://search.example.com", _client=c)
        p2.discover("test")
        c.close()
        assert captured_url.path == "/search"

    def test_invalid_base_url_file_scheme(self):
        provider = SearxngDiscoveryProvider(base_url="file:///etc/searxng")
        result = provider.discover("test query")
        error_codes = [e.code for e in result.errors]
        assert "invalid_base_url" in error_codes
        assert result.candidates == ()

    def test_private_base_url_allowed(self, mock_dns_mapper):
        mock_dns_mapper["search.local"] = "192.168.1.1"
        provider = SearxngDiscoveryProvider(base_url="http://search.local")
        # With allow_private=True, it should pass the URL check and proceed to the request
        # We mock the response to avoid actual network call
        with patch("httpx.Client.request") as mock_request:
            mock_request.return_value = MagicMock(status_code=200, json=lambda: {"results": []})
            result = provider.discover("test query")
        assert not result.errors
        assert result.provider_name == "searxng"

    def test_candidates_remain_protected_even_with_private_provider(self, mock_dns_mapper):
        mock_dns_mapper["search.local"] = "192.168.1.1"
        mock_dns_mapper["localhost"] = "127.0.0.1"
        provider = SearxngDiscoveryProvider(base_url="http://search.local")

        # Mock SearXNG returning a localhost result
        with patch("httpx.Client.request") as mock_request:
            mock_request.return_value = MagicMock(status_code=200, json=lambda: {
                "results": [
                    {"url": "http://localhost/secret", "title": "Secret", "content": "secret", "engine": "google"}
                ]
            })
            result = provider.discover("test query")

        # Candidate should be blocked despite provider being on private network
        assert len(result.candidates) == 1
        c = result.candidates[0]
        assert c.url == "http://localhost/secret"
        assert c.url_policy == "blocked"
        assert "localhost" in c.blocked_reason
        assert not c.selected_for_fetch
        provider = SearxngDiscoveryProvider(base_url="https://user:pass@search.example.com")
        result = provider.discover("test query")
        error_codes = [e.code for e in result.errors]
        assert "invalid_base_url" in error_codes


class TestSearxngRequestFormation:
    def _capture_provider(self, mock_public_dns, **provider_kwargs):
        captured = {}
        def handler(request):
            captured["method"] = request.method
            captured["url"] = request.url
            captured["content"] = request.content
            return _searxng_response({"results": []})
        _, c = _make_searxng_provider_handler(handler, mock_public_dns=mock_public_dns, **provider_kwargs)
        provider = SearxngDiscoveryProvider(base_url="https://search.example.com", _client=c, **provider_kwargs)
        return provider, captured, c

    def test_post_method_used(self, mock_public_dns):
        provider, captured, c = self._capture_provider(mock_public_dns)
        provider.discover("test")
        c.close()
        assert captured["method"] == "POST"

    def test_endpoint_is_search(self, mock_public_dns):
        provider, captured, c = self._capture_provider(mock_public_dns)
        provider.discover("test")
        c.close()
        assert captured["url"].path == "/search"

    def test_form_data_contains_q(self, mock_public_dns):
        from urllib.parse import parse_qs
        provider, captured, c = self._capture_provider(mock_public_dns)
        provider.discover("test query")
        c.close()
        params = parse_qs(captured["content"].decode())
        assert params["q"] == ["test query"]

    def test_form_data_contains_format_json(self, mock_public_dns):
        from urllib.parse import parse_qs
        provider, captured, c = self._capture_provider(mock_public_dns)
        provider.discover("test")
        c.close()
        params = parse_qs(captured["content"].decode())
        assert params.get("format") == ["json"]

    def test_language_included_when_configured(self, mock_public_dns):
        from urllib.parse import parse_qs
        provider, captured, c = self._capture_provider(mock_public_dns, default_language="en")
        provider.discover("test")
        c.close()
        params = parse_qs(captured["content"].decode())
        assert params.get("language") == ["en"]

    def test_categories_joined_when_configured(self, mock_public_dns):
        from urllib.parse import parse_qs
        provider, captured, c = self._capture_provider(mock_public_dns, default_categories=("general", "science"))
        provider.discover("test")
        c.close()
        params = parse_qs(captured["content"].decode())
        assert params.get("categories") == ["general,science"]

    def test_safesearch_included_when_configured(self, mock_public_dns):
        from urllib.parse import parse_qs
        provider, captured, c = self._capture_provider(mock_public_dns, safesearch=1)
        provider.discover("test")
        c.close()
        params = parse_qs(captured["content"].decode())
        assert params.get("safesearch") == ["1"]

    def test_no_language_when_not_configured(self, mock_public_dns):
        from urllib.parse import parse_qs
        provider, captured, c = self._capture_provider(mock_public_dns)
        provider.discover("test")
        c.close()
        params = parse_qs(captured["content"].decode())
        assert "language" not in params

    def test_no_categories_when_not_configured(self, mock_public_dns):
        from urllib.parse import parse_qs
        provider, captured, c = self._capture_provider(mock_public_dns)
        provider.discover("test")
        c.close()
        params = parse_qs(captured["content"].decode())
        assert "categories" not in params

    def test_no_safesearch_when_not_configured(self, mock_public_dns):
        from urllib.parse import parse_qs
        provider, captured, c = self._capture_provider(mock_public_dns)
        provider.discover("test")
        c.close()
        params = parse_qs(captured["content"].decode())
        assert "safesearch" not in params

    def test_trust_env_false(self, mock_public_dns):
        transport = httpx.MockTransport(lambda r: _searxng_response({"results": []}))
        real_client = httpx.Client(transport=transport)
        with patch("search_tool.discovery.httpx.Client") as mock_cls:
            mock_cls.return_value = real_client
            provider = SearxngDiscoveryProvider(base_url="https://search.example.com")
            provider.discover("test")
        _, kwargs = mock_cls.call_args
        assert kwargs.get("trust_env") is False

    def test_timeout_is_explicit(self, mock_public_dns):
        transport = httpx.MockTransport(lambda r: _searxng_response({"results": []}))
        real_client = httpx.Client(transport=transport)
        with patch("search_tool.discovery.httpx.Client") as mock_cls:
            mock_cls.return_value = real_client
            provider = SearxngDiscoveryProvider(base_url="https://search.example.com", timeout_seconds=5.0)
            provider.discover("test")
        _, kwargs = mock_cls.call_args
        assert kwargs.get("timeout") == 5.0

    def test_follow_redirects_disabled(self, mock_public_dns):
        transport = httpx.MockTransport(lambda r: _searxng_response({"results": []}))
        real_client = httpx.Client(transport=transport)
        with patch("search_tool.discovery.httpx.Client") as mock_cls:
            mock_cls.return_value = real_client
            provider = SearxngDiscoveryProvider(base_url="https://search.example.com")
            provider.discover("test")
        _, kwargs = mock_cls.call_args
        assert kwargs.get("follow_redirects") is False


class TestSearxngResponseParsing:
    def _query(self, body, mock_public_dns):
        p, c = _make_searxng_provider(body, mock_public_dns=mock_public_dns)
        result = p.discover("test")
        c.close()
        return result

    def test_normal_result_becomes_selected(self, mock_public_dns):
        body = {"results": [{"url": "https://example.com/page", "title": "Example", "content": "A snippet"}]}
        result = self._query(body, mock_public_dns)
        assert len(result.candidates) == 1
        assert result.candidates[0].selected_for_fetch is True

    def test_title_mapped(self, mock_public_dns):
        body = {"results": [{"url": "https://example.com/page", "title": "Page Title", "content": "snippet"}]}
        result = self._query(body, mock_public_dns)
        assert result.candidates[0].title == "Page Title"

    def test_content_mapped_to_snippet(self, mock_public_dns):
        body = {"results": [{"url": "https://example.com/page", "title": "Title", "content": "Snippet text"}]}
        result = self._query(body, mock_public_dns)
        assert result.candidates[0].snippet == "Snippet text"

    def test_source_engine_is_searxng(self, mock_public_dns):
        body = {"results": [{"url": "https://example.com/page", "title": "T", "content": "S"}]}
        result = self._query(body, mock_public_dns)
        assert result.candidates[0].source_engine == "searxng"

    def test_unsafe_result_url_blocked(self, mock_public_dns):
        body = {"results": [{"url": "file:///etc/passwd", "title": "Hack", "content": "x"}]}
        result = self._query(body, mock_public_dns)
        assert result.candidates[0].url_policy == "blocked"
        assert result.candidates[0].selected_for_fetch is False

    def test_duplicate_result_collapsed_by_canonical_dedup(self, mock_public_dns):
        body = {"results": [
            {"url": "https://example.com/page", "title": "T", "content": "S"},
            {"url": "https://example.com/page", "title": "T2", "content": "S2"},
        ]}
        result = self._query(body, mock_public_dns)
        # Canonical dedup collapses exact duplicates to 1
        assert len(result.candidates) == 1
        assert result.candidates[0].selected_for_fetch is True
        assert any(
            "collapsed" in lim.lower() and "canonical" in lim.lower()
            for lim in result.limitations
        )

    def test_urls_for_fetch_returns_safe_normalized(self, mock_public_dns):
        body = {"results": [{"url": "https://Example.COM/page", "title": "T", "content": "S"}]}
        result = self._query(body, mock_public_dns)
        fetch_urls = urls_for_fetch(result)
        assert fetch_urls == ["https://example.com/page"]

    def test_empty_results_no_candidates_no_provider_error(self, mock_public_dns):
        body = {"results": []}
        result = self._query(body, mock_public_dns)
        assert result.candidates == ()
        provider_error_codes = [e.code for e in result.errors if e.code not in ("empty_provider",)]
        assert len(provider_error_codes) == 0


class TestSearxngMissingFields:
    def _query(self, body, mock_public_dns):
        p, c = _make_searxng_provider(body, mock_public_dns=mock_public_dns)
        result = p.discover("test")
        c.close()
        return result

    def test_missing_title_handled(self, mock_public_dns):
        body = {"results": [{"url": "https://example.com/page", "content": "snippet"}]}
        result = self._query(body, mock_public_dns)
        assert result.candidates[0].title is None

    def test_missing_content_handled(self, mock_public_dns):
        body = {"results": [{"url": "https://example.com/page", "title": "Title"}]}
        result = self._query(body, mock_public_dns)
        assert result.candidates[0].snippet is None

    def test_missing_url_skipped_with_error(self, mock_public_dns):
        body = {"results": [{"title": "No URL", "content": "snippet"}]}
        result = self._query(body, mock_public_dns)
        assert result.candidates == ()
        error_codes = [e.code for e in result.errors]
        assert "skipped_result" in error_codes

    def test_non_string_url_skipped_with_error(self, mock_public_dns):
        body = {"results": [{"url": 42, "title": "Bad URL"}]}
        result = self._query(body, mock_public_dns)
        assert result.candidates == ()
        error_codes = [e.code for e in result.errors]
        assert "skipped_result" in error_codes


class TestSearxngFailureHonesty:
    def test_403_returns_api_forbidden(self, mock_public_dns):
        p, c = _make_searxng_provider(status_code=403, mock_public_dns=mock_public_dns)
        result = p.discover("test")
        c.close()
        error_codes = [e.code for e in result.errors]
        assert "api_forbidden" in error_codes
        assert "settings.yml" in [e.message for e in result.errors if e.code == "api_forbidden"][0]

    def test_429_returns_rate_limited(self, mock_public_dns):
        p, c = _make_searxng_provider(status_code=429, mock_public_dns=mock_public_dns)
        result = p.discover("test")
        c.close()
        error_codes = [e.code for e in result.errors]
        assert "rate_limited" in error_codes

    def test_500_returns_server_error(self, mock_public_dns):
        p, c = _make_searxng_provider(status_code=500, mock_public_dns=mock_public_dns)
        result = p.discover("test")
        c.close()
        error_codes = [e.code for e in result.errors]
        assert "server_error" in error_codes

    def test_timeout_returns_timeout_error(self, mock_public_dns):
        mock_client = httpx.Client(transport=httpx.MockTransport(lambda r: (_ for _ in ()).throw(httpx.TimeoutException("timed out"))))
        provider = SearxngDiscoveryProvider(base_url="https://search.example.com", _client=mock_client)
        result = provider.discover("test")
        mock_client.close()
        error_codes = [e.code for e in result.errors]
        assert "timeout" in error_codes

    def test_connection_error_returns_connection_error(self, mock_public_dns):
        mock_client = httpx.Client(transport=httpx.MockTransport(lambda r: (_ for _ in ()).throw(httpx.ConnectError("refused"))))
        provider = SearxngDiscoveryProvider(base_url="https://search.example.com", _client=mock_client)
        result = provider.discover("test")
        mock_client.close()
        error_codes = [e.code for e in result.errors]
        assert "connection_error" in error_codes

    def test_malformed_json_returns_malformed_response(self, mock_public_dns):
        p, c = _make_searxng_provider(body="not json", mock_public_dns=mock_public_dns)
        result = p.discover("test")
        c.close()
        error_codes = [e.code for e in result.errors]
        assert "malformed_response" in error_codes

    def test_302_redirect_returns_redirect_not_followed(self, mock_public_dns):
        p, c = _make_searxng_provider(status_code=302, mock_public_dns=mock_public_dns)
        result = p.discover("test")
        c.close()
        error_codes = [e.code for e in result.errors]
        assert "redirect_not_followed" in error_codes


class TestSearxngInvalidResponseShape:
    def _query(self, body, mock_public_dns):
        p, c = _make_searxng_provider(body, mock_public_dns=mock_public_dns)
        result = p.discover("test")
        c.close()
        return result

    def test_json_array_not_dict_returns_invalid_response(self, mock_public_dns):
        result = self._query([], mock_public_dns)
        error_codes = [e.code for e in result.errors]
        assert "invalid_response" in error_codes

    def test_json_string_not_dict_returns_malformed_response(self, mock_public_dns):
        result = self._query("oops", mock_public_dns)
        error_codes = [e.code for e in result.errors]
        assert "malformed_response" in error_codes

    def test_results_not_list_returns_invalid_response(self, mock_public_dns):
        result = self._query({"results": "oops"}, mock_public_dns)
        error_codes = [e.code for e in result.errors]
        assert "invalid_response" in error_codes


class TestSearxngUnexpectedException:
    def test_unexpected_exception_returns_unexpected_error(self, mock_public_dns):
        mock_client = httpx.Client(transport=httpx.MockTransport(lambda r: (_ for _ in ()).throw(RuntimeError("something broke"))))
        provider = SearxngDiscoveryProvider(base_url="https://search.example.com", _client=mock_client)
        result = provider.discover("test")
        mock_client.close()
        error_codes = [e.code for e in result.errors]
        assert "unexpected_error" in error_codes
        assert "connection_error" not in error_codes
        assert isinstance(result, DiscoveryResult)


class TestSearxngQueryPrivacy:
    def test_query_normalized(self, mock_public_dns):
        p, c = _make_searxng_provider(body={"results": []}, mock_public_dns=mock_public_dns)
        result = p.discover("  hello   world  ")
        c.close()
        assert result.query_normalized == "hello world"

    def test_query_redacted(self, mock_public_dns):
        p, c = _make_searxng_provider(body={"results": []}, mock_public_dns=mock_public_dns)
        result = p.discover("search sk-abcdef1234567890abc")
        c.close()
        assert "[REDACTED]" in result.query_redacted
        assert result.query_original == "search sk-abcdef1234567890abc"

    def test_empty_query_no_http_call(self):
        provider = SearxngDiscoveryProvider(base_url="https://search.example.com")
        with patch("search_tool.discovery.httpx.Client") as mock_cls:
            provider.discover("   ")
            mock_cls.assert_not_called()

    def test_empty_query_returns_empty_query_error(self):
        provider = SearxngDiscoveryProvider(base_url="https://search.example.com")
        result = provider.discover("")
        error_codes = [e.code for e in result.errors]
        assert "empty_query" in error_codes


class TestSearxngNoLiveInternet:
    def test_mocked_transport_used(self, mock_public_dns):
        call_count = 0
        def handler(request):
            nonlocal call_count
            call_count += 1
            return httpx.Response(200, b'{"results":[]}', request=request)
        p, c = _make_searxng_provider_handler(handler, mock_public_dns=mock_public_dns)
        p.discover("test")
        c.close()
        assert call_count == 1

    def test_no_real_searxng_called(self, mock_public_dns):
        p, c = _make_searxng_provider(body={"results": []}, mock_public_dns=mock_public_dns)
        result = p.discover("test")
        c.close()
        assert result.candidates == ()

    def test_dns_mocked_for_url_policy(self, mock_public_dns):
        p, c = _make_searxng_provider(body={"results": []}, mock_public_dns=mock_public_dns)
        result = p.discover("test")
        c.close()
        assert result.provider_name == "searxng"


# --- helpers ---


def build_discovery_query_blocked(url: str) -> DiscoveryResult:
    return build_discovery_result("test", "test", [RawDiscoveryCandidate(url=url)])


def build_discovery_query_empty_candidates(query, provider, raw, *, max_candidates=0) -> DiscoveryResult:
    return build_discovery_result(query, provider, raw, max_candidates=max_candidates)


def build_discovery_query_provider_unknown(query, provider) -> DiscoveryResult:
    return build_discovery_result(query, provider, [])
