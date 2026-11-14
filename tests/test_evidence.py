"""Tests for evidence pack generation."""

from search_tool.evidence import (
    build_evidence_pack,
    write_evidence_pack,
    SAFETY_NOTICE,
    _url_to_filename,
)
from search_tool.extract import ExtractionResult
from search_tool.fetch import FetchResult
from search_tool.url_policy import URLPolicyResult


def _make_passed_policy() -> URLPolicyResult:
    return URLPolicyResult(passed=True)


def _make_fetch(**overrides) -> FetchResult:
    defaults = dict(
        status="success",
        http_status=200,
        content_type="text/html",
        content_length_bytes=42,
        body_bytes=b"<html><body>Hello</body></html>",
        body_sha256="abc123",
        redirects=[],
        errors=[],
        limitations=[],
    )
    defaults.update(overrides)
    return FetchResult(**defaults)


def _make_extraction(**overrides) -> ExtractionResult:
    defaults = dict(
        status="success",
        method="beautifulsoup4-html-text",
        title="Test Page",
        text="Hello world",
        text_chars=11,
        truncated=False,
    )
    defaults.update(overrides)
    return ExtractionResult(**defaults)


def _build_pack(**overrides) -> str:
    defaults = dict(
        original_url="https://example.com",
        normalized_url="https://example.com/",
        url_policy=_make_passed_policy(),
        fetch=_make_fetch(),
        extraction=_make_extraction(),
        cache_status="miss",
        cache_key="key123",
        cache_body_ref="ref123",
        refresh=False,
    )
    defaults.update(overrides)
    return build_evidence_pack(**defaults)


class TestEvidenceFrontmatter:
    def test_schema_version(self):
        pack = _build_pack()
        assert 'schema_version: "0.1"' in pack

    def test_tool_name(self):
        pack = _build_pack()
        assert 'name: "krn-search-lab"' in pack

    def test_tool_version(self):
        pack = _build_pack()
        assert 'version: "0.1.0"' in pack

    def test_config_hash_present(self):
        pack = _build_pack()
        assert "config_hash:" in pack
        assert "sha256:" in pack

    def test_generated_at_utc(self):
        pack = _build_pack()
        assert "generated_at_utc:" in pack

    def test_command_name(self):
        pack = _build_pack()
        assert 'name: "fetch-url"' in pack

    def test_source_urls(self):
        pack = _build_pack()
        assert 'original_url: "https://example.com"' in pack
        assert 'normalized_url: "https://example.com/"' in pack

    def test_source_title(self):
        pack = _build_pack()
        assert 'title: "Test Page"' in pack

    def test_fetch_fields(self):
        pack = _build_pack()
        assert 'status: "success"' in pack
        assert "http_status: 200" in pack
        assert 'content_type: "text/html"' in pack
        assert 'body_sha256: "abc123"' in pack

    def test_cache_fields(self):
        pack = _build_pack()
        assert 'status: "miss"' in pack
        assert 'key: "key123"' in pack
        assert 'body_cache_ref: "ref123"' in pack

    def test_extraction_fields(self):
        pack = _build_pack()
        assert 'method: "beautifulsoup4-html-text"' in pack
        assert "text_chars: 11" in pack
        assert "truncated: false" in pack

    def test_security_passed(self):
        pack = _build_pack()
        assert 'url_policy: "passed"' in pack
        assert "blocked_reason: null" in pack

    def test_errors_and_limitations_present(self):
        pack = _build_pack()
        assert "errors:" in pack
        assert "limitations:" in pack

    def test_safety_notice_present(self):
        pack = _build_pack()
        assert SAFETY_NOTICE in pack


