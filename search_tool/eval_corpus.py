"""Evaluation corpus runner for the search pipeline."""

from __future__ import annotations

import json
import socket
import tempfile
from collections.abc import Mapping
from dataclasses import dataclass, field
from pathlib import Path
from unittest.mock import patch, MagicMock

from search_tool.discovery import (
    DiscoveryCandidate,
    DiscoveryError,
    DiscoveryResult,
    RawDiscoveryCandidate,
    StaticDiscoveryProvider,
    SearxngDiscoveryProvider,
)
from search_tool.search import (
    search_query,
    EvidenceWriteResult,
    write_search_run_manifest,
)
from search_tool.run import (
    fetch_url_to_evidence,
    write_fetch_list_manifest,
)
from search_tool.fetch import FetchResult
from search_tool import extract


@dataclass
class ScenarioExpectations:
    discovery: dict[str, int] = field(default_factory=dict)
    fetch: dict[str, int] = field(default_factory=dict)
    manifests: dict[str, bool] = field(default_factory=dict)


@dataclass
class Scenario:
    id: str
    description: str
    query: str
    provider: str
    candidates: list[dict[str, str]] = field(default_factory=list)
    mock_responses: dict[str, dict] = field(default_factory=dict)
    expect: ScenarioExpectations = field(default_factory=ScenarioExpectations)
    force_discovery_error: dict[str, str] | None = None
    provider_config: dict[str, object] = field(default_factory=dict)
    follow_redirects: bool = False
    refresh: bool = False


@dataclass
class ScenarioResult:
    scenario_id: str
    status: str  # "PASS", "FAIL", "ERROR"
    message: str = ""
    checks: dict[str, str] = field(default_factory=dict)
    artifacts: dict[str, str] = field(default_factory=dict)


class MockFetcher:
    def __init__(self, mock_responses: dict[str, dict]):
        self.mock_responses = mock_responses
        self.call_log: list[str] = []

    def __call__(self, url: str, refresh: bool, follow_redirects: bool = False) -> EvidenceWriteResult:
        self.call_log.append(url)
        
        # Use a real fetch_url_to_evidence but patch the underlying fetch_url
        with patch("search_tool.run.fetch_url") as mock_fetch:
            if url in self.mock_responses:
                resp = self.mock_responses[url]
                status_code = resp.get("status_code", 200)
                
                # Simulate redirect following if requested
                if follow_redirects and 300 <= status_code < 400 and "headers" in resp and "Location" in resp["headers"]:
                    target_url = resp["headers"]["Location"]
                    # For simplicity, we only follow one hop in mock
                    # and we check policy for the target
                    from search_tool.url_policy import check_url
                    policy = check_url(target_url)
                    if not policy.passed:
                        mock_fetch.return_value = FetchResult(
                            status="blocked",
                            http_status=status_code,
                            redirects=[{"status": status_code, "location": target_url, "resolved_url": target_url, "blocked_reason": policy.blocked_reason}],
                            errors=[f"redirect target blocked: {policy.blocked_reason}"],
                        )
                    else:
                        # Follow to target if it exists in mocks
                        if target_url in self.mock_responses:
                            target_resp = self.mock_responses[target_url]
                            mock_fetch.return_value = FetchResult(
                                status="success" if target_resp.get("status_code", 200) < 400 else "failed",
                                http_status=target_resp.get("status_code", 200),
                                content_type=target_resp.get("content_type", "text/html"),
                                body_bytes=target_resp.get("body", "").encode("utf-8"),
                                body_sha256="fake_sha",
                                redirects=[{"status": status_code, "location": target_url, "resolved_url": target_url}],
                                errors=[],
                            )
                        else:
                            mock_fetch.return_value = FetchResult(
                                status="failed",
                                http_status=404,
                                redirects=[{"status": status_code, "location": target_url, "resolved_url": target_url}],
                                errors=["404 Not Found"],
                            )
                else:
                    mock_fetch.return_value = FetchResult(
                        status="success" if status_code < 400 else "failed",
                        http_status=status_code,
                        content_type=resp.get("content_type", "text/html"),
                        body_bytes=resp.get("body", "").encode("utf-8"),
                        body_sha256="fake_sha",
                        redirects=[{"status": status_code, "location": resp["headers"]["Location"]}] if "headers" in resp and "Location" in resp["headers"] else [],
                        errors=[],
                        limitations=[]
                    )
            else:
                # Default 404 for unknown URLs in mocks
                mock_fetch.return_value = FetchResult(
                    status="failed",
                    http_status=404,
                    content_type="text/plain",
                    body_bytes=b"Not Found",
                    body_sha256="fake_sha",
                    errors=["404 Not Found"],
                    limitations=[]
                )
            
            return fetch_url_to_evidence(url, refresh, follow_redirects)


