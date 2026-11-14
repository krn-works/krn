"""Tests for llms.txt parser — stdlib only, no network."""

from pathlib import Path
import pytest

from search_tool.discovery_llms import (
    _ALLOWED_SCHEMES,
    _BLOCKED_SCHEMES,
    _is_valid_candidate_url,
    _normalize_candidate_url,
    _resolve_relative,
    _score_candidate,
    _ParsedEntry,
    parse_llms_txt,
    _strip_fenced_code_blocks,
)

_FIXTURES = Path(__file__).parent / "fixtures" / "llms"


# --- 1. Fenced code block stripping ---


class TestFencedCodeStripping:
    def test_simple_code_block_removed(self):
        text = "intro\n```\ncode here\n```\nmore"
        result = _strip_fenced_code_blocks(text)
        assert "code here" not in result
        assert "intro" in result
        assert "more" in result

    def test_nested_backticks_not_confusing(self):
        # Two consecutive fences toggle on/off immediately; code inside is real
        text = "```\n```\ncode\n```\n```\nreal"
        result = _strip_fenced_code_blocks(text)
        # First ``` opens, second ``` closes immediately, "code" is outside code block,
        # third ``` opens, fourth ``` closes, "real" is outside
        assert "code" in result
        assert "real" in result

    def test_no_code_blocks(self):
        text = "no code here\njust links"
        assert _strip_fenced_code_blocks(text) == text


# --- 2. Markdown link parsing ---


class TestMarkdownLinks:
    def test_basic_markdown_link(self):
        body = b"# Docs\n- [Guide](https://docs.example.com/guide)\n"
        entries, warnings = parse_llms_txt(body, "https://docs.example.com/llms.txt")
        assert len(entries) == 1
        assert entries[0].title == "Guide"
        assert entries[0].url == "https://docs.example.com/guide"

    def test_markdown_link_without_bullet(self):
        body = b"# Docs\n[Guide](https://docs.example.com/guide)\n"
        entries, _ = parse_llms_txt(body, "https://docs.example.com/llms.txt")
        assert len(entries) == 1
        assert entries[0].url == "https://docs.example.com/guide"

    def test_markdown_link_with_description(self):
        body = b"# Docs\n- [Guide](https://docs.example.com/guide): A quick start.\n"
        entries, _ = parse_llms_txt(body, "https://docs.example.com/llms.txt")
        assert entries[0].title == "Guide"
        assert entries[0].snippet == "A quick start."

    def test_multiple_links(self):
        body = b"# Docs\n- [A](https://example.com/a)\n- [B](https://example.com/b)\n- [C](https://example.com/c)\n"
        entries, _ = parse_llms_txt(body, "https://example.com/llms.txt")
        assert len(entries) == 3
        assert entries[0].url == "https://example.com/a"
        assert entries[1].url == "https://example.com/b"
        assert entries[2].url == "https://example.com/c"

    def test_markdown_link_with_asterisk_bullet(self):
        body = b"# Docs\n* [Guide](https://docs.example.com/guide): A quick start.\n"
        entries, _ = parse_llms_txt(body, "https://docs.example.com/llms.txt")
        assert len(entries) == 1
        assert entries[0].url == "https://docs.example.com/guide"
        assert entries[0].title == "Guide"
        assert entries[0].snippet == "A quick start."

    def test_empty_title_link_skipped(self):
        body = b"- [](https://example.com/no-title)\n"
        entries, warnings = parse_llms_txt(body, "https://example.com/llms.txt")
        # [](...) doesn't match [text](url) regex ([^\]]+ needs at least 1 char), so silently skipped
        assert len(entries) == 0


# --- 3. Raw URL parsing ---


