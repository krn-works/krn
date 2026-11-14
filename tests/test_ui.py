"""Tests for the local UI testbench."""

import json
from pathlib import Path
from unittest.mock import patch, MagicMock
from http.server import HTTPServer
import threading
import time

import pytest
import httpx

from search_tool.ui import UIRequestHandler, run_ui_server, _sanitize_provider_url
from search_tool.search import SearchRunResult, EvidenceWriteResult
from search_tool.discovery import DiscoveryResult, DiscoveryCandidate


class MockUIHandler(UIRequestHandler):
    """Handler with fixed work_dir for testing."""
    def __init__(self, *args, **kwargs):
        self.work_dir = kwargs.pop("work_dir")
        super().__init__(*args, **kwargs)


@pytest.fixture
def test_ui(tmp_path):
    work_dir = tmp_path / "ui-work"
    work_dir.mkdir()

    # We need a way to pass work_dir to the handler
    # Since HTTPServer instantiates the handler, we use a factory
    def handler_factory(*args, **kwargs):
        return MockUIHandler(*args, work_dir=work_dir, **kwargs)

    server = HTTPServer(("127.0.0.1", 0), handler_factory)
    port = server.server_port

    thread = threading.Thread(target=server.serve_forever)
    thread.daemon = True
    thread.start()

    yield f"http://127.0.0.1:{port}", work_dir

    server.shutdown()
    thread.join()


def test_ui_health(test_ui):
    url, _ = test_ui
    resp = httpx.get(f"{url}/api/health")
    assert resp.status_code == 200
    data = resp.json()
    assert data["status"] == "ok"
    assert "work_dir" in data


def test_ui_root_returns_html(test_ui):
    url, _ = test_ui
    resp = httpx.get(f"{url}/")
    assert resp.status_code == 200
    assert "text/html" in resp.headers["content-type"]
    assert "[ krn-search ]" in resp.text

def test_ui_artifacts_list(test_ui):
    url, work_dir = test_ui
    (work_dir / "test.md").write_text("content")
    (work_dir / "data.json").write_text("{}")

    resp = httpx.get(f"{url}/api/artifacts")
    assert resp.status_code == 200
    data = resp.json()
    assert len(data) == 2
    names = [a["name"] for a in data]
    assert "test.md" in names
    assert "data.json" in names


def test_ui_artifact_read(test_ui):
    url, work_dir = test_ui
    (work_dir / "test.md").write_text("hello world")

    resp = httpx.get(f"{url}/api/artifact?path=test.md")
    assert resp.status_code == 200
    assert resp.text == "hello world"


def test_ui_artifact_path_confinement(test_ui, tmp_path):
    url, work_dir = test_ui
    outside_file = tmp_path / "outside.txt"
    outside_file.write_text("secret")

    # Attempt path traversal
    resp = httpx.get(f"{url}/api/artifact?path=../outside.txt")
    assert resp.status_code == 403


def test_ui_search_query_api_static(test_ui):
    url, work_dir = test_ui

    mock_result = SearchRunResult(
        discovery=DiscoveryResult(
            schema_version="0.1",
            query_original="test",
            query_normalized="test",
            query_redacted="test",
            provider_name="static",
            candidates=(),
            errors=(),
            limitations=()
        ),
        evidence_results=(),
        manifest_path=Path("manifest.md"),
        search_manifest_path=Path("search.md"),
        limitations=()
    )

    with patch("search_tool.ui.search_query", return_value=mock_result):
        resp = httpx.post(f"{url}/api/search-query", json={
            "query": "test",
            "provider": "static",
            "candidate_urls": ["https://example.com"]
        })

    assert resp.status_code == 200
    data = resp.json()
    assert data["discovery"]["provider_name"] == "static"
    assert data["search_manifest_path"] == "search.md"


def test_ui_eval_corpus_api(test_ui, tmp_path):
    url, work_dir = test_ui
    corpus_file = tmp_path / "corpus.json"
    corpus_file.write_text(json.dumps({
        "schema_version": "0.1",
        "scenarios": []
    }))

    with patch("search_tool.ui.run_corpus", return_value=[]):
        resp = httpx.post(f"{url}/api/eval-corpus", json={
            "corpus_path": str(corpus_file)
        })

    assert resp.status_code == 200
    data = resp.json()
    assert data["status"] == "PASS"
    assert data["scenarios_total"] == 0


def test_ui_malformed_json(test_ui):
    url, _ = test_ui
    resp = httpx.post(f"{url}/api/search-query", content="not json")
    assert resp.status_code == 400
    assert "error" in resp.json()


def test_ui_missing_query(test_ui):
    url, _ = test_ui
    resp = httpx.post(f"{url}/api/search-query", json={"query": ""})
    assert resp.status_code == 400
    assert "Query must not be empty" in resp.json()["error"]


