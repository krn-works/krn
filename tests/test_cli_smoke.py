"""CLI smoke tests — mocked, no live internet."""

import json
from pathlib import Path
from unittest.mock import patch, MagicMock

import httpx
import pytest

from search_tool.cli import (
    main,
    fetch_url_to_evidence,
    _sanitize_provider_url_for_manifest,
    MAX_LIST_URLS,
)
from search_tool.run import (
    InputError,
    parse_urls_file as _parse_urls_file,
    write_fetch_list_manifest as _write_manifest,
)


class TestProviderUrlSanitization:
    def test_retains_host_and_port(self):
        assert _sanitize_provider_url_for_manifest("https://search.example.com") == "https://search.example.com"
        assert _sanitize_provider_url_for_manifest("http://localhost:8888") == "http://localhost:8888"

    def test_redacts_path_query_fragment(self):
        assert _sanitize_provider_url_for_manifest("https://search.example.com/path?q=1#frag") == "https://search.example.com"

    def test_redacts_credentials(self):
        assert _sanitize_provider_url_for_manifest("https://user:pass@search.example.com") == "https://search.example.com"
        assert _sanitize_provider_url_for_manifest("http://admin:secret@localhost:8888/search") == "http://localhost:8888"

    def test_handles_malformed(self):
        assert _sanitize_provider_url_for_manifest("not-a-url") == "[REDACTED]"
        assert _sanitize_provider_url_for_manifest("http:///missing-host") == "[REDACTED]"
from search_tool.search import EvidenceWriteResult, _quality_score, _md_table_safe


def _mock_http(status_code=200, headers=None, body=b""):
    """Build a mock httpx Client for CLI tests."""
    headers = headers or {"content-type": "text/html"}
    mock_client = MagicMock()
    mock_response = MagicMock()
    mock_response.status_code = status_code
    mock_response.headers = headers
    mock_response.iter_bytes.return_value = iter([body])
    mock_ctx = MagicMock()
    mock_ctx.__enter__ = MagicMock(return_value=mock_response)
    mock_ctx.__exit__ = MagicMock(return_value=False)
    mock_client.stream.return_value = mock_ctx
    mock_client.__enter__ = MagicMock(return_value=mock_client)
    mock_client.__exit__ = MagicMock(return_value=False)
    return mock_client


def _mock_dns(ip="93.184.216.34"):
    """Mock DNS resolution to a public IP."""
    return patch("search_tool.url_policy.socket.getaddrinfo",
                 return_value=[(2, 1, 6, "", (ip, 0))])


class TestCliSmoke:
    def test_command_runs_and_prints_path(self, tmp_path, monkeypatch):
        monkeypatch.chdir(tmp_path)
        monkeypatch.setattr("search_tool.evidence.EVIDENCE_DIR", tmp_path / "evidence")
        monkeypatch.setattr("search_tool.cache.CACHE_DIR", tmp_path / "cache")
        monkeypatch.setattr("search_tool.cache.OBJECTS_DIR", tmp_path / "cache" / "objects")
        monkeypatch.setattr("search_tool.cache.ENTRIES_DIR", tmp_path / "cache" / "entries")
        (tmp_path / "evidence").mkdir()
        (tmp_path / "cache" / "objects").mkdir(parents=True)
        (tmp_path / "cache" / "entries").mkdir(parents=True)

        body = b"<html><head><title>Test</title></head><body>Hello</body></html>"
        with _mock_dns(), patch("search_tool.fetch.httpx.Client", return_value=_mock_http(200, body=body)):
            exit_code = main(["fetch-url", "https://example.com"])

        assert exit_code == 0
        packs = list((tmp_path / "evidence").glob("*.md"))
        assert len(packs) == 1

    def test_blocked_url_exits_zero(self, tmp_path, monkeypatch):
        monkeypatch.chdir(tmp_path)
        monkeypatch.setattr("search_tool.evidence.EVIDENCE_DIR", tmp_path / "evidence")
        (tmp_path / "evidence").mkdir()

        exit_code = main(["fetch-url", "file:///etc/passwd"])
        assert exit_code == 0

        packs = list((tmp_path / "evidence").glob("*.md"))
        assert len(packs) == 1
        content = packs[0].read_text()
        assert "blocked" in content.lower()

    def test_no_command_shows_help(self):
        exit_code = main([])
        assert exit_code == 1

    def test_fetch_failure_exits_zero(self, tmp_path, monkeypatch):
        monkeypatch.chdir(tmp_path)
        monkeypatch.setattr("search_tool.evidence.EVIDENCE_DIR", tmp_path / "evidence")
        (tmp_path / "evidence").mkdir()

        with _mock_dns(), patch("search_tool.fetch.httpx.Client", side_effect=httpx.ConnectError("DNS failure")):
            exit_code = main(["fetch-url", "https://nonexistent.invalid"])

        assert exit_code == 0
        packs = list((tmp_path / "evidence").glob("*.md"))
        assert len(packs) == 1

    def test_404_exits_zero_with_failure_pack(self, tmp_path, monkeypatch):
        monkeypatch.chdir(tmp_path)
        monkeypatch.setattr("search_tool.evidence.EVIDENCE_DIR", tmp_path / "evidence")
        monkeypatch.setattr("search_tool.cache.CACHE_DIR", tmp_path / "cache")
        monkeypatch.setattr("search_tool.cache.OBJECTS_DIR", tmp_path / "cache" / "objects")
        monkeypatch.setattr("search_tool.cache.ENTRIES_DIR", tmp_path / "cache" / "entries")
        (tmp_path / "evidence").mkdir()
        (tmp_path / "cache" / "objects").mkdir(parents=True)
        (tmp_path / "cache" / "entries").mkdir(parents=True)

        with _mock_dns(), patch("search_tool.fetch.httpx.Client", return_value=_mock_http(404)):
            exit_code = main(["fetch-url", "https://example.com/missing"])

        assert exit_code == 0
        packs = list((tmp_path / "evidence").glob("*.md"))
        assert len(packs) == 1
        content = packs[0].read_text()
        assert "404" in content

    def test_version_flag(self):
        with pytest.raises(SystemExit) as exc_info:
            main(["--version"])
        assert exc_info.value.code == 0

    def test_refresh_flag_accepted(self, tmp_path, monkeypatch):
        monkeypatch.chdir(tmp_path)
        monkeypatch.setattr("search_tool.evidence.EVIDENCE_DIR", tmp_path / "evidence")
        monkeypatch.setattr("search_tool.cache.CACHE_DIR", tmp_path / "cache")
        monkeypatch.setattr("search_tool.cache.OBJECTS_DIR", tmp_path / "cache" / "objects")
        monkeypatch.setattr("search_tool.cache.ENTRIES_DIR", tmp_path / "cache" / "entries")
        (tmp_path / "evidence").mkdir()
        (tmp_path / "cache" / "objects").mkdir(parents=True)
        (tmp_path / "cache" / "entries").mkdir(parents=True)

        body = b"content"
        with _mock_dns(), patch("search_tool.fetch.httpx.Client", return_value=_mock_http(200, body=body)):
            exit_code = main(["fetch-url", "https://example.com", "--refresh"])

        assert exit_code == 0