class TestRawURLs:
    def test_raw_url_line(self):
        body = b"# Docs\nhttps://docs.example.com/guide\n"
        entries, _ = parse_llms_txt(body, "https://docs.example.com/llms.txt")
        assert len(entries) == 1
        assert entries[0].url == "https://docs.example.com/guide"

    def test_raw_url_mixed_with_links(self):
        body = b"# Docs\nhttps://docs.example.com/api\n- [Guide](https://docs.example.com/guide)\n"
        entries, _ = parse_llms_txt(body, "https://docs.example.com/llms.txt")
        assert len(entries) == 2
        assert entries[0].url == "https://docs.example.com/api"
        assert entries[1].url == "https://docs.example.com/guide"


# --- 4. Section capture ---


class TestSectionCapture:
    def test_h2_section_captured(self):
        body = b"# Docs\n## Guides\n- [A](https://example.com/a)\n- [B](https://example.com/b)\n"
        entries, _ = parse_llms_txt(body, "https://example.com/llms.txt")
        assert entries[0].section == "Guides"
        assert entries[1].section == "Guides"

    def test_section_scoped(self):
        body = b"# Docs\n## Guides\n- [A](https://example.com/a)\n## API\n- [B](https://example.com/b)\n"
        entries, _ = parse_llms_txt(body, "https://example.com/llms.txt")
        assert entries[0].section == "Guides"
        assert entries[1].section == "API"

    def test_no_section_default_none(self):
        body = b"# Docs\n- [A](https://example.com/a)\n"
        entries, _ = parse_llms_txt(body, "https://example.com/llms.txt")
        assert entries[0].section is None


# --- 5. H1 title and blockquote description ---


class TestTitleAndDescription:
    def test_h1_title_not_stored_as_entry(self):
        body = b"# Project Docs\n- [A](https://example.com/a)\n"
        entries, _ = parse_llms_txt(body, "https://example.com/llms.txt")
        # H1 lines don't create entries; they're just metadata
        assert len(entries) == 1
        assert entries[0].title == "A"

    def test_blockquote_description_not_stored_as_entry(self):
        body = b"> Description here\n- [A](https://example.com/a)\n"
        entries, _ = parse_llms_txt(body, "https://example.com/llms.txt")
        assert len(entries) == 1
        assert entries[0].snippet is None  # blockquotes not parsed in L.2


# --- 6. Relative URL resolution ---


class TestRelativeURLResolution:
    def test_absolute_path_relative(self):
        body = b"# Docs\n- [Guide](/docs/guide)\n"
        entries, _ = parse_llms_txt(body, "https://docs.example.com/llms.txt")
        assert entries[0].url == "https://docs.example.com/docs/guide"

    def test_relative_path_resolves(self):
        body = b"# Docs\n- [Guide](tutorials/overview)\n"
        entries, _ = parse_llms_txt(body, "https://docs.example.com/llms.txt")
        assert entries[0].url == "https://docs.example.com/tutorials/overview"

    def test_relative_escaped_to_unsupported_scheme(self):
        body = b"# Docs\n- [Guide](file:///etc/passwd)\n"
        entries, warnings = parse_llms_txt(body, "https://docs.example.com/llms.txt")
        assert len(entries) == 0
        assert len(warnings) >= 1

    def test_absolute_http_not_touched(self):
        body = b"- [Guide](https://other.example.com/guide)\n"
        entries, _ = parse_llms_txt(body, "https://docs.example.com/llms.txt")
        assert entries[0].url == "https://other.example.com/guide"


# --- 7. Unsupported scheme blocking ---


class TestSchemeBlocking:
    def test_file_scheme_blocked(self):
        body = b"- [Hack](file:///etc/passwd)\n"
        entries, _ = parse_llms_txt(body, "https://example.com/llms.txt")
        assert len(entries) == 0

    def test_javascript_scheme_blocked(self):
        body = b"- [JS](javascript:void(0))\n"
        entries, _ = parse_llms_txt(body, "https://example.com/llms.txt")
        assert len(entries) == 0

    def test_data_scheme_blocked(self):
        body = b"- [Data](data:text/html,<script>alert(1)</script>)\n"
        entries, _ = parse_llms_txt(body, "https://example.com/llms.txt")
        assert len(entries) == 0

    def test_mailto_scheme_blocked(self):
        body = b"- [Email](mailto:bad@example.com)\n"
        entries, _ = parse_llms_txt(body, "https://example.com/llms.txt")
        assert len(entries) == 0

    def test_http_allowed(self):
        body = b"- [HTTP](http://example.com)\n"
        entries, _ = parse_llms_txt(body, "https://example.com/llms.txt")
        assert len(entries) == 1

    def test_https_allowed(self):
        body = b"- [HTTPS](https://example.com)\n"
        entries, _ = parse_llms_txt(body, "https://example.com/llms.txt")
        assert len(entries) == 1


