"""Tests for content limits."""

from search_tool.extract import extract, MAX_EXTRACTED_CHARS
from search_tool.fetch import MAX_RESPONSE_BYTES


class TestExtractionLimits:
    def test_large_text_truncated(self):
        large = "x" * (MAX_EXTRACTED_CHARS + 1000)
        result = extract(large.encode(), "text/plain")
        assert result.status == "truncated"
        assert result.truncated is True
        assert result.text_chars <= MAX_EXTRACTED_CHARS

    def test_normal_text_not_truncated(self):
        text = "x" * 100
        result = extract(text.encode(), "text/plain")
        assert result.status == "success"
        assert not result.truncated


class TestResponseSizeLimit:
    def test_max_response_bytes_defined(self):
        assert MAX_RESPONSE_BYTES > 0
        assert isinstance(MAX_RESPONSE_BYTES, int)

    def test_max_extracted_chars_defined(self):
        assert MAX_EXTRACTED_CHARS > 0
        assert isinstance(MAX_EXTRACTED_CHARS, int)


class TestBinaryContentSkipped:
    def test_pdf_content_type_skipped(self):
        result = extract(b"%PDF-1.4 fake data", "application/pdf")
        assert result.status == "skipped"
        assert result.limitations
        assert any("Unsupported" in l for l in result.limitations)

    def test_image_content_type_skipped(self):
        result = extract(b"\x89PNG\r\n\x1a\n", "image/png")
        assert result.status == "skipped"

    def test_zip_content_type_skipped(self):
        result = extract(b"PK\x03\x04", "application/zip")
        assert result.status == "skipped"
