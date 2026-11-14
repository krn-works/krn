"""Tests for MVP-1M.4 final_url dedup (mark-only visibility)."""

from pathlib import Path
from functools import partial
from unittest.mock import MagicMock, patch

from search_tool.canonical import canonicalize_url_for_dedup
from search_tool.search import EvidenceWriteResult, SearchRunResult, search_query
from search_tool.discovery import DiscoveryResult, DiscoveryCandidate
from search_tool.run import fetch_url_to_evidence


# --- EvidenceWriteResult.final_url field ---


class TestEvidenceWriteResultFinalUrl:
    """Test final_url field on EvidenceWriteResult."""

    def test_final_url_field_exists(self):
        er = EvidenceWriteResult(
            original_url="https://example.com",
            normalized_url="https://example.com/",
            evidence_path=Path("/dev/null"),
            fetch_status="success",
            http_status=200,
            cache_status="miss",
            extraction_status="success",
            text_chars=100,
            truncated=False,
            errors=(),
            limitations=(),
            final_url="https://example.com/",
        )
        assert er.final_url == "https://example.com/"

    def test_final_url_defaults_to_none(self):
        er = EvidenceWriteResult(
            original_url="https://example.com",
            normalized_url="https://example.com/",
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
        assert er.final_url is None

    def test_final_url_can_be_none_explicit(self):
        er = EvidenceWriteResult(
            original_url="https://example.com",
            normalized_url="https://example.com/",
            evidence_path=Path("/dev/null"),
            fetch_status="success",
            http_status=200,
            cache_status="miss",
            extraction_status="success",
            text_chars=100,
            truncated=False,
            errors=(),
            limitations=(),
            final_url=None,
        )
        assert er.final_url is None

    def test_evidence_write_result_is_frozen(self):
        er = EvidenceWriteResult(
            original_url="https://example.com",
            normalized_url="https://example.com/",
            evidence_path=Path("/dev/null"),
            fetch_status="success",
            http_status=200,
            cache_status="miss",
            extraction_status="success",
            text_chars=100,
            truncated=False,
            errors=(),
            limitations=(),
            final_url="https://example.com/",
        )
        assert getattr(er, "__dataclass_params__").frozen is True


# --- Dedup registry logic (direct search_query test) ---


def _make_fake_fetcher(*fetch_results):
    """Build a fetcher that returns pre-built EvidenceWriteResults."""
    idx = 0

    def fake_fetcher(url, refresh, follow_redirects, **kwargs):
        nonlocal idx
        if idx < len(fetch_results):
            result = fetch_results[idx]
            idx += 1
            return result
        return EvidenceWriteResult(
            original_url=url,
            normalized_url=url,
            evidence_path=Path("/dev/null"),
            fetch_status="success",
            http_status=200,
            cache_status="miss",
            extraction_status="success",
            text_chars=100,
            truncated=False,
            errors=(),
            limitations=(),
            final_url=None,
        )

    return fake_fetcher


def _make_discovery():
    """Return a mock provider that yields candidates for urls_for_fetch."""
    from search_tool.discovery import RawDiscoveryCandidate, DiscoveryCandidate
    mock = MagicMock()
    mock.discover.return_value = DiscoveryResult(
        schema_version="0.1",
        query_original="test query",
        query_normalized="test query",
        query_redacted="test query",
        provider_name="static",
        candidates=(
            DiscoveryCandidate(
                rank=1,
                url="https://example.com/",
                normalized_url="https://example.com/",
                title=None,
                snippet=None,
                source_engine=None,
                url_policy="passed",
                blocked_reason=None,
                selected_for_fetch=True,
            ),
            DiscoveryCandidate(
                rank=2,
                url="https://example.com/?utm_source=foo",
                normalized_url="https://example.com/?utm_source=foo",
                title=None,
                snippet=None,
                source_engine=None,
                url_policy="passed",
                blocked_reason=None,
                selected_for_fetch=True,
            ),
        ),
        errors=tuple(),
        limitations=("Query redaction is best-effort.",),
    )
    return mock


def _make_er(url, fetch_status="success", final_url=None, http_status=200, cache_status="miss"):
    return EvidenceWriteResult(
        original_url=url,
        normalized_url=url,
        evidence_path=Path(f"/evidence/{url}.md"),
        fetch_status=fetch_status,
        http_status=http_status,
        cache_status=cache_status,
        extraction_status="success" if fetch_status == "success" else "skipped",
        text_chars=100 if fetch_status == "success" else 0,
        truncated=False,
        errors=(),
        limitations=(),
        final_url=final_url,
    )


class TestFinalUrlDedupRegistry:
    """Unit tests for the final_url dedup registry in search_query()."""

    def test_two_results_same_final_url_collapsed(self):
        """Two candidates fetch to the same final_url → duplicate_count=1."""
        fetcher = _make_fake_fetcher(
            _make_er("https://example.com/", final_url="https://example.com"),
            _make_er("https://example.com/?utm_source=foo", final_url="https://example.com"),
        )
        result = search_query(
            provider=_make_discovery(),
            query="test",
            fetcher=fetcher,
        )
        # Both evidence results present (mark-only)
        assert len(result.evidence_results) == 2
        # Dedup limitation present
        assert any(
            "Detected 1 duplicate fetched URLs by final_url canonical dedup" in lim
            for lim in result.limitations
        )

    def test_no_redirect_no_dedup(self):
        """Two candidates with final_url=None → no dedup."""
        fetcher = _make_fake_fetcher(
            _make_er("https://example.com/", final_url=None),
            _make_er("https://example.com/?utm_source=foo", final_url=None),
        )
        result = search_query(
            provider=_make_discovery(),
            query="test",
            fetcher=fetcher,
        )
        assert len(result.evidence_results) == 2
        assert not any("duplicate fetched URLs" in lim for lim in result.limitations)

    def test_different_final_urls_no_dedup(self):
        """Two candidates with different final_urls → no dedup."""
        fetcher = _make_fake_fetcher(
            _make_er("https://example.com/", final_url="https://example.com/"),
            _make_er("https://example.org/", final_url="https://example.org/"),
        )
        result = search_query(
            provider=_make_discovery(),
            query="test",
            fetcher=fetcher,
        )
        assert len(result.evidence_results) == 2
        assert not any("duplicate fetched URLs" in lim for lim in result.limitations)

    def test_tracking_param_final_url_collapsed(self):
        """Final URLs differing only by tracking params → deduped."""
        fetcher = _make_fake_fetcher(
            _make_er("https://example.com/page", final_url="https://example.com/page?utm_source=foo"),
            _make_er("https://example.com/page", final_url="https://example.com/page?gclid=abc123"),
        )
        result = search_query(
            provider=_make_discovery(),
            query="test",
            fetcher=fetcher,
        )
        assert any("Detected 1 duplicate fetched URLs by final_url canonical dedup" in lim for lim in result.limitations)

    def test_trailing_slash_final_url_collapsed(self):
        """Final URLs differing by trailing slash → deduped."""
        fetcher = _make_fake_fetcher(
            _make_er("https://example.com/docs", final_url="https://example.com/docs/"),
            _make_er("https://example.com/docs/", final_url="https://example.com/docs"),
        )
        result = search_query(
            provider=_make_discovery(),
            query="test",
            fetcher=fetcher,
        )
        assert any("Detected 1 duplicate fetched URLs by final_url canonical dedup" in lim for lim in result.limitations)

    def test_failed_fetch_not_collapsed(self):
        """Failed fetch has no contribution to dedup."""
        fetcher = _make_fake_fetcher(
            _make_er("https://example.com/", final_url="https://example.com"),
            _make_er("https://example.com/old", fetch_status="failed", final_url=None),
        )
        result = search_query(
            provider=_make_discovery(),
            query="test",
            fetcher=fetcher,
        )
        assert len(result.evidence_results) == 2
        assert not any("duplicate fetched URLs" in lim for lim in result.limitations)

    def test_blocked_fetch_not_collapsed(self):
        """Blocked fetch has no contribution to dedup."""
        fetcher = _make_fake_fetcher(
            _make_er("https://example.com/", final_url="https://example.com"),
            _make_er("https://example.com/old", fetch_status="blocked", final_url=None),
        )
        result = search_query(
            provider=_make_discovery(),
            query="test",
            fetcher=fetcher,
        )
        assert len(result.evidence_results) == 2
        assert not any("duplicate fetched URLs" in lim for lim in result.limitations)

    def test_multiple_duplicates(self):
        """Three results with same final_url → duplicate_count=2."""
        from search_tool.discovery import DiscoveryCandidate
        multi_discovery = MagicMock()
        multi_discovery.discover.return_value = DiscoveryResult(
            schema_version="0.1",
            query_original="test query",
            query_normalized="test query",
            query_redacted="test query",
            provider_name="static",
            candidates=(
                DiscoveryCandidate(
                    rank=1, url="https://example.com/", normalized_url="https://example.com/",
                    title=None, snippet=None, source_engine=None,
                    url_policy="passed", blocked_reason=None, selected_for_fetch=True,
                ),
                DiscoveryCandidate(
                    rank=2, url="https://example.com/?utm_source=foo",
                    normalized_url="https://example.com/?utm_source=foo",
                    title=None, snippet=None, source_engine=None,
                    url_policy="passed", blocked_reason=None, selected_for_fetch=True,
                ),
                DiscoveryCandidate(
                    rank=3, url="https://example.com/latest/",
                    normalized_url="https://example.com/latest/",
                    title=None, snippet=None, source_engine=None,
                    url_policy="passed", blocked_reason=None, selected_for_fetch=True,
                ),
            ),
            errors=tuple(),
            limitations=("Query redaction is best-effort.",),
        )
        fetcher = _make_fake_fetcher(
            _make_er("https://example.com/", final_url="https://example.com"),
            _make_er("https://example.com/?utm_source=foo", final_url="https://example.com"),
            _make_er("https://example.com/latest/", final_url="https://example.com"),
        )
        result = search_query(
            provider=multi_discovery,
            query="test",
            fetcher=fetcher,
        )
        assert len(result.evidence_results) == 3
        assert any("Detected 2 duplicate fetched URLs by final_url canonical dedup" in lim for lim in result.limitations)

    def test_limitation_message_present(self):
        """Duplicates found → limitations contains exact message."""
        fetcher = _make_fake_fetcher(
            _make_er("https://a.com/", final_url="https://a.com"),
            _make_er("https://a.com/?utm_foo", final_url="https://a.com"),
        )
        result = search_query(
            provider=_make_discovery(),
            query="test",
            fetcher=fetcher,
        )
        assert any(
            "Detected 1 duplicate fetched URLs by final_url canonical dedup." == lim
            for lim in result.limitations
        )

    def test_limitation_message_absent(self):
        """No duplicates → no final_url dedup message."""
        fetcher = _make_fake_fetcher(
            _make_er("https://a.com/", final_url="https://a.com"),
            _make_er("https://b.com/", final_url="https://b.com"),
        )
        result = search_query(
            provider=_make_discovery(),
            query="test",
            fetcher=fetcher,
        )
        assert not any("duplicate fetched URLs" in lim for lim in result.limitations)

    def test_final_url_field_set_on_success(self):
        """final_url is set when redirects followed."""
        er = _make_er("https://example.com/", final_url="https://example.com")
        assert er.final_url == "https://example.com"

    def test_final_url_none_when_no_redirects(self):
        """final_url is None when no redirect info."""
        er = _make_er("https://example.com/", final_url=None)
        assert er.final_url is None

    def test_mark_only_no_result_count_change(self):
        """Mark-only: all results present, none skipped."""
        fetcher = _make_fake_fetcher(
            _make_er("https://example.com/", final_url="https://example.com"),
            _make_er("https://example.com/?utm_source=foo", final_url="https://example.com"),
        )
        result = search_query(
            provider=_make_discovery(),
            query="test",
            fetcher=fetcher,
        )
        assert len(result.evidence_results) == 2
        # No status changes — all success
        assert all(er.fetch_status == "success" for er in result.evidence_results)

    def test_discovery_limitations_preserved_order(self):
        """Discovery limitations come before final_url dedup limitation."""
        fetcher = _make_fake_fetcher(
            _make_er("https://a.com/", final_url="https://a.com"),
            _make_er("https://a.com/?utm_foo", final_url="https://a.com"),
        )
        result = search_query(
            provider=_make_discovery(),
            query="test",
            fetcher=fetcher,
        )
        lim_list = list(result.limitations)
        # Discovery limitation comes first
        discovery_idx = next(i for i, l in enumerate(lim_list) if "redaction" in l)
        dedup_idx = next(i for i, l in enumerate(lim_list) if "duplicate" in l)
        assert discovery_idx < dedup_idx


class TestCanonicalizeFinalUrl:
    """Test that canonicalize_url_for_dedup handles final_url variants correctly."""

    def test_trailing_slash_collapsed(self):
        assert canonicalize_url_for_dedup("https://example.com/docs/") == "https://example.com/docs"

    def test_fragment_stripped(self):
        assert canonicalize_url_for_dedup("https://example.com/page#section") == "https://example.com/page"

    def test_utm_params_removed(self):
        assert canonicalize_url_for_dedup("https://example.com/page?utm_source=foo&utm_campaign=bar") == "https://example.com/page"

    def test_query_params_sorted(self):
        a = canonicalize_url_for_dedup("https://example.com/page?z=1&a=2")
        b = canonicalize_url_for_dedup("https://example.com/page?a=2&z=1")
        assert a == b

    def test_host_lowercased(self):
        assert canonicalize_url_for_dedup("HTTPS://EXAMPLE.COM/path") == "https://example.com/path"


# --- MVP-1M.6 dedup metadata fields ---


class TestMVP1M6DedupMetadata:
    """M.6: dedup_status, duplicate_of_url, duplicate_of_evidence_path fields."""

    def test_dedup_status_field_exists(self):
        er = EvidenceWriteResult(
            original_url="https://example.com/",
            normalized_url="https://example.com/",
            evidence_path=Path("/dev/null"),
            fetch_status="success",
            http_status=200,
            cache_status="miss",
            extraction_status="success",
            text_chars=100,
            truncated=False,
            errors=(),
            limitations=(),
            final_url=None,
            dedup_status="duplicate_final_url",
        )
        assert er.dedup_status == "duplicate_final_url"

    def test_dedup_status_defaults_unique(self):
        er = EvidenceWriteResult(
            original_url="https://example.com/",
            normalized_url="https://example.com/",
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
        assert er.dedup_status == "unique"
        assert er.duplicate_of_url is None
        assert er.duplicate_of_evidence_path is None

    def test_duplicate_fields_set_on_dedup(self):
        """Duplicate result has dedup_status='duplicate_final_url', duplicate_of_url, duplicate_of_evidence_path set."""
        fetcher = _make_fake_fetcher(
            _make_er("https://example.com/", final_url="https://example.com"),
            _make_er("https://example.com/?utm_source=foo", final_url="https://example.com"),
        )
        result = search_query(
            provider=_make_discovery(),
            query="test",
            fetcher=fetcher,
        )
        # First is unique
        assert result.evidence_results[0].dedup_status == "unique"
        assert result.evidence_results[0].duplicate_of_url is None
        assert result.evidence_results[0].duplicate_of_evidence_path is None
        # Second is duplicate
        assert result.evidence_results[1].dedup_status == "duplicate_final_url"
        assert result.evidence_results[1].duplicate_of_url == "https://example.com"
        assert result.evidence_results[1].duplicate_of_evidence_path == Path("/evidence/https://example.com/.md")

    def test_duplicate_fields_none_on_unique(self):
        """Unique result has None for duplicate fields."""
        fetcher = _make_fake_fetcher(
            _make_er("https://a.com/", final_url="https://a.com"),
            _make_er("https://b.com/", final_url="https://b.com"),
        )
        result = search_query(
            provider=_make_discovery(),
            query="test",
            fetcher=fetcher,
        )
        for er in result.evidence_results:
            assert er.dedup_status == "unique"
            assert er.duplicate_of_url is None
            assert er.duplicate_of_evidence_path is None

    def test_duplicate_of_evidence_path_points_to_kept(self):
        """Path matches the first result's evidence_path."""
        kept_path = Path("/evidence/first.md")
        dup_path = Path("/evidence/second.md")
        er0 = EvidenceWriteResult(
            original_url="https://example.com/",
            normalized_url="https://example.com/",
            evidence_path=kept_path,
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
        er1 = EvidenceWriteResult(
            original_url="https://example.com/?utm_source=foo",
            normalized_url="https://example.com/?utm_source=foo",
            evidence_path=dup_path,
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

        def fetcher(url, refresh, follow_redirects, **kwargs):
            return er0 if "utm_source" not in url else er1

        # Use a minimal discovery mock
        from search_tool.discovery import DiscoveryCandidate
        mock = MagicMock()
        mock.discover.return_value = DiscoveryResult(
            schema_version="0.1",
            query_original="test query",
            query_normalized="test query",
            query_redacted="test query",
            provider_name="static",
            candidates=(
                DiscoveryCandidate(
                    rank=1, url="https://example.com/", normalized_url="https://example.com/",
                    title=None, snippet=None, source_engine=None,
                    url_policy="passed", blocked_reason=None, selected_for_fetch=True,
                ),
                DiscoveryCandidate(
                    rank=2, url="https://example.com/?utm_source=foo",
                    normalized_url="https://example.com/?utm_source=foo",
                    title=None, snippet=None, source_engine=None,
                    url_policy="passed", blocked_reason=None, selected_for_fetch=True,
                ),
            ),
            errors=tuple(),
            limitations=("Query redaction is best-effort.",),
        )

        result = search_query(
            provider=mock,
            query="test",
            fetcher=fetcher,
        )
        assert result.evidence_results[0].evidence_path == kept_path
        assert result.evidence_results[1].duplicate_of_evidence_path == kept_path

    def test_multiple_duplicates_all_marked(self):
        """Three results, one kept + two duplicates, all marked."""
        from search_tool.discovery import DiscoveryCandidate
        multi_discovery = MagicMock()
        multi_discovery.discover.return_value = DiscoveryResult(
            schema_version="0.1",
            query_original="test query",
            query_normalized="test query",
            query_redacted="test query",
            provider_name="static",
            candidates=(
                DiscoveryCandidate(
                    rank=1, url="https://example.com/", normalized_url="https://example.com/",
                    title=None, snippet=None, source_engine=None,
                    url_policy="passed", blocked_reason=None, selected_for_fetch=True,
                ),
                DiscoveryCandidate(
                    rank=2, url="https://example.com/?utm_source=foo",
                    normalized_url="https://example.com/?utm_source=foo",
                    title=None, snippet=None, source_engine=None,
                    url_policy="passed", blocked_reason=None, selected_for_fetch=True,
                ),
                DiscoveryCandidate(
                    rank=3, url="https://example.com/latest/",
                    normalized_url="https://example.com/latest/",
                    title=None, snippet=None, source_engine=None,
                    url_policy="passed", blocked_reason=None, selected_for_fetch=True,
                ),
            ),
            errors=tuple(),
            limitations=("Query redaction is best-effort.",),
        )
        fetcher = _make_fake_fetcher(
            _make_er("https://example.com/", final_url="https://example.com"),
            _make_er("https://example.com/?utm_source=foo", final_url="https://example.com"),
            _make_er("https://example.com/latest/", final_url="https://example.com"),
        )
        result = search_query(
            provider=multi_discovery,
            query="test",
            fetcher=fetcher,
        )
        assert result.evidence_results[0].dedup_status == "unique"
        assert result.evidence_results[1].dedup_status == "duplicate_final_url"
        assert result.evidence_results[1].duplicate_of_url == "https://example.com"
        assert result.evidence_results[2].dedup_status == "duplicate_final_url"
        assert result.evidence_results[2].duplicate_of_url == "https://example.com"

    def test_dedup_metadata_not_in_mark_only_limitation(self):
        """Limitation still says 'Detected' not 'Skipped'."""
        fetcher = _make_fake_fetcher(
            _make_er("https://a.com/", final_url="https://a.com"),
            _make_er("https://a.com/?utm_foo", final_url="https://a.com"),
        )
        result = search_query(
            provider=_make_discovery(),
            query="test",
            fetcher=fetcher,
        )
        assert any("Detected" in lim and "duplicate" in lim for lim in result.limitations)
        assert not any("Skipped" in lim for lim in result.limitations)

    def test_dedup_fields_backward_compat(self):
        """Existing code doesn't break with new fields — positional args still work."""
        er = EvidenceWriteResult(
            original_url="https://example.com/",
            normalized_url="https://example.com/",
            evidence_path=Path("/dev/null"),
            fetch_status="success",
            http_status=200,
            cache_status="miss",
            extraction_status="success",
            text_chars=100,
            truncated=False,
            errors=(),
            limitations=(),
            final_url="https://example.com",
            dedup_status="unique",
            duplicate_of_url=None,
            duplicate_of_evidence_path=None,
        )
        # Verify all new fields are settable
        assert er.dedup_status == "unique"
        assert er.duplicate_of_url is None
        assert er.duplicate_of_evidence_path is None
        # Verify frozen dataclass still works
        assert getattr(er, "__dataclass_params__").frozen is True
        # Verify tuple conversion (used in SearchRunResult)
        t = (er,)
        assert len(t) == 1
        assert t[0].dedup_status == "unique"


# --- MVP-1M.7 skip extraction ---


class TestMVP1M7SkipExtraction:
    """M.7: fetch_status='skipped_duplicate' when final_url is already known."""

    def test_skipped_fetch_status(self):
        """Duplicate returns fetch_status='skipped_duplicate'."""
        import tempfile
        from pathlib import Path

        with tempfile.TemporaryDirectory() as tmp:
            registry = {}
            ep = Path(tmp) / "evidence"
            ep.mkdir()
            # First result: unique, will register final_url
            r0 = fetch_url_to_evidence(
                "https://example.com/", refresh=True, follow_redirects=True,
                evidence_dir=ep, cache_dir=Path(tmp) / "cache",
                _final_url_dedup_registry=registry,
            )
            # Manually register a final_url in the registry (simulating
            # a prior successful fetch that followed redirects).
            test_final = "https://example.com/docs/"
            key = canonicalize_url_for_dedup(test_final)
            registry[key] = EvidenceWriteResult(
                original_url="https://example.com/",
                normalized_url="https://example.com/",
                evidence_path=ep / "kept.md",
                fetch_status="success",
                http_status=200,
                cache_status="miss",
                extraction_status="success",
                text_chars=100,
                truncated=False,
                errors=(),
                limitations=(),
                final_url=test_final,
            )
            # Second result: same canonical final_url via redirect
            import socket
            with patch("search_tool.run.fetch_url") as mock_fetch, \
                 patch("search_tool.run.cache_get") as mock_cache, \
                 patch("search_tool.url_policy.socket.getaddrinfo"):
                mock_cache.return_value = MagicMock(status="miss")
                mock_fetch.return_value = MagicMock(
                    status="success",
                    http_status=301,
                    content_type="text/html",
                    body_bytes=b"<html><body>redirect</body></html>",
                    body_sha256="fake",
                    redirects=[{"status": 301, "location": test_final, "resolved_url": test_final}],
                    errors=[],
                )
                r1 = fetch_url_to_evidence(
                    "https://example.com/old", refresh=True, follow_redirects=True,
                    evidence_dir=ep, cache_dir=Path(tmp) / "cache",
                    _final_url_dedup_registry=registry,
                )
            assert r1.fetch_status == "skipped_duplicate"

    def test_skipped_extraction_status(self):
        """Duplicate has extraction_status='skipped'."""
        with patch("search_tool.run.fetch_url") as mock_fetch, \
             patch("search_tool.run.cache_get") as mock_cache, \
             patch("search_tool.url_policy.socket.getaddrinfo"):
            mock_cache.return_value = MagicMock(status="miss")
            mock_fetch.return_value = MagicMock(
                status="success", http_status=301, content_type="text/html",
                body_bytes=b"<html><body>redirect</body></html>",
                body_sha256="fake",
                redirects=[{"status": 301, "location": "https://example.com/", "resolved_url": "https://example.com/"}],
                errors=[],
            )
            ep = Path("/tmp/m7-test-evidence")
            ep.mkdir(exist_ok=True)
            registry = {}
            from search_tool.canonical import canonicalize_url_for_dedup
            key = canonicalize_url_for_dedup("https://example.com/")
            registry[key] = EvidenceWriteResult(
                original_url="https://example.com/", normalized_url="https://example.com/",
                evidence_path=ep / "kept.md", fetch_status="success", http_status=200,
                cache_status="miss", extraction_status="success", text_chars=100,
                truncated=False, errors=(), limitations=(), final_url="https://example.com/",
            )
            r = fetch_url_to_evidence(
                "https://example.com/old", refresh=True, follow_redirects=True,
                evidence_dir=ep, cache_dir=Path("/tmp/m7-cache"),
                _final_url_dedup_registry=registry,
            )
        assert r.extraction_status == "skipped"

    def test_skipped_evidence_path_kept(self):
        """Duplicate evidence_path points to kept pack."""
        with patch("search_tool.run.fetch_url") as mock_fetch, \
             patch("search_tool.run.cache_get") as mock_cache, \
             patch("search_tool.url_policy.socket.getaddrinfo"):
            mock_cache.return_value = MagicMock(status="miss")
            mock_fetch.return_value = MagicMock(
                status="success", http_status=301, content_type="text/html",
                body_bytes=b"<html><body>redirect</body></html>",
                body_sha256="fake",
                redirects=[{"status": 301, "location": "https://example.com/", "resolved_url": "https://example.com/"}],
                errors=[],
            )
            ep = Path("/tmp/m7-test-evidence2")
            ep.mkdir(exist_ok=True)
            registry = {}
            from search_tool.canonical import canonicalize_url_for_dedup
            key = canonicalize_url_for_dedup("https://example.com/")
            registry[key] = EvidenceWriteResult(
                original_url="https://example.com/", normalized_url="https://example.com/",
                evidence_path=ep / "kept.md", fetch_status="success", http_status=200,
                cache_status="miss", extraction_status="success", text_chars=100,
                truncated=False, errors=(), limitations=(), final_url="https://example.com/",
            )
            r = fetch_url_to_evidence(
                "https://example.com/old", refresh=True, follow_redirects=True,
                evidence_dir=ep, cache_dir=Path("/tmp/m7-cache2"),
                _final_url_dedup_registry=registry,
            )
        assert r.evidence_path == ep / "kept.md"

    def test_skipped_text_chars_zero(self):
        """Duplicate has text_chars=0."""
        with patch("search_tool.run.fetch_url") as mock_fetch, \
             patch("search_tool.run.cache_get") as mock_cache, \
             patch("search_tool.url_policy.socket.getaddrinfo"):
            mock_cache.return_value = MagicMock(status="miss")
            mock_fetch.return_value = MagicMock(
                status="success", http_status=301, content_type="text/html",
                body_bytes=b"<html><body>redirect</body></html>",
                body_sha256="fake",
                redirects=[{"status": 301, "location": "https://example.com/", "resolved_url": "https://example.com/"}],
                errors=[],
            )
            ep = Path("/tmp/m7-test-evidence3")
            ep.mkdir(exist_ok=True)
            registry = {}
            from search_tool.canonical import canonicalize_url_for_dedup
            key = canonicalize_url_for_dedup("https://example.com/")
            registry[key] = EvidenceWriteResult(
                original_url="https://example.com/", normalized_url="https://example.com/",
                evidence_path=ep / "kept.md", fetch_status="success", http_status=200,
                cache_status="miss", extraction_status="success", text_chars=100,
                truncated=False, errors=(), limitations=(), final_url="https://example.com/",
            )
            r = fetch_url_to_evidence(
                "https://example.com/old", refresh=True, follow_redirects=True,
                evidence_dir=ep, cache_dir=Path("/tmp/m7-cache3"),
                _final_url_dedup_registry=registry,
            )
        assert r.text_chars == 0

    def test_skipped_dedup_status(self):
        """Duplicate has dedup_status='duplicate_final_url'."""
        with patch("search_tool.run.fetch_url") as mock_fetch, \
             patch("search_tool.run.cache_get") as mock_cache, \
             patch("search_tool.url_policy.socket.getaddrinfo"):
            mock_cache.return_value = MagicMock(status="miss")
            mock_fetch.return_value = MagicMock(
                status="success", http_status=301, content_type="text/html",
                body_bytes=b"<html><body>redirect</body></html>",
                body_sha256="fake",
                redirects=[{"status": 301, "location": "https://example.com/", "resolved_url": "https://example.com/"}],
                errors=[],
            )
            ep = Path("/tmp/m7-test-evidence4")
            ep.mkdir(exist_ok=True)
            registry = {}
            from search_tool.canonical import canonicalize_url_for_dedup
            key = canonicalize_url_for_dedup("https://example.com/")
            registry[key] = EvidenceWriteResult(
                original_url="https://example.com/", normalized_url="https://example.com/",
                evidence_path=ep / "kept.md", fetch_status="success", http_status=200,
                cache_status="miss", extraction_status="success", text_chars=100,
                truncated=False, errors=(), limitations=(), final_url="https://example.com/",
            )
            r = fetch_url_to_evidence(
                "https://example.com/old", refresh=True, follow_redirects=True,
                evidence_dir=ep, cache_dir=Path("/tmp/m7-cache4"),
                _final_url_dedup_registry=registry,
            )
        assert r.dedup_status == "duplicate_final_url"

    def test_skipped_duplicate_of_evidence_path(self):
        """duplicate_of_evidence_path points to kept pack."""
        with patch("search_tool.run.fetch_url") as mock_fetch, \
             patch("search_tool.run.cache_get") as mock_cache, \
             patch("search_tool.url_policy.socket.getaddrinfo"):
            mock_cache.return_value = MagicMock(status="miss")
            mock_fetch.return_value = MagicMock(
                status="success", http_status=301, content_type="text/html",
                body_bytes=b"<html><body>redirect</body></html>",
                body_sha256="fake",
                redirects=[{"status": 301, "location": "https://example.com/", "resolved_url": "https://example.com/"}],
                errors=[],
            )
            ep = Path("/tmp/m7-test-evidence5")
            ep.mkdir(exist_ok=True)
            kept_path = ep / "kept.md"
            registry = {}
            from search_tool.canonical import canonicalize_url_for_dedup
            key = canonicalize_url_for_dedup("https://example.com/")
            registry[key] = EvidenceWriteResult(
                original_url="https://example.com/", normalized_url="https://example.com/",
                evidence_path=kept_path, fetch_status="success", http_status=200,
                cache_status="miss", extraction_status="success", text_chars=100,
                truncated=False, errors=(), limitations=(), final_url="https://example.com/",
            )
            r = fetch_url_to_evidence(
                "https://example.com/old", refresh=True, follow_redirects=True,
                evidence_dir=ep, cache_dir=Path("/tmp/m7-cache5"),
                _final_url_dedup_registry=registry,
            )
        assert r.duplicate_of_evidence_path == kept_path

    def test_skipped_duplicate_of_url_matches_kept(self):
        """duplicate_of_url matches kept final_url."""
        with patch("search_tool.run.fetch_url") as mock_fetch, \
             patch("search_tool.run.cache_get") as mock_cache, \
             patch("search_tool.url_policy.socket.getaddrinfo"):
            mock_cache.return_value = MagicMock(status="miss")
            mock_fetch.return_value = MagicMock(
                status="success", http_status=301, content_type="text/html",
                body_bytes=b"<html><body>redirect</body></html>",
                body_sha256="fake",
                redirects=[{"status": 301, "location": "https://example.com/", "resolved_url": "https://example.com/"}],
                errors=[],
            )
            ep = Path("/tmp/m7-test-evidence6")
            ep.mkdir(exist_ok=True)
            registry = {}
            from search_tool.canonical import canonicalize_url_for_dedup
            key = canonicalize_url_for_dedup("https://example.com/")
            kept_final = "https://example.com/"
            registry[key] = EvidenceWriteResult(
                original_url="https://example.com/", normalized_url="https://example.com/",
                evidence_path=ep / "kept.md", fetch_status="success", http_status=200,
                cache_status="miss", extraction_status="success", text_chars=100,
                truncated=False, errors=(), limitations=(), final_url=kept_final,
            )
            r = fetch_url_to_evidence(
                "https://example.com/old", refresh=True, follow_redirects=True,
                evidence_dir=ep, cache_dir=Path("/tmp/m7-cache6"),
                _final_url_dedup_registry=registry,
            )
        assert r.duplicate_of_url == kept_final

    def test_skipped_no_evidence_file_written(self):
        """No duplicate evidence file written."""
        with patch("search_tool.run.fetch_url") as mock_fetch, \
             patch("search_tool.run.cache_get") as mock_cache, \
             patch("search_tool.run.cache_put"), \
             patch("search_tool.url_policy.socket.getaddrinfo"):
            mock_cache.return_value = MagicMock(status="miss")
            mock_fetch.return_value = MagicMock(
                status="success", http_status=301, content_type="text/html",
                body_bytes=b"<html><body>redirect</body></html>",
                body_sha256="fake",
                redirects=[{"status": 301, "location": "https://example.com/", "resolved_url": "https://example.com/"}],
                errors=[],
            )
            ep = Path("/tmp/m7-test-evidence7")
            ep.mkdir(exist_ok=True)
            kept_path = ep / "kept.md"
            registry = {}
            from search_tool.canonical import canonicalize_url_for_dedup
            key = canonicalize_url_for_dedup("https://example.com/")
            registry[key] = EvidenceWriteResult(
                original_url="https://example.com/", normalized_url="https://example.com/",
                evidence_path=kept_path, fetch_status="success", http_status=200,
                cache_status="miss", extraction_status="success", text_chars=100,
                truncated=False, errors=(), limitations=(), final_url="https://example.com/",
            )
            r = fetch_url_to_evidence(
                "https://example.com/old", refresh=True, follow_redirects=True,
                evidence_dir=ep, cache_dir=Path("/tmp/m7-cache7"),
                _final_url_dedup_registry=registry,
            )
        # The evidence_path points to the kept pack, not a new one
        assert r.evidence_path == kept_path
        assert not r.evidence_path.exists() or r.evidence_path == kept_path

    def test_first_occurrence_remains_success(self):
        """First occurrence with unique final_url is fetch_status='success'."""
        import tempfile
        from pathlib import Path

        with tempfile.TemporaryDirectory() as tmp:
            ep = Path(tmp) / "evidence"
            ep.mkdir()
            with patch("search_tool.run.fetch_url") as mock_fetch, \
                 patch("search_tool.run.cache_get") as mock_cache, \
                 patch("search_tool.url_policy.socket.getaddrinfo"):
                mock_cache.return_value = MagicMock(status="miss")
                mock_fetch.return_value = MagicMock(
                    status="success", http_status=200, content_type="text/html",
                    body_bytes=b"<html><body>hello</body></html>",
                    body_sha256="fake", redirects=[], errors=[],
                )
                registry = {}
                r = fetch_url_to_evidence(
                    "https://unique.com/", refresh=True, follow_redirects=True,
                    evidence_dir=ep, cache_dir=Path(tmp) / "cache",
                    _final_url_dedup_registry=registry,
                )
            assert r.fetch_status == "success"
            assert r.dedup_status == "unique"

    def test_multiple_duplicates_skip_all(self):
        """Three results: first kept, two skipped."""
        with patch("search_tool.run.fetch_url") as mock_fetch, \
             patch("search_tool.run.cache_get") as mock_cache, \
             patch("search_tool.run.cache_put"), \
             patch("search_tool.url_policy.socket.getaddrinfo"):
            mock_cache.return_value = MagicMock(status="miss")

            def fetch_side(url, follow_redirects=False):
                if "first" in url:
                    return MagicMock(
                        status="success", http_status=200, content_type="text/html",
                        body_bytes=b"<html><body>hello</body></html>",
                        body_sha256="fake", redirects=[], errors=[],
                    )
                return MagicMock(
                    status="success", http_status=301, content_type="text/html",
                    body_bytes=b"<html><body>redirect</body></html>",
                    body_sha256="fake",
                    redirects=[{"status": 301, "location": "https://example.com/", "resolved_url": "https://example.com/"}],
                    errors=[],
                )

            mock_fetch.side_effect = fetch_side

            ep = Path("/tmp/m7-test-evidence8")
            ep.mkdir(exist_ok=True)
            registry = {}
            # First call registers final_url
            r0 = fetch_url_to_evidence(
                "https://example.com/", refresh=True, follow_redirects=True,
                evidence_dir=ep, cache_dir=Path("/tmp/m7-cache8"),
                _final_url_dedup_registry=registry,
            )
            # Second call: duplicate
            r1 = fetch_url_to_evidence(
                "https://example.com/old", refresh=True, follow_redirects=True,
                evidence_dir=ep, cache_dir=Path("/tmp/m7-cache8"),
                _final_url_dedup_registry=registry,
            )
            # Third call: duplicate
            r2 = fetch_url_to_evidence(
                "https://example.com/latest", refresh=True, follow_redirects=True,
                evidence_dir=ep, cache_dir=Path("/tmp/m7-cache8"),
                _final_url_dedup_registry=registry,
            )
            assert r0.fetch_status == "success"
            assert r1.fetch_status == "skipped_duplicate"
            assert r2.fetch_status == "skipped_duplicate"
            assert r1.evidence_path == r0.evidence_path
            assert r2.evidence_path == r0.evidence_path

    def test_no_redirects_no_skip(self):
        """No redirects / final_url=None → no skip."""
        with patch("search_tool.run.fetch_url") as mock_fetch, \
             patch("search_tool.run.cache_get") as mock_cache, \
             patch("search_tool.url_policy.socket.getaddrinfo"):
            mock_cache.return_value = MagicMock(status="miss")
            mock_fetch.return_value = MagicMock(
                status="success", http_status=200, content_type="text/html",
                body_bytes=b"<html><body>hello</body></html>",
                body_sha256="fake", redirects=[], errors=[],
            )
            ep = Path("/tmp/m7-test-evidence9")
            ep.mkdir(exist_ok=True)
            registry = {}
            # Without follow_redirects, dedup is skipped
            r = fetch_url_to_evidence(
                "https://example.com/", refresh=True, follow_redirects=False,
                evidence_dir=ep, cache_dir=Path("/tmp/m7-cache9"),
                _final_url_dedup_registry=registry,
            )
        assert r.fetch_status == "success"

    def test_skipped_limitation_message(self):
        """Limitation says 'Skipped' not 'Detected'."""
        with patch("search_tool.run.fetch_url") as mock_fetch, \
             patch("search_tool.run.cache_get") as mock_cache, \
             patch("search_tool.run.cache_put"), \
             patch("search_tool.url_policy.socket.getaddrinfo"):
            mock_cache.return_value = MagicMock(status="miss")
            mock_fetch.return_value = MagicMock(
                status="success", http_status=301, content_type="text/html",
                body_bytes=b"<html><body>redirect</body></html>",
                body_sha256="fake",
                redirects=[{"status": 301, "location": "https://example.com/", "resolved_url": "https://example.com/"}],
                errors=[],
            )
            ep = Path("/tmp/m7-test-evidence10")
            ep.mkdir(exist_ok=True)
            registry = {}
            from search_tool.canonical import canonicalize_url_for_dedup
            key = canonicalize_url_for_dedup("https://example.com/")
            registry[key] = EvidenceWriteResult(
                original_url="https://example.com/", normalized_url="https://example.com/",
                evidence_path=ep / "kept.md", fetch_status="success", http_status=200,
                cache_status="miss", extraction_status="success", text_chars=100,
                truncated=False, errors=(), limitations=(), final_url="https://example.com/",
            )
            r = fetch_url_to_evidence(
                "https://example.com/old", refresh=True, follow_redirects=True,
                evidence_dir=ep, cache_dir=Path("/tmp/m7-cache10"),
                _final_url_dedup_registry=registry,
            )
        # The result is skipped
        assert r.fetch_status == "skipped_duplicate"
        # Limitation is populated at search_query level, not fetch_url_to_evidence level
        # This is verified via the integration test below.

    def test_backward_compat_no_registry(self):
        """fetch_url_to_evidence() works without registry parameter."""
        with patch("search_tool.run.fetch_url") as mock_fetch, \
             patch("search_tool.run.cache_get") as mock_cache, \
             patch("search_tool.url_policy.socket.getaddrinfo"):
            mock_cache.return_value = MagicMock(status="miss")
            mock_fetch.return_value = MagicMock(
                status="success", http_status=200, content_type="text/html",
                body_bytes=b"<html><body>hello</body></html>",
                body_sha256="fake", redirects=[], errors=[],
            )
            ep = Path("/tmp/m7-test-evidence11")
            ep.mkdir(exist_ok=True)
            # Call without _final_url_dedup_registry
            r = fetch_url_to_evidence(
                "https://example.com/", refresh=True,
                evidence_dir=ep,
            )
        assert r.fetch_status == "success"

    def test_limitation_say_skipped_not_detected(self):
        """search_query limitations say 'Skipped' when duplicates are actually skipped."""
        with patch("search_tool.run.fetch_url") as mock_fetch, \
             patch("search_tool.run.cache_get") as mock_cache, \
             patch("search_tool.run.cache_put"), \
             patch("search_tool.url_policy.socket.getaddrinfo"):
            mock_cache.return_value = MagicMock(status="miss")

            def fetch_side(url, follow_redirects=False):
                if "first" in url or "unique" in url:
                    return MagicMock(
                        status="success", http_status=200, content_type="text/html",
                        body_bytes=b"<html><body>hello</body></html>",
                        body_sha256="fake", redirects=[], errors=[],
                    )
                return MagicMock(
                    status="success", http_status=301, content_type="text/html",
                    body_bytes=b"<html><body>redirect</body></html>",
                    body_sha256="fake",
                    redirects=[{"status": 301, "location": "https://example.com/", "resolved_url": "https://example.com/"}],
                    errors=[],
                )

            mock_fetch.side_effect = fetch_side

            from search_tool.discovery import DiscoveryCandidate
            mock = MagicMock()
            mock.discover.return_value = DiscoveryResult(
                schema_version="0.1", query_original="test", query_normalized="test",
                query_redacted="test", provider_name="static",
                candidates=(
                    DiscoveryCandidate(rank=1, url="https://example.com/", normalized_url="https://example.com/",
                        title=None, snippet=None, source_engine=None,
                        url_policy="passed", blocked_reason=None, selected_for_fetch=True),
                    DiscoveryCandidate(rank=2, url="https://example.com/old", normalized_url="https://example.com/old",
                        title=None, snippet=None, source_engine=None,
                        url_policy="passed", blocked_reason=None, selected_for_fetch=True),
                    DiscoveryCandidate(rank=3, url="https://unique.com/", normalized_url="https://unique.com/",
                        title=None, snippet=None, source_engine=None,
                        url_policy="passed", blocked_reason=None, selected_for_fetch=True),
                ),
                errors=(),
                limitations=("Query redaction is best-effort.",),
            )

            ep = Path("/tmp/m7-test-evidence12")
            ep.mkdir(exist_ok=True)
            registry = {}
            fetcher = partial(fetch_url_to_evidence, evidence_dir=ep, cache_dir=Path("/tmp/m7-cache12"),
                              _final_url_dedup_registry=registry)
            result = search_query(
                provider=mock, query="test",
                fetcher=fetcher, follow_redirects=True,
            )

            # Skipped results present
            skipped = sum(1 for r in result.evidence_results if r.fetch_status == "skipped_duplicate")
            assert skipped == 1

            # Limitation says "Skipped"
            assert any("Skipped 1 duplicate" in lim for lim in result.limitations)
            assert not any("Detected" in lim for lim in result.limitations)
