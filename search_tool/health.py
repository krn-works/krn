"""Health check: verify krn-search runtime dependencies."""

from __future__ import annotations

import json
import os
import time
from dataclasses import asdict, dataclass
from pathlib import Path


@dataclass(frozen=True)
class HealthCheck:
    name: str
    status: str
    message: str


@dataclass(frozen=True)
class HealthReport:
    schema_version: str
    checks: tuple[HealthCheck, ...]

    def overall_status(self) -> str:
        if any(c.status == "fail" for c in self.checks):
            return "fail"
        if any(c.status == "warn" for c in self.checks):
            return "degraded"
        return "ok"

    def to_json(self) -> str:
        d = asdict(self)
        d["overall"] = self.overall_status()
        return json.dumps(d, indent=2)

    def to_human(self) -> str:
        overall = self.overall_status()
        lines = [f"krn-search health: {overall}"]
        for c in self.checks:
            icon = {"ok": "+", "info": "~", "warn": "!", "fail": "x"}.get(c.status, "?")
            lines.append(f"  [{icon}] {c.name}: {c.message}")
        return "\n".join(lines)


def check_searxng_reachable(
    base_url: str,
    timeout: float = 1.0,
    retries: int = 8,
    retry_delay: float = 0.5,
) -> bool:
    """Check if a SearXNG instance is reachable. Uses raw httpx, not url_policy."""
    attempts = max(1, retries)
    try:
        import httpx
    except Exception:
        return False

    for attempt in range(attempts):
        try:
            with httpx.Client(trust_env=False, timeout=timeout) as client:
                resp = client.post(
                    base_url.rstrip("/") + "/search",
                    data={"q": "__health__", "format": "json"},
                )
                if resp.status_code == 200:
                    return True
        except Exception:
            pass

        if attempt < attempts - 1 and retry_delay > 0:
            time.sleep(retry_delay)

    return False


def wait_for_searxng_reachable(
    base_url: str,
    wait_seconds: float,
    *,
    poll_interval: float = 0.5,
) -> bool:
    """Poll SearXNG reachability until success or the wait window expires."""
    deadline = time.monotonic() + max(0.0, wait_seconds)
    while True:
        if check_searxng_reachable(base_url, retries=1, retry_delay=0):
            return True

        remaining = deadline - time.monotonic()
        if remaining <= 0:
            return False

        time.sleep(min(poll_interval, remaining))


def _check_dir_writable(dir_path: Path) -> HealthCheck:
    name = dir_path.name + "_writable"
    if not dir_path.exists():
        return HealthCheck(name=name, status="info", message=f"{dir_path} does not exist (will be created on first use)")
    try:
        test_file = dir_path / ".krn-health-check"
        test_file.write_text("ok", encoding="utf-8")
        test_file.unlink(missing_ok=True)
        return HealthCheck(name=name, status="ok", message=f"{dir_path} is writable")
    except PermissionError:
        return HealthCheck(name=name, status="fail", message=f"{dir_path} is not writable")
    except OSError as e:
        return HealthCheck(name=name, status="fail", message=f"{dir_path}: {e}")


def run_health_checks(
    work_dir: Path | None = None,
    *,
    research_mode: bool = False,
    searxng_url_override: str | None = None,
    searxng_wait_seconds: float = 0.0,
) -> HealthReport:
    checks: list[HealthCheck] = []

    # 1. Package import
    try:
        import search_tool  # noqa: F401
        checks.append(HealthCheck(name="package_import", status="ok", message="search_tool imported successfully"))
    except ImportError as e:
        checks.append(HealthCheck(name="package_import", status="fail", message=f"import failed: {e}"))

    # 2. Static provider
    try:
        from search_tool.discovery import StaticDiscoveryProvider
        StaticDiscoveryProvider(name="health", candidates=())
        checks.append(HealthCheck(name="static_provider", status="ok", message="StaticDiscoveryProvider available"))
    except ImportError as e:
        checks.append(HealthCheck(name="static_provider", status="fail", message=f"import failed: {e}"))

    # 3. SearXNG reachable
    env_value = os.environ.get("SEARXNG_URL", "").strip()
    if searxng_url_override:
        searxng_url = searxng_url_override
        searxng_source = "--searxng-url"
    elif env_value:
        searxng_url = env_value
        searxng_source = "SEARXNG_URL"
    else:
        searxng_url = "http://localhost:9999"
        searxng_source = "default"

    if research_mode and searxng_wait_seconds > 0:
        reachable = wait_for_searxng_reachable(searxng_url, searxng_wait_seconds)
    else:
        reachable = check_searxng_reachable(searxng_url)
    if reachable:
        if research_mode:
            reachable_msg = (
                f"SearXNG reachable at {searxng_url} (source: {searxng_source})"
                if searxng_source != "default"
                else f"SearXNG reachable at default {searxng_url} (SEARXNG_URL not set)"
            )
        else:
            reachable_msg = (
                f"SearXNG reachable at {searxng_url}"
                if searxng_source != "default"
                else f"SearXNG reachable at default {searxng_url} (SEARXNG_URL not set)"
            )
        checks.append(HealthCheck(name="searxng_reachable", status="ok", message=reachable_msg))
    else:
        if research_mode:
            checks.append(HealthCheck(
                name="searxng_reachable",
                status="fail",
                message=(
                    f"research mode requires SearXNG discovery, but SearXNG is unreachable "
                    f"at {searxng_url} (source: {searxng_source})."
                ),
            ))
        elif searxng_source == "default":
            checks.append(HealthCheck(
                name="searxng_reachable",
                status="info",
                message=f"SEARXNG_URL not configured and default SearXNG unreachable at {searxng_url} (optional, static provider works)",
            ))
        else:
            checks.append(HealthCheck(
                name="searxng_reachable",
                status="warn",
                message=f"SearXNG unreachable at {searxng_url} (source: {searxng_source}, live discovery unavailable)",
            ))

    # 4. Evidence dir writable
    if work_dir is not None:
        evidence_dir = work_dir / "evidence"
    else:
        from search_tool.evidence import EVIDENCE_DIR
        evidence_dir = EVIDENCE_DIR
    checks.append(_check_dir_writable(evidence_dir))

    # 5. Cache dir writable
    if work_dir is not None:
        cache_dir = work_dir / "cache" / "objects"
    else:
        from search_tool.cache import OBJECTS_DIR
        cache_dir = OBJECTS_DIR
    checks.append(_check_dir_writable(cache_dir))

    return HealthReport(schema_version="0.1", checks=tuple(checks))