def run_scenario(scenario: Scenario, work_dir: Path | None = None) -> ScenarioResult:
    """Run a single evaluation scenario."""
    from contextlib import contextmanager

    @contextmanager
    def get_work_path():
        if work_dir:
            # Ensure scenario-specific subfolder to avoid collisions
            path = work_dir / scenario.id
            path.mkdir(parents=True, exist_ok=True)
            yield path
        else:
            with tempfile.TemporaryDirectory() as tmp_dir:
                yield Path(tmp_dir)

    with get_work_path() as tmp_path:
        evidence_dir = tmp_path / "evidence"
        evidence_dir.mkdir(exist_ok=True)

        # Mock dependencies and directories
        with patch("search_tool.search.EVIDENCE_DIR", evidence_dir), \
             patch("search_tool.evidence.EVIDENCE_DIR", evidence_dir), \
             patch("search_tool.run.EVIDENCE_DIR", evidence_dir), \
             patch("search_tool.run.cache_get") as mock_cache_get, \
             patch("search_tool.run.cache_put") as mock_cache_put, \
             patch("search_tool.run.fetch_url") as mock_fetch, \
             patch("search_tool.url_policy.socket.getaddrinfo") as mock_dns:
            
            # Disable cache
            mock_cache_get.return_value = MagicMock(status="miss")
            
            # DNS mock: resolve most to public, but preserve private IPs for policy tests
            def dns_side_effect(host, *args, **kwargs):
                if host in ("127.0.0.1", "192.168.1.1", "10.0.0.1"):
                    return [(socket.AF_INET, socket.SOCK_STREAM, 6, "", (host, 0))]
                return [(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("93.184.216.34", 0))]
            mock_dns.side_effect = dns_side_effect

            # Fetch mock side effect
            def fetch_side_effect(url, follow_redirects=False):
                if url in scenario.mock_responses:
                    resp = scenario.mock_responses[url]
                    status_code = resp.get("status_code", 200)
                    
                    if follow_redirects and 300 <= status_code < 400 and "headers" in resp and "Location" in resp["headers"]:
                        target_url = resp["headers"]["Location"]
                        from search_tool.url_policy import check_url
                        policy = check_url(target_url)
                        if not policy.passed:
                            return FetchResult(
                                status="blocked",
                                http_status=status_code,
                                redirects=[{"status": status_code, "location": target_url, "resolved_url": target_url, "blocked_reason": policy.blocked_reason}],
                                errors=[f"redirect target blocked: {policy.blocked_reason}"],
                            )
                        # Recursive follow if in mocks
                        return fetch_side_effect(target_url, follow_redirects=True)
                    
                    return FetchResult(
                        status="success" if status_code < 400 else "failed",
                        http_status=status_code,
                        content_type=resp.get("content_type", "text/html"),
                        body_bytes=resp.get("body", "").encode("utf-8"),
                        body_sha256="fake_sha",
                        redirects=[{"status": status_code, "location": resp["headers"]["Location"]}] if "headers" in resp and "Location" in resp["headers"] else [],
                        errors=[],
                        limitations=[]
                    )
                return FetchResult(status="failed", http_status=404, errors=["404 Not Found"])
            
            mock_fetch.side_effect = fetch_side_effect

            # Setup provider
            if scenario.force_discovery_error:
                provider = MagicMock()
                provider.name = scenario.provider
                provider.discover.return_value = DiscoveryResult(
                    schema_version="0.1",
                    query_original=scenario.query,
                    query_normalized=scenario.query,
                    query_redacted=scenario.query,
                    provider_name=scenario.provider,
                    candidates=(),
                    errors=(DiscoveryError(**scenario.force_discovery_error),),
                    limitations=("Forced error",)
                )
            elif scenario.provider == "static":
                raw_candidates = [
                    RawDiscoveryCandidate(**c) for c in scenario.candidates
                ]
                provider = StaticDiscoveryProvider(name="static", candidates=tuple(raw_candidates))
            elif scenario.provider == "searxng":
                # For searxng in corpus, we still use a mock if not live
                # but corpus usually uses static for determinism
                provider = StaticDiscoveryProvider(name="searxng", candidates=tuple(
                    RawDiscoveryCandidate(**c) for c in scenario.candidates
                ))
            else:
                return ScenarioResult(scenario.id, "ERROR", f"Unknown provider: {scenario.provider}")

            fetcher = fetch_url_to_evidence
            
            # Handle truncation limit
            with patch("search_tool.extract.MAX_EXTRACTED_CHARS", 10 if scenario.id == "extraction_truncated" else extract.MAX_EXTRACTED_CHARS):
                result = search_query(
                    provider=provider,
                    query=scenario.query,
                    fetcher=fetcher,
                    manifest_writer=write_fetch_list_manifest,
                    search_manifest_writer=write_search_run_manifest,
                    provider_config=scenario.provider_config or {"max_candidates": 10},
                    follow_redirects=scenario.follow_redirects,
                    refresh=scenario.refresh,
                )

            # Assertions
            checks = {}
            status = "PASS"
            
            exp = scenario.expect
            
            # Discovery checks
            if exp.discovery:
                disc = result.discovery
                actual_total = len(disc.candidates)
                actual_selected = sum(1 for c in disc.candidates if c.selected_for_fetch)
                actual_blocked = sum(1 for c in disc.candidates if c.url_policy == "blocked")
                actual_duplicates = sum(1 for c in disc.candidates if c.duplicate_of is not None)
                actual_errors = len(disc.errors)

                for k, v in exp.discovery.items():
                    actual = {
                        "total": actual_total,
                        "selected": actual_selected,
                        "blocked": actual_blocked,
                        "duplicates": actual_duplicates,
                        "errors": actual_errors
                    }.get(k)
                    # Skip special keys handled separately
                    if k == "collapsed_duplicates_in_limitations":
                        continue
                    if actual != v:
                        status = "FAIL"
                        checks[f"discovery_{k}"] = f"FAIL (expected {v}, got {actual})"
                    else:
                        checks[f"discovery_{k}"] = "PASS"

                # Special check: collapsed_duplicates_in_limitations
                if exp.discovery.get("collapsed_duplicates_in_limitations"):
                    has_collapsed = any(
                        "collapsed" in lim.lower() and "duplicate" in lim.lower() and "canonical" in lim.lower()
                        for lim in disc.limitations
                    )
                    if has_collapsed:
                        checks["discovery_collapsed_duplicates_in_limitations"] = "PASS"
                    else:
                        status = "FAIL"
                        checks["discovery_collapsed_duplicates_in_limitations"] = "FAIL (expected limitations mention, got none)"

            # Fetch checks
            if exp.fetch:
                actual_succeeded = sum(1 for r in result.evidence_results if r.fetch_status == "success" and r.extraction_status in ("success", "truncated"))
                actual_failed = sum(1 for r in result.evidence_results if r.fetch_status == "failed" or (r.fetch_status == "success" and r.extraction_status in ("failed", "skipped")))
                actual_blocked = sum(1 for r in result.evidence_results if r.fetch_status == "blocked")
                actual_skipped = sum(1 for r in result.evidence_results if r.fetch_status == "skipped_duplicate")
                actual_evidence = len(result.evidence_results)
                actual_truncated = sum(1 for r in result.evidence_results if r.truncated)

                for k, v in exp.fetch.items():
                    actual = {
                        "succeeded": actual_succeeded,
                        "failed": actual_failed,
                        "blocked": actual_blocked,
                        "skipped_duplicates": actual_skipped,
                        "evidence_packs": actual_evidence,
                        "truncated": actual_truncated
                    }.get(k)
                    if actual != v:
                        status = "FAIL"
                        details = [f"r.fetch_status={r.fetch_status}, r.extraction_status={r.extraction_status}, r.truncated={r.truncated}" for r in result.evidence_results]
                        checks[f"fetch_{k}"] = f"FAIL (expected {v}, got {actual}) [{'; '.join(details)}]"
                    else:
                        checks[f"fetch_{k}"] = "PASS"

            # Manifest checks
            if exp.manifests:
                if result.search_manifest_path and result.search_manifest_path.exists():
                    manifest_content = result.search_manifest_path.read_text()
                    
                    if exp.manifests.get("query_redacted"):
                        if "[REDACTED]" in manifest_content:
                            checks["manifest_redaction"] = "PASS"
                        else:
                            status = "FAIL"
                            checks["manifest_redaction"] = "FAIL (no [REDACTED] found)"
                    
                    if exp.manifests.get("contains_secret") is False:
                        if "sk-1234567890abcdef" in manifest_content:
                            status = "FAIL"
                            checks["manifest_no_secret"] = "FAIL (secret leaked)"
                        else:
                            checks["manifest_no_secret"] = "PASS"

                    if exp.manifests.get("contains_password") is False:
                        if "user:pass" in manifest_content:
                            status = "FAIL"
                            checks["manifest_no_password"] = "FAIL (password leaked)"
                        else:
                            checks["manifest_no_password"] = "PASS"

            return ScenarioResult(
                scenario_id=scenario.id,
                status=status,
                checks=checks,
                artifacts={
                    "search_manifest": str(result.search_manifest_path) if result.search_manifest_path else "",
                    "fetch_manifest": str(result.manifest_path) if result.manifest_path else ""
                }
            )


def run_corpus(corpus_path: Path, work_dir: Path | None = None) -> list[ScenarioResult]:
    """Load and run a corpus of scenarios."""
    try:
        data = json.loads(corpus_path.read_text())
    except Exception as e:
        return [ScenarioResult("loading", "ERROR", f"Failed to load corpus: {e}")]

    if "schema_version" not in data:
        return [ScenarioResult("validation", "ERROR", "Missing 'schema_version' in corpus")]
    
    if "scenarios" not in data or not isinstance(data["scenarios"], list):
        return [ScenarioResult("validation", "ERROR", "Missing or invalid 'scenarios' list in corpus")]

    results = []
    for s_data in data.get("scenarios", []):
        # Convert dict to Scenario objects
        expect_data = s_data.pop("expect", {})
        expect = ScenarioExpectations(**expect_data)
        scenario = Scenario(expect=expect, **s_data)
        
        try:
            results.append(run_scenario(scenario, work_dir=work_dir))
        except Exception as e:
            results.append(ScenarioResult(scenario.id, "ERROR", f"Runtime error: {e}"))
            
    return results