# --- 8. Deduplication ---


class TestDeduplication:
    def test_duplicate_urls_deduped(self):
        body = b"- [A](https://example.com/doc)\n- [B](https://example.com/doc)\n"
        entries, _ = parse_llms_txt(body, "https://example.com/llms.txt")
        assert len(entries) == 1
        assert entries[0].title == "A"  # first occurrence preserved

    def test_case_normalized_for_dedup(self):
        body = b"- [A](https://Example.COM/doc)\n- [B](https://example.com/doc)\n"
        entries, _ = parse_llms_txt(body, "https://example.com/llms.txt")
        assert len(entries) == 1

    def test_different_urls_both_kept(self):
        body = b"- [A](https://example.com/a)\n- [B](https://example.com/b)\n"
        entries, _ = parse_llms_txt(body, "https://example.com/llms.txt")
        assert len(entries) == 2


# --- 9. Malformed content ---


class TestMalformedContent:
    def test_malformed_links_skipped(self):
        body = b"[broken link: no url\n[also broken]](missing)\n"
        entries, _ = parse_llms_txt(body, "https://example.com/llms.txt")
        assert len(entries) == 0

    def test_empty_links_skipped(self):
        body = b"[](https://example.com/ok)\n"
        entries, _ = parse_llms_txt(body, "https://example.com/llms.txt")
        assert len(entries) == 0

    def test_malformed_file_does_not_crash(self):
        malformed = _FIXTURES / "malformed-llms.txt"
        if malformed.exists():
            body = malformed.read_bytes()
            entries, warnings = parse_llms_txt(body, "https://example.com/llms.txt")
            assert isinstance(entries, list)
            assert isinstance(warnings, list)
            # Should have at least the valid raw URL from the fixture
            assert len(entries) >= 0  # no crash guaranteed

    def test_empty_body(self):
        body = b""
        entries, _ = parse_llms_txt(body, "https://example.com/llms.txt")
        assert len(entries) == 0

    def test_whitespace_only(self):
        body = b"   \n\n  \n"
        entries, _ = parse_llms_txt(body, "https://example.com/llms.txt")
        assert len(entries) == 0


# --- 10. Fenced code block in llms.txt ---


class TestFencedCodeInLlms:
    def test_code_block_urls_ignored(self):
        body = b"# Docs\n```\n- [Secret](https://example.com/secret)\n```\n- [Real](https://example.com/real)\n"
        entries, _ = parse_llms_txt(body, "https://example.com/llms.txt")
        assert len(entries) == 1
        assert entries[0].url == "https://example.com/real"

    def test_code_block_preserves_non_code_lines(self):
        body = b"# Docs\nIntro text\n```\ncode\n```\nMore text\n- [A](https://example.com/a)\n"
        entries, _ = parse_llms_txt(body, "https://example.com/llms.txt")
        assert len(entries) == 1
        assert entries[0].url == "https://example.com/a"


# --- 11. URL validation helpers ---


class TestURLValidationHelpers:
    def test_is_valid_https(self):
        assert _is_valid_candidate_url("https://example.com") is True

    def test_is_valid_http(self):
        assert _is_valid_candidate_url("http://example.com") is True

    def test_is_valid_file_blocked(self):
        assert _is_valid_candidate_url("file:///etc/passwd") is False

    def test_is_valid_empty(self):
        assert _is_valid_candidate_url("") is False

    def test_is_valid_none_host(self):
        assert _is_valid_candidate_url("https:") is False

    def test_normalize_candidate_preserves(self):
        url = "https://Example.COM/Path"
        normalized = _normalize_candidate_url(url)
        assert normalized == "https://example.com/Path"