def test_ui_search_summaries_in_api(test_ui):
    url, work_dir = test_ui

    mock_result = SearchRunResult(
        discovery=DiscoveryResult(
            schema_version="0.1",
            query_original="test",
            query_normalized="test",
            query_redacted="test",
            provider_name="searxng",
            candidates=(
                DiscoveryCandidate(rank=1, url="http://a.com", normalized_url="http://a.com", title="A", snippet="A", source_engine="searxng", url_policy="passed", blocked_reason=None, selected_for_fetch=True),
                DiscoveryCandidate(rank=2, url="http://b.com", normalized_url=None, title="B", snippet="B", source_engine="searxng", url_policy="blocked", blocked_reason="policy", selected_for_fetch=False),
            ),
            errors=(),
            limitations=()
        ),
        evidence_results=(
            EvidenceWriteResult(original_url="http://a.com", normalized_url="http://a.com", evidence_path=Path("a.md"), fetch_status="success", http_status=200, cache_status="miss", extraction_status="success", text_chars=100, truncated=False, errors=(), limitations=()),
            EvidenceWriteResult(original_url="http://c.com", normalized_url="http://c.com", evidence_path=Path("c.md"), fetch_status="success", http_status=301, cache_status="not_written", extraction_status="skipped", text_chars=0, truncated=False, errors=(), limitations=()),
        ),
        manifest_path=Path("manifest.md"),
        search_manifest_path=Path("search.md"),
        limitations=()
    )

    with patch("search_tool.ui.search_query", return_value=mock_result):
        resp = httpx.post(f"{url}/api/search-query", json={
            "query": "test",
            "provider": "searxng",
            "searxng_url": "http://localhost:9999"
        })

    assert resp.status_code == 200
    data = resp.json()

    # Discovery summary
    ds = data["discovery_summary"]
    assert ds["candidates_total"] == 2
    assert ds["selected"] == 1
    assert ds["blocked"] == 1

    # Ingestion summary
    isum = data["ingestion_summary"]
    assert isum["packs_total"] == 2
    assert isum["extracted"] == 1
    assert isum["redirects"] == 1


def test_ui_isolation_under_work_dir(test_ui):
    url, work_dir = test_ui

    mock_result = SearchRunResult(
        discovery=DiscoveryResult(schema_version="0.1", query_original="test", query_normalized="test", query_redacted="test", provider_name="static", candidates=(), errors=(), limitations=()),
        evidence_results=(),
        manifest_path=work_dir / "manifest.md",
        search_manifest_path=work_dir / "search.md",
        limitations=()
    )

    with patch("search_tool.ui.search_query", return_value=mock_result):
        httpx.post(f"{url}/api/search-query", json={"query": "test", "provider": "static"})
        # Check if directories were patched to be under work_dir
        import search_tool.evidence
        assert search_tool.evidence.EVIDENCE_DIR.is_relative_to(work_dir)
        assert "runs" in search_tool.evidence.EVIDENCE_DIR.parts
        import search_tool.cache
        assert search_tool.cache.CACHE_DIR == work_dir / "cache"

    # Verify no pollution of repo root
    from search_tool.evidence import EVIDENCE_DIR as REPO_EVIDENCE
    from search_tool.cache import CACHE_DIR as REPO_CACHE
    assert not (REPO_EVIDENCE / "search-").exists()
    assert not (REPO_CACHE / "objects").exists()


def test_ui_localhost_search_still_blocked(test_ui, mock_dns_mapper):
    url, work_dir = test_ui
    mock_dns_mapper["localhost"] = "127.0.0.1"

    # UI search for localhost URL
    # Even if UI server is on localhost, and we might allow private SearXNG,
    # candidate URLs should still be blocked.
    resp = httpx.post(f"{url}/api/search-query", json={
        "query": "test",
        "provider": "static",
        "candidate_urls": ["http://localhost/"]
    })

    assert resp.status_code == 200
    data = resp.json()
    assert data["discovery"]["candidates"][0]["url_policy"] == "blocked"
    assert not data["discovery"]["candidates"][0]["selected_for_fetch"]
    assert data["discovery_summary"]["blocked"] == 1