class TestFinalUrlSemantics:
    def test_2xx_success_has_final_url(self):
        pack = _build_pack(fetch=_make_fetch())
        assert 'final_url: "https://example.com/"' in pack

    def test_redirect_has_null_final_url(self):
        fetch = _make_fetch(
            http_status=301,
            redirects=[{"status": 301, "location": "https://other.com"}],
            limitations=["Redirect not followed (MVP-0 policy). Target URL not fetched."],
        )
        pack = _build_pack(fetch=fetch)
        assert "final_url: null" in pack

    def test_blocked_has_null_final_url(self):
        policy = URLPolicyResult(passed=False, blocked_reason="scheme not allowed: 'file'")
        pack = _build_pack(
            url_policy=policy,
            fetch=_make_fetch(status="blocked"),
            extraction=_make_extraction(status="skipped", method="none", text="", text_chars=0),
            cache_status="not_written",
            cache_key=None,
            cache_body_ref=None,
        )
        assert "final_url: null" in pack

    def test_failed_fetch_has_null_final_url(self):
        fetch = _make_fetch(
            status="failed",
            http_status=404,
            errors=["HTTP 404 response"],
            body_bytes=b"Not Found",
        )
        pack = _build_pack(fetch=fetch)
        assert "final_url: null" in pack

    def test_followed_redirect_uses_override(self):
        """When final_url_override is provided, it should be used as final_url."""
        fetch = _make_fetch(
            http_status=200,
            redirects=[{"status": 301, "location": "https://other.com", "resolved_url": "https://other.com/", "from_url": "https://example.com/", "blocked_reason": None}],
        )
        pack = _build_pack(
            fetch=fetch,
            final_url_override="https://other.com/",
        )
        assert 'final_url: "https://other.com/"' in pack

    def test_blocked_redirect_has_null_final_url(self):
        """Blocked redirect target should produce null final_url."""
        fetch = _make_fetch(
            status="blocked",
            redirects=[{"status": 301, "location": "file:///etc/passwd", "from_url": "https://example.com/", "resolved_url": "file:///etc/passwd", "blocked_reason": "scheme not allowed: 'file'"}],
        )
        pack = _build_pack(
            fetch=fetch,
            final_url_override=None,
        )
        assert "final_url: null" in pack


class TestFailureEvidence:
    def test_blocked_url_pack(self):
        policy = URLPolicyResult(
            passed=False,
            blocked_reason="scheme not allowed: 'file'",
            private_ip_blocked=False,
        )
        pack = _build_pack(
            original_url="file:///etc/passwd",
            normalized_url="file:///etc/passwd",
            url_policy=policy,
            fetch=_make_fetch(status="blocked"),
            extraction=_make_extraction(status="skipped", method="none", text="", text_chars=0),
            cache_status="not_written",
            cache_key=None,
            cache_body_ref=None,
        )
        assert 'url_policy: "blocked"' in pack
        assert "file" in pack
        assert "## Errors" in pack

    def test_failed_fetch_pack(self):
        fetch = _make_fetch(
            status="failed",
            errors=["Connection refused"],
            limitations=[],
        )
        pack = _build_pack(
            fetch=fetch,
            extraction=_make_extraction(status="skipped", method="none", text="", text_chars=0),
            cache_status="not_written",
            cache_key=None,
            cache_body_ref=None,
        )
        assert "Connection refused" in pack
        assert "## Errors" in pack


class TestFencedContent:
    def test_extracted_content_is_fenced(self):
        pack = _build_pack()
        assert "## Extracted source content" in pack
        assert "Hello world" in pack


class TestEvidencePathSafety:
    def test_url_path_does_not_become_filesystem_path(self):
        """Evidence filename must not be derived from URL path."""
        filename = _url_to_filename("https://evil.com/../../../../etc/passwd")
        assert "../" not in filename
        assert "passwd" not in filename
        assert "evil" in filename

    def test_filename_is_hash_based(self):
        filename = _url_to_filename("https://example.com/path/to/page")
        # Should contain a hash portion, not the full URL path
        assert "/path/to/page" not in filename
        assert "-" in filename  # prefix-hash format

    def test_different_urls_different_filenames(self):
        f1 = _url_to_filename("https://example.com/page1")
        f2 = _url_to_filename("https://example.com/page2")
        assert f1 != f2

    def test_write_evidence_pack_uses_hash_filename(self, tmp_path):
        import search_tool.evidence as ev_mod
        orig_dir = ev_mod.EVIDENCE_DIR
        ev_mod.EVIDENCE_DIR = tmp_path / "evidence"
        try:
            content = "# Test\nSome content"
            path = write_evidence_pack(content, "https://example.com/docs?page=1")
            assert path.parent == tmp_path / "evidence"
            assert path.suffix == ".md"
            # Filename should not contain "/docs"
            assert "/docs" not in path.stem
        finally:
            ev_mod.EVIDENCE_DIR = orig_dir