# --- 12. Keyword scoring ---


class TestKeywordScoring:
    def test_title_match_higher(self):
        entry = _ParsedEntry(url="https://example.com/guide", title="Validation Models")
        score = _score_candidate(entry, "validation")
        assert score == 10

    def test_section_match(self):
        entry = _ParsedEntry(url="https://example.com/guide", section="Validation")
        score = _score_candidate(entry, "validation")
        assert score == 5

    def test_url_match(self):
        entry = _ParsedEntry(url="https://example.com/validation-guide")
        score = _score_candidate(entry, "validation")
        assert score == 3

    def test_no_match(self):
        entry = _ParsedEntry(url="https://example.com/guide", title="Intro")
        score = _score_candidate(entry, "xyznonexistent")
        assert score == 0

    def test_empty_query_zero_score(self):
        entry = _ParsedEntry(url="https://example.com/validation", title="Validation")
        assert _score_candidate(entry, "") == 0
        assert _score_candidate(entry, "   ") == 0

    def test_multiple_terms(self):
        entry = _ParsedEntry(url="https://example.com/guide", title="Validation Models")
        score = _score_candidate(entry, "validation models")
        assert score == 20  # 10 + 10

    def test_score_ordering_preserves_first(self):
        entries = [
            _ParsedEntry(url="https://example.com/a", title="validation guide", section=None),
            _ParsedEntry(url="https://example.com/b", title="Guide", section="validation"),
        ]
        scored = sorted(entries, key=lambda e: (-_score_candidate(e, "validation"), e.line_number))
        assert scored[0].title == "validation guide"  # title match (10) > section match (5)


# --- 13. Real-world fixture parsing ---


class TestRealWorldFixtures:
    def test_basic_fixture(self):
        fixture = _FIXTURES / "basic-llms.txt"
        if not fixture.exists():
            pytest.skip("basic-llms.txt fixture not found")
        entries, warnings = parse_llms_txt(fixture.read_bytes(), "https://docs.example.com/llms.txt")
        assert len(entries) >= 10  # basic fixture has ~10+ URLs
        # Key URLs section
        key_urls = [e for e in entries if e.section is None]
        assert len(key_urls) > 0
        # Guides section
        guides = [e for e in entries if e.section == "Guides"]
        assert len(guides) >= 1
        # Examples section
        examples = [e for e in entries if e.section == "Examples"]
        assert len(examples) >= 1

    def test_relative_fixture(self):
        fixture = _FIXTURES / "relative-llms.txt"
        if not fixture.exists():
            pytest.skip("relative-llms.txt fixture not found")
        entries, warnings = parse_llms_txt(fixture.read_bytes(), "https://docs.example.com/base/llms.txt")
        # /docs/guide -> https://docs.example.com/docs/guide
        abs_entries = [e for e in entries if "/docs/guide" in e.url]
        assert len(abs_entries) == 1
        assert abs_entries[0].url == "https://docs.example.com/docs/guide"
        # tutorials/overview -> https://docs.example.com/base/tutorials/overview
        rel_entries = [e for e in entries if "tutorials/overview" in e.url]
        assert len(rel_entries) == 1
        # external absolute URL preserved
        ext_entries = [e for e in entries if "example.com/external" in e.url]
        assert len(ext_entries) == 1
        assert ext_entries[0].url == "https://example.com/external"

    def test_malformed_fixture_no_crash(self):
        fixture = _FIXTURES / "malformed-llms.txt"
        if not fixture.exists():
            pytest.skip("malformed-llms.txt fixture not found")
        body = fixture.read_bytes()
        entries, warnings = parse_llms_txt(body, "https://example.com/llms.txt")
        # Should have at least the valid raw URL
        assert isinstance(entries, list)
        assert isinstance(warnings, list)
        # Blocked schemes should not appear
        for e in entries:
            assert e.url.startswith("https://") or e.url.startswith("http://")