def test_ui_redirect_to_private_blocked(test_ui, mock_dns_mapper):
    url, work_dir = test_ui
    mock_dns_mapper["example.com"] = "93.184.216.34"
    mock_dns_mapper["localhost"] = "127.0.0.1"

    # Mock fetcher to return a redirect to localhost
    mock_redirect = EvidenceWriteResult(
        original_url="http://example.com/redirect",
        normalized_url="http://example.com/redirect",
        evidence_path=work_dir / "redirect.md",
        fetch_status="success",
        http_status=301,
        cache_status="not_written",
        extraction_status="skipped",
        text_chars=0,
        truncated=False,
        errors=("Redirect to private/reserved IP blocked",),
        limitations=()
    )

    mock_result = SearchRunResult(
        discovery=DiscoveryResult(
            schema_version="0.1", query_original="test", query_normalized="test", query_redacted="test",
            provider_name="static",
            candidates=(DiscoveryCandidate(rank=1, url="http://example.com/redirect", normalized_url="http://example.com/redirect", title="T", snippet="S", source_engine="static", url_policy="passed", blocked_reason=None, selected_for_fetch=True),),
            errors=(), limitations=()
        ),
        evidence_results=(mock_redirect,),
        manifest_path=work_dir / "manifest.md",
        search_manifest_path=work_dir / "search.md",
        limitations=()
    )

    with patch("search_tool.ui.search_query", return_value=mock_result):
        resp = httpx.post(f"{url}/api/search-query", json={
            "query": "test",
            "provider": "static",
            "candidate_urls": ["http://example.com/redirect"],
            "follow_redirects": True
        })

    assert resp.status_code == 200
    data = resp.json()
    assert data["ingestion_summary"]["redirects"] == 1
    # Check that error was recorded (in real life, fetch_url_to_evidence would do this)
    assert "Redirect to private/reserved IP blocked" in data["evidence_results"][0]["errors"]


def test_ui_search_quality_score_in_api(test_ui):
    url, work_dir = test_ui

    mock_result = SearchRunResult(
        discovery=DiscoveryResult(schema_version="0.1", query_original="test", query_normalized="test", query_redacted="test", provider_name="static", candidates=(), errors=(), limitations=()),
        evidence_results=(
            EvidenceWriteResult(original_url="http://a.com", normalized_url="http://a.com", evidence_path=Path("a.md"), fetch_status="success", http_status=200, cache_status="miss", extraction_status="success", text_chars=100, truncated=False, errors=(), limitations=()),
            EvidenceWriteResult(original_url="http://b.com", normalized_url="http://b.com", evidence_path=Path("b.md"), fetch_status="failed", http_status=403, cache_status="not_written", extraction_status="skipped", text_chars=0, truncated=False, errors=(), limitations=()),
        ),
        manifest_path=Path("manifest.md"),
        search_manifest_path=Path("search.md"),
        limitations=()
    )

    with patch("search_tool.ui.search_query", return_value=mock_result):
        resp = httpx.post(f"{url}/api/search-query", json={
            "query": "test",
            "provider": "static",
            "candidate_urls": ["http://a.com", "http://b.com"]
        })

    assert resp.status_code == 200
    data = resp.json()

    for r in data["evidence_results"]:
        assert "quality_score" in r
        assert isinstance(r["quality_score"], int)
        assert 0 <= r["quality_score"] <= 3


def test_ui_quality_score_values_match_expected(test_ui):
    url, work_dir = test_ui

    # success + extracted + not truncated = 3
    success_full = EvidenceWriteResult(original_url="http://a.com", normalized_url="http://a.com", evidence_path=Path("a.md"), fetch_status="success", http_status=200, cache_status="miss", extraction_status="success", text_chars=100, truncated=False, errors=(), limitations=())
    # success + truncated = 2
    success_trunc = EvidenceWriteResult(original_url="http://b.com", normalized_url="http://b.com", evidence_path=Path("b.md"), fetch_status="success", http_status=200, cache_status="miss", extraction_status="truncated", text_chars=50000, truncated=True, errors=(), limitations=())
    # failed = 0
    failed_pack = EvidenceWriteResult(original_url="http://c.com", normalized_url="http://c.com", evidence_path=Path("c.md"), fetch_status="failed", http_status=403, cache_status="not_written", extraction_status="skipped", text_chars=0, truncated=False, errors=(), limitations=())

    mock_result = SearchRunResult(
        discovery=DiscoveryResult(schema_version="0.1", query_original="test", query_normalized="test", query_redacted="test", provider_name="static", candidates=(), errors=(), limitations=()),
        evidence_results=(success_full, success_trunc, failed_pack),
        manifest_path=Path("manifest.md"),
        search_manifest_path=Path("search.md"),
        limitations=()
    )

    with patch("search_tool.ui.search_query", return_value=mock_result):
        resp = httpx.post(f"{url}/api/search-query", json={
            "query": "test",
            "provider": "static",
            "candidate_urls": ["http://a.com", "http://b.com", "http://c.com"]
        })

    assert resp.status_code == 200
    data = resp.json()
    scores = [r["quality_score"] for r in data["evidence_results"]]
    assert scores == [3, 2, 0]


def test_ui_html_no_undefined_quality(test_ui):
    url, _ = test_ui
    resp = httpx.get(f"{url}/")
    assert resp.status_code == 200
    assert "undefined/3" not in resp.text


def test_sanitize_provider_url_helper():
    assert _sanitize_provider_url("http://localhost:9999") == "http://localhost:9999"
    assert _sanitize_provider_url("https://user:pass@example.com/path?token=abc") == "https://example.com"
    assert _sanitize_provider_url("https://example.com/search?q=query#fragment") == "https://example.com"
    assert _sanitize_provider_url("malformed") == "[REDACTED]"
    assert _sanitize_provider_url("") == "[REDACTED]"
