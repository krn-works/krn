"""Local end-to-end smoke test — no live internet.

Uses a mocked httpx transport to simulate real HTTP responses.
Proves the full pipeline: CLI -> policy -> fetch -> cache -> evidence pack.
"""

import json
from unittest.mock import patch, MagicMock

import httpx

from search_tool.cli import main


def _setup_dirs(tmp_path, monkeypatch):
    """Set up isolated directories for a test."""
    monkeypatch.chdir(tmp_path)
    evidence_dir = tmp_path / "evidence"
    cache_dir = tmp_path / "cache"
    objects_dir = cache_dir / "objects"
    entries_dir = cache_dir / "entries"
    evidence_dir.mkdir()
    objects_dir.mkdir(parents=True)
    entries_dir.mkdir(parents=True)
    monkeypatch.setattr("search_tool.evidence.EVIDENCE_DIR", evidence_dir)
    monkeypatch.setattr("search_tool.cache.CACHE_DIR", cache_dir)
    monkeypatch.setattr("search_tool.cache.OBJECTS_DIR", objects_dir)
    monkeypatch.setattr("search_tool.cache.ENTRIES_DIR", entries_dir)
    return evidence_dir, objects_dir, entries_dir


def _mock_http_response(status_code=200, content_type="text/html", body=b"", location=None):
    """Create a mock httpx streaming response."""
    mock_response = MagicMock()
    mock_response.status_code = status_code
    headers = {"content-type": content_type}
    if location:
        headers["location"] = location
    mock_response.headers = headers
    mock_response.iter_bytes.return_value = iter([body])
    mock_ctx = MagicMock()
    mock_ctx.__enter__ = MagicMock(return_value=mock_response)
    mock_ctx.__exit__ = MagicMock(return_value=False)
    return mock_ctx, mock_response


def _mock_client(response_ctx):
    """Create a mock httpx.Client with a given stream context."""
    mock_client = MagicMock()
    mock_client.stream.return_value = response_ctx
    mock_client.__enter__ = MagicMock(return_value=mock_client)
    mock_client.__exit__ = MagicMock(return_value=False)
    return mock_client


class TestE2ESmoke:
    """Full pipeline e2e test with mocked transport."""

    def test_full_pipeline_cache_miss_hit_refresh(self, tmp_path, monkeypatch):
        evidence_dir, objects_dir, entries_dir = _setup_dirs(tmp_path, monkeypatch)

        html = b"<html><head><title>E2E Test</title></head><body><p>E2E content</p></body></html>"

        # --- Run 1: cache miss ---
        ctx, resp = _mock_http_response(200, "text/html", html)
        client = _mock_client(ctx)
        with patch("search_tool.url_policy.socket.getaddrinfo",
                    return_value=[(2, 1, 6, "", ("93.184.216.34", 0))]), \
             patch("search_tool.fetch.httpx.Client", return_value=client):
            exit_code = main(["fetch-url", "https://example.com/e2e"])

        assert exit_code == 0

        # Evidence file should exist
        packs = list(evidence_dir.glob("*.md"))
        assert len(packs) == 1
        pack_content = packs[0].read_text()

        # Verify frontmatter
        assert 'schema_version: "0.1"' in pack_content
        assert "generated_at_utc:" in pack_content
        assert 'name: "krn-search-lab"' in pack_content

        # Verify safety notice
        assert "untrusted external content" in pack_content

        # Verify extracted content
        assert "E2E content" in pack_content

        # Verify cache miss
        assert 'status: "miss"' in pack_content

        # Verify final_url present for 2xx
        assert "final_url:" in pack_content
        assert "final_url: null" not in pack_content

        # --- Run 2: cache hit ---
        packs_before = list(evidence_dir.glob("*.md"))
        ctx2, resp2 = _mock_http_response(200, "text/html", html)
        client2 = _mock_client(ctx2)
        with patch("search_tool.url_policy.socket.getaddrinfo",
                    return_value=[(2, 1, 6, "", ("93.184.216.34", 0))]), \
             patch("search_tool.fetch.httpx.Client", return_value=client2):
            exit_code2 = main(["fetch-url", "https://example.com/e2e"])

        assert exit_code2 == 0
        packs_after = list(evidence_dir.glob("*.md"))
        assert len(packs_after) == 1

        hit_content = packs_after[0].read_text()
        assert 'status: "hit"' in hit_content

        # Cache objects should exist
        assert list(objects_dir.iterdir())

        # --- Run 3: refresh bypass ---
        ctx3, resp3 = _mock_http_response(200, "text/html", b"<html><body>Updated</body></html>")
        client3 = _mock_client(ctx3)
        with patch("search_tool.url_policy.socket.getaddrinfo",
                    return_value=[(2, 1, 6, "", ("93.184.216.34", 0))]), \
             patch("search_tool.fetch.httpx.Client", return_value=client3):
            exit_code3 = main(["fetch-url", "https://example.com/e2e", "--refresh"])

        assert exit_code3 == 0
        refresh_content = list(evidence_dir.glob("*.md"))[0].read_text()
        assert 'status: "bypass"' in refresh_content
        assert "Updated" in refresh_content

    def test_blocked_url_e2e(self, tmp_path, monkeypatch):
        evidence_dir, _, _ = _setup_dirs(tmp_path, monkeypatch)

        exit_code = main(["fetch-url", "file:///etc/passwd"])
        assert exit_code == 0

        packs = list(evidence_dir.glob("*.md"))
        assert len(packs) == 1
        pack = packs[0].read_text()
        assert 'url_policy: "blocked"' in pack
        assert "final_url: null" in pack
        assert "untrusted external content" in pack

    def test_fetch_error_e2e(self, tmp_path, monkeypatch):
        evidence_dir, _, _ = _setup_dirs(tmp_path, monkeypatch)

        with patch("search_tool.url_policy.socket.getaddrinfo",
                    return_value=[(2, 1, 6, "", ("93.184.216.34", 0))]), \
             patch("search_tool.fetch.httpx.Client", side_effect=httpx.ConnectError("refused")):
            exit_code = main(["fetch-url", "https://down.example.com"])

        assert exit_code == 0
        packs = list(evidence_dir.glob("*.md"))
        assert len(packs) == 1
        pack = packs[0].read_text()
        assert "Connection" in pack or "refused" in pack
        assert "final_url: null" in pack

    def test_404_e2e(self, tmp_path, monkeypatch):
        evidence_dir, _, _ = _setup_dirs(tmp_path, monkeypatch)

        ctx, resp = _mock_http_response(404, "text/html", b"<html><body>Not Found</body></html>")
        client = _mock_client(ctx)
        with patch("search_tool.url_policy.socket.getaddrinfo",
                    return_value=[(2, 1, 6, "", ("93.184.216.34", 0))]), \
             patch("search_tool.fetch.httpx.Client", return_value=client):
            exit_code = main(["fetch-url", "https://example.com/missing"])

        assert exit_code == 0
        pack = list(evidence_dir.glob("*.md"))[0].read_text()
        assert "404" in pack
        assert "Not Found" in pack
        assert 'status: "failed"' in pack