def _setup_dirs(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    monkeypatch.setattr("search_tool.evidence.EVIDENCE_DIR", tmp_path / "evidence")
    monkeypatch.setattr("search_tool.cache.CACHE_DIR", tmp_path / "cache")
    monkeypatch.setattr("search_tool.cache.OBJECTS_DIR", tmp_path / "cache" / "objects")
    monkeypatch.setattr("search_tool.cache.ENTRIES_DIR", tmp_path / "cache" / "entries")
    (tmp_path / "evidence").mkdir()
    (tmp_path / "cache" / "objects").mkdir(parents=True)
    (tmp_path / "cache" / "entries").mkdir(parents=True)


class TestFetchUrlToEvidence:
    def test_returns_structured_result_on_success(self, tmp_path, monkeypatch):
        _setup_dirs(tmp_path, monkeypatch)
        body = b"<html><head><title>Test</title></head><body>Hello</body></html>"
        with _mock_dns(), patch("search_tool.fetch.httpx.Client", return_value=_mock_http(200, body=body)):
            result = fetch_url_to_evidence("https://example.com", False)

        assert isinstance(result, EvidenceWriteResult)
        assert result.fetch_status == "success"
        assert result.http_status == 200
        assert result.cache_status == "miss"
        assert result.extraction_status == "success"
        assert result.text_chars > 0
        assert result.evidence_path.exists()
        assert result.evidence_path.suffix == ".md"
        assert isinstance(result.errors, tuple)
        assert isinstance(result.limitations, tuple)

    def test_returns_structured_result_on_blocked_url(self, tmp_path, monkeypatch):
        _setup_dirs(tmp_path, monkeypatch)
        result = fetch_url_to_evidence("file:///etc/passwd", False)

        assert isinstance(result, EvidenceWriteResult)
        assert result.fetch_status == "blocked"
        assert result.http_status is None
        assert result.cache_status == "not_written"
        assert result.extraction_status == "skipped"
        assert result.evidence_path.exists()
        assert len(result.errors) > 0

    def test_returns_structured_result_on_fetch_failure(self, tmp_path, monkeypatch):
        _setup_dirs(tmp_path, monkeypatch)
        with _mock_dns(), patch("search_tool.fetch.httpx.Client", side_effect=httpx.ConnectError("refused")):
            result = fetch_url_to_evidence("https://fail.invalid", False)

        assert isinstance(result, EvidenceWriteResult)
        assert result.fetch_status == "failed"
        assert result.cache_status == "not_written"
        assert result.evidence_path.exists()
        assert len(result.errors) > 0

    def test_returns_structured_result_on_404(self, tmp_path, monkeypatch):
        _setup_dirs(tmp_path, monkeypatch)
        with _mock_dns(), patch("search_tool.fetch.httpx.Client", return_value=_mock_http(404)):
            result = fetch_url_to_evidence("https://example.com/missing", False)

        assert isinstance(result, EvidenceWriteResult)
        assert result.fetch_status == "failed"
        assert result.http_status == 404
        assert result.evidence_path.exists()

    def test_result_is_frozen(self, tmp_path, monkeypatch):
        _setup_dirs(tmp_path, monkeypatch)
        body = b"<html><body>ok</body></html>"
        with _mock_dns(), patch("search_tool.fetch.httpx.Client", return_value=_mock_http(200, body=body)):
            result = fetch_url_to_evidence("https://example.com", False)

        import dataclasses
        assert dataclasses.is_dataclass(result)
        # frozen=True means __setattr__ raises FrozenInstanceError
        assert getattr(result, "__dataclass_params__").frozen is True


# --- fetch-list tests ---


class TestParseUrlsFile:
    def test_valid_urls(self, tmp_path):
        f = tmp_path / "urls.txt"
        f.write_text("https://a.com\nhttps://b.com\n", encoding="utf-8")
        urls = _parse_urls_file(f)
        assert urls == ["https://a.com", "https://b.com"]

    def test_skip_blank_lines(self, tmp_path):
        f = tmp_path / "urls.txt"
        f.write_text("https://a.com\n\n\nhttps://b.com\n", encoding="utf-8")
        urls = _parse_urls_file(f)
        assert urls == ["https://a.com", "https://b.com"]

    def test_skip_full_line_comments(self, tmp_path):
        f = tmp_path / "urls.txt"
        f.write_text("# header\nhttps://a.com\n# another\nhttps://b.com\n", encoding="utf-8")
        urls = _parse_urls_file(f)
        assert urls == ["https://a.com", "https://b.com"]

    def test_preserve_duplicates(self, tmp_path):
        f = tmp_path / "urls.txt"
        f.write_text("https://a.com\nhttps://a.com\n", encoding="utf-8")
        urls = _parse_urls_file(f)
        assert urls == ["https://a.com", "https://a.com"]

    def test_missing_file_raises(self, tmp_path):
        with pytest.raises(InputError):
            _parse_urls_file(tmp_path / "nonexistent.txt")

    def test_non_utf8_raises(self, tmp_path):
        f = tmp_path / "urls.txt"
        f.write_bytes(b"\xff\xfe invalid")
        with pytest.raises(InputError):
            _parse_urls_file(f)


class TestQualityScore:
    def test_blocked_is_zero(self):
        r = EvidenceWriteResult(
            original_url="x", normalized_url="x", evidence_path=Path("/x"),
            fetch_status="blocked", http_status=None, cache_status="not_written",
            extraction_status="skipped", text_chars=0, truncated=False,
            errors=(), limitations=(),
        )
        assert _quality_score(r) == 0

    def test_failed_fetch_is_zero(self):
        r = EvidenceWriteResult(
            original_url="x", normalized_url="x", evidence_path=Path("/x"),
            fetch_status="failed", http_status=500, cache_status="not_written",
            extraction_status="skipped", text_chars=0, truncated=False,
            errors=(), limitations=(),
        )
        assert _quality_score(r) == 0

    def test_success_truncated_is_two(self):
        r = EvidenceWriteResult(
            original_url="x", normalized_url="x", evidence_path=Path("/x"),
            fetch_status="success", http_status=200, cache_status="miss",
            extraction_status="truncated", text_chars=100, truncated=True,
            errors=(), limitations=(),
        )
        assert _quality_score(r) == 2

    def test_success_full_is_three(self):
        r = EvidenceWriteResult(
            original_url="x", normalized_url="x", evidence_path=Path("/x"),
            fetch_status="success", http_status=200, cache_status="miss",
            extraction_status="success", text_chars=100, truncated=False,
            errors=(), limitations=(),
        )
        assert _quality_score(r) == 3


class TestFetchListCli:
    def test_fetch_list_runs(self, tmp_path, monkeypatch):
        _setup_dirs(tmp_path, monkeypatch)
        urls_file = tmp_path / "urls.txt"
        urls_file.write_text("https://example.com\n", encoding="utf-8")

        body = b"<html><head><title>T</title></head><body>Hi</body></html>"
        with _mock_dns(), patch("search_tool.fetch.httpx.Client", return_value=_mock_http(200, body=body)):
            exit_code = main(["fetch-list", str(urls_file)])

        assert exit_code == 0
        manifests = list((tmp_path / "evidence").glob("manifest-*.md"))
        assert len(manifests) == 1

    def test_fetch_list_missing_file(self, tmp_path, monkeypatch):
        monkeypatch.chdir(tmp_path)
        exit_code = main(["fetch-list", "nonexistent.txt"])
        assert exit_code == 1

    def test_fetch_list_too_many_urls(self, tmp_path, monkeypatch):
        _setup_dirs(tmp_path, monkeypatch)
        urls_file = tmp_path / "urls.txt"
        urls = [f"https://example.com/{i}" for i in range(MAX_LIST_URLS + 1)]
        urls_file.write_text("\n".join(urls), encoding="utf-8")

        exit_code = main(["fetch-list", str(urls_file)])
        assert exit_code == 1

    def test_fetch_list_empty_file(self, tmp_path, monkeypatch):
        _setup_dirs(tmp_path, monkeypatch)
        urls_file = tmp_path / "urls.txt"
        urls_file.write_text("# just a comment\n\n", encoding="utf-8")

        exit_code = main(["fetch-list", str(urls_file)])
        assert exit_code == 1

    def test_fetch_list_continues_on_failure(self, tmp_path, monkeypatch):
        _setup_dirs(tmp_path, monkeypatch)
        urls_file = tmp_path / "urls.txt"
        urls_file.write_text("https://fail.invalid\nhttps://example.com\n", encoding="utf-8")

        body = b"<html><body>ok</body></html>"
        call_count = 0
        def _client_factory(*args, **kwargs):
            nonlocal call_count
            call_count += 1
            if call_count == 1:
                raise httpx.ConnectError("refused")
            return _mock_http(200, body=body)

        with _mock_dns(), patch("search_tool.fetch.httpx.Client", side_effect=_client_factory):
            exit_code = main(["fetch-list", str(urls_file)])

        assert exit_code == 0
        manifests = list((tmp_path / "evidence").glob("manifest-*.md"))
        assert len(manifests) == 1
        content = manifests[0].read_text()
        # Manifest should contain both URLs
        assert "fail.invalid" in content
        assert "example.com" in content
        # Should have 1 succeeded, 1 failed
        assert "succeeded: 1" in content
        assert "failed: 1" in content

    def test_fetch_list_refresh_flag(self, tmp_path, monkeypatch):
        _setup_dirs(tmp_path, monkeypatch)
        urls_file = tmp_path / "urls.txt"
        urls_file.write_text("https://example.com\n", encoding="utf-8")

        body = b"<html><body>ok</body></html>"
        with _mock_dns(), patch("search_tool.fetch.httpx.Client", return_value=_mock_http(200, body=body)):
            exit_code = main(["fetch-list", str(urls_file), "--refresh"])

        assert exit_code == 0
        manifests = list((tmp_path / "evidence").glob("manifest-*.md"))
        assert len(manifests) == 1
        content = manifests[0].read_text()
        assert "refresh: true" in content.lower()

    def test_fetch_list_preserves_duplicates(self, tmp_path, monkeypatch):
        _setup_dirs(tmp_path, monkeypatch)
        urls_file = tmp_path / "urls.txt"
        urls_file.write_text("https://example.com\nhttps://example.com\n", encoding="utf-8")

        body = b"<html><body>dup</body></html>"
        with _mock_dns(), patch("search_tool.fetch.httpx.Client", return_value=_mock_http(200, body=body)):
            exit_code = main(["fetch-list", str(urls_file)])

        assert exit_code == 0
        manifests = list((tmp_path / "evidence").glob("manifest-*.md"))
        assert len(manifests) == 1
        content = manifests[0].read_text()
        # Two rows in the table (header + 2 data rows)
        lines = [l for l in content.splitlines() if "example.com" in l]
        assert len(lines) == 2


class TestWriteManifest:
    def test_manifest_has_frontmatter(self, tmp_path, monkeypatch):
        monkeypatch.setattr("search_tool.cli.EVIDENCE_DIR", tmp_path / "evidence")
        (tmp_path / "evidence").mkdir()

        results = [
            EvidenceWriteResult(
                original_url="https://example.com", normalized_url="https://example.com/",
                evidence_path=Path("evidence/example-abc.md"),
                fetch_status="success", http_status=200, cache_status="miss",
                extraction_status="success", text_chars=10, truncated=False,
                errors=(), limitations=(),
            ),
        ]
        path = _write_manifest(results, "urls.txt", False)
        content = path.read_text()
        assert content.startswith("---\n")
        assert 'schema_version: "0.1"' in content
        assert 'name: "fetch-list"' in content
        assert "## Evidence Packs" in content
        # Quality score present
        assert "3/3" in content

    def test_manifest_filename_is_hash_timestamp(self, tmp_path, monkeypatch):
        monkeypatch.setattr("search_tool.cli.EVIDENCE_DIR", tmp_path / "evidence")
        (tmp_path / "evidence").mkdir()

        results = [
            EvidenceWriteResult(
                original_url="https://example.com", normalized_url="https://example.com/",
                evidence_path=Path("evidence/example-abc.md"),
                fetch_status="success", http_status=200, cache_status="miss",
                extraction_status="success", text_chars=10, truncated=False,
                errors=(), limitations=(),
            ),
        ]
        path = _write_manifest(results, "urls.txt", False)
        assert path.stem.startswith("manifest-2")  # timestamp starts with year 20xx
        assert path.suffix == ".md"

    def test_manifest_no_raw_content(self, tmp_path, monkeypatch):
        monkeypatch.setattr("search_tool.cli.EVIDENCE_DIR", tmp_path / "evidence")
        (tmp_path / "evidence").mkdir()

        results = [
            EvidenceWriteResult(
                original_url="https://example.com", normalized_url="https://example.com/",
                evidence_path=Path("evidence/example-abc.md"),
                fetch_status="success", http_status=200, cache_status="miss",
                extraction_status="success", text_chars=10, truncated=False,
                errors=(), limitations=(),
            ),
        ]
        path = _write_manifest(results, "urls.txt", False)
        content = path.read_text()
        assert "## Extracted source content" not in content

    def test_manifest_has_safety_notice(self, tmp_path, monkeypatch):
        monkeypatch.setattr("search_tool.cli.EVIDENCE_DIR", tmp_path / "evidence")
        (tmp_path / "evidence").mkdir()

        from search_tool.evidence import SAFETY_NOTICE
        results = [
            EvidenceWriteResult(
                original_url="https://example.com", normalized_url="https://example.com/",
                evidence_path=Path("evidence/example-abc.md"),
                fetch_status="success", http_status=200, cache_status="miss",
                extraction_status="success", text_chars=10, truncated=False,
                errors=(), limitations=(),
            ),
        ]
        path = _write_manifest(results, "urls.txt", False)
        content = path.read_text()
        assert "## Safety notice" in content
        assert SAFETY_NOTICE in content

    def test_manifest_rich_frontmatter(self, tmp_path, monkeypatch):
        monkeypatch.setattr("search_tool.cli.EVIDENCE_DIR", tmp_path / "evidence")
        (tmp_path / "evidence").mkdir()

        results = [
            EvidenceWriteResult(
                original_url="https://example.com", normalized_url="https://example.com/",
                evidence_path=Path("evidence/example-abc.md"),
                fetch_status="success", http_status=200, cache_status="miss",
                extraction_status="success", text_chars=10, truncated=False,
                errors=(), limitations=(),
            ),
            EvidenceWriteResult(
                original_url="file:///etc/passwd", normalized_url="file:///etc/passwd",
                evidence_path=Path("evidence/unknown-abc.md"),
                fetch_status="blocked", http_status=None, cache_status="not_written",
                extraction_status="skipped", text_chars=0, truncated=False,
                errors=("scheme not allowed",), limitations=(),
            ),
        ]
        path = _write_manifest(results, "urls.txt", False)
        content = path.read_text()
        assert 'manifest_version: "0.1"' in content
        assert "unique_urls: 2" in content
        assert "blocked: 1" in content
        assert "succeeded: 1" in content
        assert "hit: 0" in content
        assert "miss: 1" in content
        assert "not_written: 1" in content

    def test_manifest_pipe_url_escaped(self, tmp_path, monkeypatch):
        monkeypatch.setattr("search_tool.cli.EVIDENCE_DIR", tmp_path / "evidence")
        (tmp_path / "evidence").mkdir()

        results = [
            EvidenceWriteResult(
                original_url="https://example.com/path|with|pipes", normalized_url="https://example.com/path|with|pipes",
                evidence_path=Path("evidence/example-abc.md"),
                fetch_status="success", http_status=200, cache_status="miss",
                extraction_status="success", text_chars=10, truncated=False,
                errors=(), limitations=(),
            ),
        ]
        path = _write_manifest(results, "urls.txt", False)
        content = path.read_text()
        # Pipes inside table cells should be escaped with backslash
        assert "\\|" in content
        # The original unescaped pipe URL should not appear raw in table data rows
        table_lines = [l for l in content.splitlines() if l.startswith("|")]
        data_row = table_lines[2]
        # Should contain the escaped form, not bare pipe as column separator
        assert "path\\|with\\|pipes" in data_row

    def test_manifest_has_cache_column(self, tmp_path, monkeypatch):
        monkeypatch.setattr("search_tool.cli.EVIDENCE_DIR", tmp_path / "evidence")
        (tmp_path / "evidence").mkdir()

        results = [
            EvidenceWriteResult(
                original_url="https://example.com", normalized_url="https://example.com/",
                evidence_path=Path("evidence/example-abc.md"),
                fetch_status="success", http_status=200, cache_status="hit",
                extraction_status="success", text_chars=10, truncated=False,
                errors=(), limitations=(),
            ),
        ]
        path = _write_manifest(results, "urls.txt", False)
        content = path.read_text()
        assert "| Cache |" in content


class TestMdTableSafe:
    def test_escapes_pipe(self):
        assert _md_table_safe("a|b") == "a\\|b"

    def test_escapes_angle_brackets(self):
        assert _md_table_safe("<script>") == "\\<script\\>"

    def test_escapes_backslash(self):
        assert _md_table_safe("a\\b") == "a\\\\b"

    def test_normal_text_unchanged(self):
        assert _md_table_safe("https://example.com/path") == "https://example.com/path"


class TestFetchListStdout:
    def test_prints_per_url_lines_and_manifest(self, tmp_path, monkeypatch, capsys):
        _setup_dirs(tmp_path, monkeypatch)
        urls_file = tmp_path / "urls.txt"
        urls_file.write_text("https://example.com\n", encoding="utf-8")

        body = b"<html><body>ok</body></html>"
        with _mock_dns(), patch("search_tool.fetch.httpx.Client", return_value=_mock_http(200, body=body)):
            exit_code = main(["fetch-list", str(urls_file)])

        assert exit_code == 0
        output = capsys.readouterr().out
        lines = output.strip().splitlines()
        # Last line should be the Manifest: line
        assert lines[-1].startswith("Manifest:\t")
        # Previous lines should be tab-separated per-URL lines
        per_url_lines = [l for l in lines[:-1] if "\t" in l]
        assert len(per_url_lines) == 1
        parts = per_url_lines[0].split("\t")
        assert parts[0] == "https://example.com"
        assert parts[1] == "success"
        assert parts[3] == "3/3"

    def test_prints_multiple_url_lines(self, tmp_path, monkeypatch, capsys):
        _setup_dirs(tmp_path, monkeypatch)
        urls_file = tmp_path / "urls.txt"
        urls_file.write_text("https://example.com\nfile:///etc/passwd\n", encoding="utf-8")

        body = b"<html><body>ok</body></html>"
        with _mock_dns(), patch("search_tool.fetch.httpx.Client", return_value=_mock_http(200, body=body)):
            exit_code = main(["fetch-list", str(urls_file)])

        assert exit_code == 0
        output = capsys.readouterr().out
        lines = output.strip().splitlines()
        per_url_lines = [l for l in lines if l.startswith("https://") or l.startswith("file:")]
        assert len(per_url_lines) == 2
        assert lines[-1].startswith("Manifest:\t")


class TestFollowRedirectsCli:
    def test_fetch_url_follow_redirects_flag(self, tmp_path, monkeypatch):
        _setup_dirs(tmp_path, monkeypatch)
        body = b"<html><body>final</body></html>"
        with _mock_dns(), patch("search_tool.fetch.httpx.Client", return_value=_mock_http(200, body=body)):
            exit_code = main(["fetch-url", "https://example.com", "--follow-redirects"])
        assert exit_code == 0
        packs = list((tmp_path / "evidence").glob("*.md"))
        assert len(packs) == 1

    def test_fetch_list_follow_redirects_flag(self, tmp_path, monkeypatch):
        _setup_dirs(tmp_path, monkeypatch)
        urls_file = tmp_path / "urls.txt"
        urls_file.write_text("https://example.com\n", encoding="utf-8")

        body = b"<html><body>ok</body></html>"
        with _mock_dns(), patch("search_tool.fetch.httpx.Client", return_value=_mock_http(200, body=body)):
            exit_code = main(["fetch-list", str(urls_file), "--follow-redirects"])
        assert exit_code == 0
        manifests = list((tmp_path / "evidence").glob("manifest-*.md"))
        assert len(manifests) == 1

    def test_follow_redirects_with_refresh(self, tmp_path, monkeypatch):
        _setup_dirs(tmp_path, monkeypatch)
        body = b"<html><body>ok</body></html>"
        with _mock_dns(), patch("search_tool.fetch.httpx.Client", return_value=_mock_http(200, body=body)):
            exit_code = main(["fetch-url", "https://example.com", "--follow-redirects", "--refresh"])
        assert exit_code == 0

    def test_final_url_survives_cache_hit_with_follow_redirects(self, tmp_path, monkeypatch):
        """First run: redirect A -> B. Second run: cache hit. final_url must be B both times."""
        _setup_dirs(tmp_path, monkeypatch)

        # Build mock that returns 301 -> 200 on first call, then 200 on cache hit (not called)
        call_count = 0
        def _multi_mock(*args, **kwargs):
            nonlocal call_count
            call_count += 1
            if call_count == 1:
                # First request returns 301 redirect
                r1 = _mock_http(301, headers={"location": "https://final.com/page"})
                return r1
            else:
                # Second request (following redirect) returns 200
                return _mock_http(200, body=b"<html><body>final page</body></html>")

        with _mock_dns(), patch("search_tool.fetch.httpx.Client", side_effect=_multi_mock), \
             patch("search_tool.url_policy.check_url", return_value=MagicMock(passed=True)), \
             patch("search_tool.url_policy.normalize_url", side_effect=lambda u: u):
            # First run — miss
            result1 = fetch_url_to_evidence("https://start.com", refresh=False, follow_redirects=True)

        assert result1.cache_status == "miss"
        pack1_content = result1.evidence_path.read_text()
        assert 'final_url: "https://final.com/page"' in pack1_content, \
            f"First run should have final_url=final.com. Got content:\n{pack1_content[:500]}"

        # Second run — should be cache hit with same final_url
        call_count = 0
        with _mock_dns(), patch("search_tool.url_policy.check_url", return_value=MagicMock(passed=True)), \
             patch("search_tool.url_policy.normalize_url", side_effect=lambda u: u):
            result2 = fetch_url_to_evidence("https://start.com", refresh=False, follow_redirects=True)

        assert result2.cache_status == "hit"
        pack2_content = result2.evidence_path.read_text()
        assert 'final_url: "https://final.com/page"' in pack2_content, \
            f"Cache hit should preserve final_url. Got content:\n{pack2_content[:500]}"

        # Redirects list should be preserved
        assert "redirects:" in pack2_content
        assert "https://final.com" in pack2_content

    def test_cache_key_uses_max_redirects_from_fetch_config(self, tmp_path, monkeypatch):
        """Pipeline should pass MAX_REDIRECTS to cache, not rely on cache defaults."""
        from search_tool.fetch import MAX_REDIRECTS
        from search_tool import cache as cache_mod
        _setup_dirs(tmp_path, monkeypatch)
        body = b"<html><body>ok</body></html>"
        with _mock_dns(), patch("search_tool.fetch.httpx.Client", return_value=_mock_http(200, body=body)), \
             patch.object(cache_mod, "_make_key", wraps=cache_mod._make_key) as spy:
            fetch_url_to_evidence("https://example.com", refresh=False, follow_redirects=True)
            for call in spy.call_args_list:
                kwargs = call.kwargs if call.kwargs else call[1]
                if "max_redirects" in kwargs:
                    assert kwargs["max_redirects"] == MAX_REDIRECTS


# --- discover-query tests ---


def _run_discover(argv, capsys=None):
    exit_code = main(argv)
    captured = capsys.readouterr() if capsys else None
    return exit_code, captured


def _parse_discover_json(output: str) -> dict:
    return json.loads(output)


class TestDiscoverQueryStatic:
    def test_static_one_safe_url_prints_json_exits_zero(self, capsys):
        exit_code, captured = _run_discover(
            ["discover-query", "test query", "--provider", "static",
             "--candidate-url", "https://example.com"],
            capsys,
        )
        assert exit_code == 0
        data = _parse_discover_json(captured.out)
        assert data["schema_version"] == "0.1"
        assert data["provider"]["name"] == "static"

    def test_json_contains_query_fields(self, capsys):
        exit_code, captured = _run_discover(
            ["discover-query", "  spaced   query  ", "--provider", "static",
             "--candidate-url", "https://example.com"],
            capsys,
        )
        assert exit_code == 0
        data = _parse_discover_json(captured.out)
        assert data["query"]["original"] == "  spaced   query  "
        assert data["query"]["normalized"] == "spaced query"
        assert "redacted" in data["query"]

    def test_urls_for_fetch_contains_safe_url(self, capsys):
        exit_code, captured = _run_discover(
            ["discover-query", "test", "--provider", "static",
             "--candidate-url", "https://example.com"],
            capsys,
        )
        assert exit_code == 0
        data = _parse_discover_json(captured.out)
        assert "https://example.com/" in data["urls_for_fetch"]

    def test_blocked_url_not_in_urls_for_fetch(self, capsys):
        exit_code, captured = _run_discover(
            ["discover-query", "test", "--provider", "static",
             "--candidate-url", "file:///etc/passwd"],
            capsys,
        )
        assert exit_code == 0
        data = _parse_discover_json(captured.out)
        assert len(data["urls_for_fetch"]) == 0
        assert data["candidates"][0]["url_policy"] == "blocked"
        assert data["summary"]["blocked"] == 1

    def test_duplicate_url_selected_once(self, capsys):
        exit_code, captured = _run_discover(
            ["discover-query", "test", "--provider", "static",
             "--candidate-url", "https://example.com",
             "--candidate-url", "https://example.com/"],
            capsys,
        )
        assert exit_code == 0
        data = _parse_discover_json(captured.out)
        # Canonical dedup collapses https://example.com and https://example.com/
        assert len(data["urls_for_fetch"]) == 1
        assert len(data["candidates"]) == 1
        assert len([c for c in data["candidates"] if c["duplicate_of"] is not None]) == 0
        # Collapsed count reported in limitations
        assert any("collapsed" in lim.lower() and "canonical" in lim.lower()
                    for lim in data.get("limitations", []))

    def test_title_snippet_engine_metadata_by_index(self, capsys):
        exit_code, captured = _run_discover(
            ["discover-query", "test", "--provider", "static",
             "--candidate-url", "https://a.com",
             "--candidate-url", "https://b.com",
             "--candidate-title", "Title A",
             "--candidate-title", "Title B",
             "--candidate-snippet", "Snippet A",
             "--candidate-snippet", "Snippet B",
             "--candidate-engine", "engine_a",
             "--candidate-engine", "engine_b"],
            capsys,
        )
        assert exit_code == 0
        data = _parse_discover_json(captured.out)
        assert data["candidates"][0]["title"] == "Title A"
        assert data["candidates"][0]["snippet"] == "Snippet A"
        assert data["candidates"][0]["source_engine"] == "engine_a"
        assert data["candidates"][1]["title"] == "Title B"
        assert data["candidates"][1]["snippet"] == "Snippet B"
        assert data["candidates"][1]["source_engine"] == "engine_b"

    def test_max_candidates_caps(self, capsys):
        exit_code, captured = _run_discover(
            ["discover-query", "test", "--provider", "static",
             "--max-candidates", "1",
             "--candidate-url", "https://a.com",
             "--candidate-url", "https://b.com"],
            capsys,
        )
        assert exit_code == 0
        data = _parse_discover_json(captured.out)
        assert data["summary"]["candidates_total"] == 1

    def test_empty_query_exits_one(self, capsys):
        exit_code, captured = _run_discover(
            ["discover-query", "   ", "--provider", "static",
             "--candidate-url", "https://example.com"],
            capsys,
        )
        assert exit_code == 1
        assert "error" in captured.err.lower()


class TestDiscoverQueryStaticInputErrors:
    def test_static_without_candidate_url_exits_one(self, capsys):
        exit_code, captured = _run_discover(
            ["discover-query", "test", "--provider", "static"],
            capsys,
        )
        assert exit_code == 1
        assert "error" in captured.err.lower()

    def test_metadata_count_mismatch_exits_one(self, capsys):
        exit_code, captured = _run_discover(
            ["discover-query", "test", "--provider", "static",
             "--candidate-url", "https://a.com",
             "--candidate-title", "A",
             "--candidate-title", "B"],
            capsys,
        )
        assert exit_code == 1
        assert "error" in captured.err.lower()

    def test_invalid_max_candidates_exits_one(self, capsys):
        exit_code, captured = _run_discover(
            ["discover-query", "test", "--provider", "static",
             "--max-candidates", "-1",
             "--candidate-url", "https://a.com"],
            capsys,
        )
        assert exit_code == 1


class TestDiscoverQuerySearxng:
    def test_searxng_without_url_exits_one(self, capsys):
        exit_code, captured = _run_discover(
            ["discover-query", "test", "--provider", "searxng"],
            capsys,
        )
        assert exit_code == 1
        assert "error" in captured.err.lower()

    def test_searxng_with_mock_prints_valid_json(self, capsys):
        mock_transport = httpx.MockTransport(lambda request: httpx.Response(
            200,
            json={"results": [{"url": "https://example.com", "title": "Test", "content": "Snippet"}]},
            request=request,
        ))
        with _mock_dns(), patch("search_tool.discovery.httpx.Client", return_value=httpx.Client(transport=mock_transport)):
            exit_code, captured = _run_discover(
                ["discover-query", "test", "--provider", "searxng",
                 "--searxng-url", "https://search.example.com"],
                capsys,
            )
        assert exit_code == 0
        data = _parse_discover_json(captured.out)
        assert data["provider"]["name"] == "searxng"
        assert len(data["candidates"]) == 1

    def test_searxng_output_json_valid(self, capsys):
        mock_transport = httpx.MockTransport(lambda request: httpx.Response(
            200,
            json={"results": []},
            request=request,
        ))
        with _mock_dns(), patch("search_tool.discovery.httpx.Client", return_value=httpx.Client(transport=mock_transport)):
            exit_code, captured = _run_discover(
                ["discover-query", "test query", "--provider", "searxng",
                 "--searxng-url", "https://search.example.com"],
                capsys,
            )
        assert exit_code == 0
        data = _parse_discover_json(captured.out)
        assert "schema_version" in data
        assert "query" in data
        assert "provider" in data
        assert "summary" in data
        assert "urls_for_fetch" in data
        assert "candidates" in data
        assert "errors" in data
        assert "limitations" in data

    def test_searxng_403_exits_zero_with_api_forbidden(self, capsys):
        mock_transport = httpx.MockTransport(lambda request: httpx.Response(403, request=request))
        with _mock_dns(), patch("search_tool.discovery.httpx.Client", return_value=httpx.Client(transport=mock_transport)):
            exit_code, captured = _run_discover(
                ["discover-query", "test", "--provider", "searxng",
                 "--searxng-url", "https://search.example.com"],
                capsys,
            )
        assert exit_code == 0
        data = _parse_discover_json(captured.out)
        error_codes = [e["code"] for e in data["errors"]]
        assert "api_forbidden" in error_codes

    def test_language_passed_through(self, capsys):
        mock_transport = httpx.MockTransport(lambda request: httpx.Response(
            200,
            json={"results": []},
            request=request,
        ))
        with _mock_dns(), patch("search_tool.discovery.httpx.Client", return_value=httpx.Client(transport=mock_transport)):
            exit_code, captured = _run_discover(
                ["discover-query", "test", "--provider", "searxng",
                 "--searxng-url", "https://search.example.com",
                 "--language", "pl"],
                capsys,
            )
        assert exit_code == 0
        data = _parse_discover_json(captured.out)
        assert data["provider"]["name"] == "searxng"

    def test_category_repeatable_passed_through(self, capsys):
        mock_transport = httpx.MockTransport(lambda request: httpx.Response(
            200,
            json={"results": []},
            request=request,
        ))
        with _mock_dns(), patch("search_tool.discovery.httpx.Client", return_value=httpx.Client(transport=mock_transport)):
            exit_code, captured = _run_discover(
                ["discover-query", "test", "--provider", "searxng",
                 "--searxng-url", "https://search.example.com",
                 "--category", "general",
                 "--category", "science"],
                capsys,
            )
        assert exit_code == 0
        data = _parse_discover_json(captured.out)
        assert data["provider"]["name"] == "searxng"

    def test_safesearch_passed_through(self, capsys):
        mock_transport = httpx.MockTransport(lambda request: httpx.Response(
            200,
            json={"results": []},
            request=request,
        ))
        with _mock_dns(), patch("search_tool.discovery.httpx.Client", return_value=httpx.Client(transport=mock_transport)):
            exit_code, captured = _run_discover(
                ["discover-query", "test", "--provider", "searxng",
                 "--searxng-url", "https://search.example.com",
                 "--safesearch", "1"],
                capsys,
            )
        assert exit_code == 0

    def test_invalid_safesearch_exits_one(self, capsys):
        exit_code, captured = _run_discover(
            ["discover-query", "test", "--provider", "searxng",
             "--searxng-url", "https://search.example.com",
             "--safesearch", "3"],
            capsys,
        )
        assert exit_code == 1
        assert "error" in captured.err.lower()

    def test_invalid_timeout_exits_one(self, capsys):
        exit_code, captured = _run_discover(
            ["discover-query", "test", "--provider", "searxng",
             "--searxng-url", "https://search.example.com",
             "--timeout", "-5"],
            capsys,
        )
        assert exit_code == 1
        assert "error" in captured.err.lower()


class TestDiscoverQueryHelp:
    def test_help_includes_discover_query(self, capsys):
        with pytest.raises(SystemExit) as exc_info:
            main(["--help"])
        assert exc_info.value.code == 0
        output = capsys.readouterr().out
        assert "discover-query" in output


# --- search-query tests ---


def _run_search(argv, capsys=None):
    exit_code = main(argv)
    captured = capsys.readouterr() if capsys else None
    return exit_code, captured


class TestSearchQueryStaticHappy:
    def test_static_happy_path_exits_zero(self, tmp_path, monkeypatch, capsys):
        _setup_dirs(tmp_path, monkeypatch)
        exit_code, captured = _run_search(
            ["search-query", "test query", "--provider", "static",
             "--candidate-url", "https://example.com"],
            capsys,
        )
        assert exit_code == 0
        assert "Manifest:\t" in captured.out
        assert "discovery" in captured.err
        assert "fetch" in captured.err

    def test_static_prints_tsv_and_manifest(self, tmp_path, monkeypatch, capsys):
        _setup_dirs(tmp_path, monkeypatch)
        exit_code, captured = _run_search(
            ["search-query", "test", "--provider", "static",
             "--candidate-url", "https://example.com"],
            capsys,
        )
        assert exit_code == 0
        lines = captured.out.strip().splitlines()
        assert lines[-1].startswith("SearchManifest:\t")
        assert lines[-2].startswith("Manifest:\t")
        per_url = [l for l in lines[:-2] if "\t" in l]
        assert len(per_url) == 1
        assert "https://example.com" in per_url[0]


class TestSearchQueryFailure:
    def test_search_manifest_failure_exits_one(self, tmp_path, monkeypatch, capsys):
        _setup_dirs(tmp_path, monkeypatch)
        # Mock write_search_run_manifest to fail (returning None or raising)
        with patch("search_tool.cli.write_search_run_manifest", return_value=None):
            exit_code, captured = _run_search(
                ["search-query", "test", "--provider", "static",
                 "--candidate-url", "https://example.com"],
                capsys,
            )
        assert exit_code == 1
        assert "error" in captured.err.lower()


class TestSearchQuerySearxngHappy:
    def test_searxng_with_mock_exits_zero(self, tmp_path, monkeypatch, capsys):
        _setup_dirs(tmp_path, monkeypatch)
        mock_transport = httpx.MockTransport(lambda request: httpx.Response(
            200,
            json={"results": [{"url": "https://example.com", "title": "Test", "content": "Snippet"}]},
            request=request,
        ))
        with _mock_dns(), patch("search_tool.discovery.httpx.Client", return_value=httpx.Client(transport=mock_transport)):
            exit_code, captured = _run_search(
                ["search-query", "test", "--provider", "searxng",
                 "--searxng-url", "https://search.example.com"],
                capsys,
            )
        assert exit_code == 0
        assert "Manifest:\t" in captured.out
        assert "provider=searxng" in captured.err

    def test_searxng_url_redacted_in_manifest(self, tmp_path, monkeypatch, capsys):
        _setup_dirs(tmp_path, monkeypatch)
        mock_transport = httpx.MockTransport(lambda request: httpx.Response(
            200,
            json={"results": []},
            request=request,
        ))
        with _mock_dns(), patch("search_tool.discovery.httpx.Client", return_value=httpx.Client(transport=mock_transport)):
            exit_code, captured = _run_search(
                ["search-query", "test", "--provider", "searxng",
                 "--searxng-url", "https://user:pass@search.example.com:8443/path?token=abc"],
                capsys,
            )
        assert exit_code == 0

        import re
        match = re.search(r"SearchManifest:\t(.*?)$", captured.out, re.MULTILINE)
        assert match
        manifest_path = Path(match.group(1))
        assert manifest_path.exists()

        content = manifest_path.read_text()
        assert "user:pass" not in content
        assert "token=abc" not in content
        assert "path" not in content
        assert "https://search.example.com:8443" in content


class TestSearchQueryStderr:
    def test_stderr_contains_discovery_and_fetch_summary(self, tmp_path, monkeypatch, capsys):
        _setup_dirs(tmp_path, monkeypatch)
        exit_code, captured = _run_search(
            ["search-query", "test", "--provider", "static",
             "--candidate-url", "https://example.com"],
            capsys,
        )
        assert exit_code == 0
        assert "[discovery]" in captured.err
        assert "[fetch]" in captured.err
        assert "provider=static" in captured.err
        assert "selected=1" in captured.err


class TestSearchQueryInputErrors:
    def test_empty_query_exits_one(self, capsys):
        exit_code, captured = _run_search(
            ["search-query", "   ", "--provider", "static",
             "--candidate-url", "https://example.com"],
            capsys,
        )
        assert exit_code == 1
        assert "error" in captured.err.lower()

    def test_static_without_candidate_url_exits_one(self, capsys):
        exit_code, captured = _run_search(
            ["search-query", "test", "--provider", "static"],
            capsys,
        )
        assert exit_code == 1
        assert "error" in captured.err.lower()

    def test_searxng_without_url_exits_one(self, capsys):
        exit_code, captured = _run_search(
            ["search-query", "test", "--provider", "searxng"],
            capsys,
        )
        assert exit_code == 1
        assert "error" in captured.err.lower()

    def test_invalid_max_candidates_exits_one(self, capsys):
        exit_code, captured = _run_search(
            ["search-query", "test", "--provider", "static",
             "--max-candidates", "-1",
             "--candidate-url", "https://a.com"],
            capsys,
        )
        assert exit_code == 1

    def test_invalid_safesearch_exits_one(self, capsys):
        exit_code, captured = _run_search(
            ["search-query", "test", "--provider", "searxng",
             "--searxng-url", "https://search.example.com",
             "--safesearch", "3"],
            capsys,
        )
        assert exit_code == 1
        assert "error" in captured.err.lower()

    def test_invalid_timeout_exits_one(self, capsys):
        exit_code, captured = _run_search(
            ["search-query", "test", "--provider", "searxng",
             "--searxng-url", "https://search.example.com",
             "--timeout", "-5"],
            capsys,
        )
        assert exit_code == 1
        assert "error" in captured.err.lower()


class TestSearchQueryFetchOptions:
    def test_refresh_passed_through(self, tmp_path, monkeypatch, capsys):
        _setup_dirs(tmp_path, monkeypatch)
        body = b"<html><body>ok</body></html>"
        with _mock_dns(), patch("search_tool.fetch.httpx.Client", return_value=_mock_http(200, body=body)):
            exit_code = main([
                "search-query", "test", "--provider", "static",
                "--candidate-url", "https://example.com",
                "--refresh",
            ])
        assert exit_code == 0

    def test_follow_redirects_passed_through(self, tmp_path, monkeypatch, capsys):
        _setup_dirs(tmp_path, monkeypatch)
        body = b"<html><body>ok</body></html>"
        with _mock_dns(), patch("search_tool.fetch.httpx.Client", return_value=_mock_http(200, body=body)):
            exit_code = main([
                "search-query", "test", "--provider", "static",
                "--candidate-url", "https://example.com",
                "--follow-redirects",
            ])
        assert exit_code == 0


class TestSearchQueryZeroUrls:
    def test_all_blocked_exits_zero_with_manifest(self, tmp_path, monkeypatch, capsys):
        _setup_dirs(tmp_path, monkeypatch)
        exit_code, captured = _run_search(
            ["search-query", "test", "--provider", "static",
             "--candidate-url", "file:///etc/passwd"],
            capsys,
        )
        assert exit_code == 0
        assert "Manifest:\t" in captured.out
        assert "selected=0" in captured.err


class TestSearchQueryHelp:
    def test_help_includes_search_query(self, capsys):
        with pytest.raises(SystemExit) as exc_info:
            main(["--help"])
        assert exc_info.value.code == 0
        output = capsys.readouterr().out
        assert "search-query" in output


class TestUiCli:
    def test_ui_help_includes_ui(self, capsys):
        with pytest.raises(SystemExit) as exc_info:
            main(["--help"])
        assert exc_info.value.code == 0
        output = capsys.readouterr().out
        assert "ui" in output

    def test_ui_command_help(self, capsys):
        with pytest.raises(SystemExit) as exc_info:
            main(["ui", "--help"])
        assert exc_info.value.code == 0
        output = capsys.readouterr().out
        assert "--port" in output
        assert "--host" in output
        assert "--work-dir" in output
