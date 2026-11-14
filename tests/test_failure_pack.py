"""Tests for failure evidence packs."""

from search_tool.evidence import build_evidence_pack, SAFETY_NOTICE
from search_tool.extract import ExtractionResult
from search_tool.fetch import FetchResult
from search_tool.url_policy import URLPolicyResult


def _skipped_extraction() -> ExtractionResult:
    return ExtractionResult(status="skipped", method="none", text="", text_chars=0)


class TestBlockedUrlFailure:
    def test_blocked_url_produces_pack(self):
        policy = URLPolicyResult(
            passed=False,
            blocked_reason="scheme not allowed: 'file'",
        )
        pack = build_evidence_pack(
            original_url="file:///etc/passwd",
            normalized_url="file:///etc/passwd",
            url_policy=policy,
            fetch=FetchResult(status="blocked"),
            extraction=_skipped_extraction(),
            cache_status="not_written",
            cache_key=None,
            cache_body_ref=None,
            refresh=False,
        )
        assert "file:///etc/passwd" in pack
        assert "blocked" in pack.lower()
        assert SAFETY_NOTICE in pack
        assert "## Errors" in pack
        assert "## Limitations" in pack
        assert "final_url: null" in pack

    def test_blocked_url_records_reason(self):
        policy = URLPolicyResult(
            passed=False,
            blocked_reason="credentials in URL",
            credentials_in_url=True,
        )
        pack = build_evidence_pack(
            original_url="https://user:pass@host.com",
            normalized_url="https://user:pass@host.com/",
            url_policy=policy,
            fetch=FetchResult(status="blocked"),
            extraction=_skipped_extraction(),
            cache_status="not_written",
            cache_key=None,
            cache_body_ref=None,
            refresh=False,
        )
        assert "credentials in URL" in pack


class TestFetchFailure:
    def test_connection_error_pack(self):
        fetch = FetchResult(
            status="failed",
            errors=["Connection refused"],
            limitations=["Server unreachable."],
        )
        pack = build_evidence_pack(
            original_url="https://down.example.com",
            normalized_url="https://down.example.com/",
            url_policy=URLPolicyResult(passed=True),
            fetch=fetch,
            extraction=_skipped_extraction(),
            cache_status="not_written",
            cache_key=None,
            cache_body_ref=None,
            refresh=False,
        )
        assert "Connection refused" in pack
        assert "## Errors" in pack
        assert "final_url: null" in pack

    def test_timeout_error_pack(self):
        fetch = FetchResult(
            status="failed",
            errors=["Request timed out after 30.0s"],
            limitations=["Fetch timed out."],
        )
        pack = build_evidence_pack(
            original_url="https://slow.example.com",
            normalized_url="https://slow.example.com/",
            url_policy=URLPolicyResult(passed=True),
            fetch=fetch,
            extraction=_skipped_extraction(),
            cache_status="not_written",
            cache_key=None,
            cache_body_ref=None,
            refresh=False,
        )
        assert "timed out" in pack.lower()

    def test_dns_error_pack(self):
        fetch = FetchResult(
            status="failed",
            errors=["DNS resolution failed"],
        )
        pack = build_evidence_pack(
            original_url="https://nonexistent.invalid",
            normalized_url="https://nonexistent.invalid/",
            url_policy=URLPolicyResult(passed=True),
            fetch=fetch,
            extraction=_skipped_extraction(),
            cache_status="not_written",
            cache_key=None,
            cache_body_ref=None,
            refresh=False,
        )
        assert "DNS" in pack

    def test_404_error_pack(self):
        fetch = FetchResult(
            status="failed",
            http_status=404,
            errors=["HTTP 404 response"],
            body_bytes=b"<html><body>Not Found</body></html>",
            content_type="text/html",
            content_length_bytes=37,
            body_sha256="abc",
            limitations=["Server returned HTTP 404. Content may be incomplete or absent."],
        )
        pack = build_evidence_pack(
            original_url="https://example.com/missing",
            normalized_url="https://example.com/missing",
            url_policy=URLPolicyResult(passed=True),
            fetch=fetch,
            extraction=ExtractionResult(
                status="success",
                method="beautifulsoup4-html-text",
                title="Not Found",
                text="Not Found",
                text_chars=9,
            ),
            cache_status="not_written",
            cache_key=None,
            cache_body_ref=None,
            refresh=False,
        )
        assert "404" in pack
        assert "Not Found" in pack
        assert "final_url: null" in pack

    def test_500_error_pack(self):
        fetch = FetchResult(
            status="failed",
            http_status=500,
            errors=["HTTP 500 response"],
            body_bytes=b"Internal Server Error",
            content_type="text/plain",
            content_length_bytes=21,
            body_sha256="def",
            limitations=["Server returned HTTP 500. Content may be incomplete or absent."],
        )
        pack = build_evidence_pack(
            original_url="https://example.com/error",
            normalized_url="https://example.com/error",
            url_policy=URLPolicyResult(passed=True),
            fetch=fetch,
            extraction=ExtractionResult(
                status="success",
                method="plain-text",
                text="Internal Server Error",
                text_chars=21,
            ),
            cache_status="not_written",
            cache_key=None,
            cache_body_ref=None,
            refresh=False,
        )
        assert "500" in pack


class TestPrivateIpBlocked:
    def test_private_ip_records_flag(self):
        policy = URLPolicyResult(
            passed=False,
            blocked_reason="resolved to private/reserved IP: 192.168.1.1",
            private_ip_blocked=True,
        )
        pack = build_evidence_pack(
            original_url="https://internal.corp",
            normalized_url="https://internal.corp/",
            url_policy=policy,
            fetch=FetchResult(status="blocked"),
            extraction=_skipped_extraction(),
            cache_status="not_written",
            cache_key=None,
            cache_body_ref=None,
            refresh=False,
        )
        assert "192.168.1.1" in pack
        assert "private" in pack.lower()
