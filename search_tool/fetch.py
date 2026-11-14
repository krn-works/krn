"""Fetch: bounded HTTP client for retrieving remote content."""

from __future__ import annotations

import hashlib
from dataclasses import dataclass, field
from urllib.parse import urljoin, urlparse

import httpx

MAX_RESPONSE_BYTES = 10 * 1024 * 1024  # 10 MB
HTTP_TIMEOUT_SECONDS = 30.0
MAX_REDIRECTS = 3


def _redirect_safe_url(url: str) -> str:
    """Normalize a URL for redirect resolution.

    Strips fragments (not sent over HTTP), preserves trailing slashes
    to avoid false redirect-loop detection.
    """
    parsed = urlparse(url)
    scheme = parsed.scheme.lower()
    host = (parsed.hostname or "").lower()
    port = parsed.port
    if (scheme == "http" and port == 80) or (scheme == "https" and port == 443):
        port = None
    path = parsed.path or "/"
    if not path.startswith("/"):
        path = "/" + path
    result = f"{scheme}://{host}"
    if port is not None:
        result += f":{port}"
    result += path
    if parsed.query:
        result += f"?{parsed.query}"
    # Deliberately drop fragment
    return result


@dataclass
class FetchResult:
    status: str  # "success", "failed", "blocked"
    http_status: int | None = None
    content_type: str | None = None
    content_length_bytes: int | None = None
    body_bytes: bytes | None = None
    body_sha256: str | None = None
    redirects: list[dict] = field(default_factory=list)
    errors: list[str] = field(default_factory=list)
    limitations: list[str] = field(default_factory=list)


def fetch_url(url: str, *, follow_redirects: bool = False) -> FetchResult:
    """Fetch a URL with bounded client.

    When follow_redirects=False (default): does not follow redirects, records them.
    When follow_redirects=True: follows up to MAX_REDIRECTS hops with per-hop
    URL policy checks. Stops immediately if any redirect target is blocked.
    """
    if follow_redirects:
        return _fetch_with_redirects(url)

    return _fetch_single(url)


def _fetch_single(current_url: str) -> FetchResult:
    """Fetch a single URL without following redirects."""
    result = FetchResult(status="failed")

    try:
        with httpx.Client(
            trust_env=False,
            follow_redirects=False,
            timeout=HTTP_TIMEOUT_SECONDS,
        ) as client:
            with client.stream("GET", current_url) as response:
                result.http_status = response.status_code
                result.content_type = response.headers.get("content-type")

                if 300 <= response.status_code < 400:
                    location = response.headers.get("location", "")
                    safe_location = location
                    if len(safe_location) > 2048:
                        safe_location = safe_location[:2048] + "...(truncated)"
                    result.redirects.append({
                        "status": response.status_code,
                        "location": safe_location,
                    })
                    result.status = "success"
                    result.limitations.append(
                        "Redirect not followed (MVP-0 policy). Target URL not fetched."
                    )
                    response.close()
                    return result

                body_chunks = []
                total = 0
                for chunk in response.iter_bytes():
                    total += len(chunk)
                    if total > MAX_RESPONSE_BYTES:
                        result.errors.append(
                            f"Response exceeded {MAX_RESPONSE_BYTES} bytes, truncated at {total} bytes"
                        )
                        result.limitations.append(
                            "Response body truncated due to MAX_RESPONSE_BYTES limit."
                        )
                        break
                    body_chunks.append(chunk)

                body = b"".join(body_chunks)

    except httpx.TimeoutException:
        result.errors.append(f"Request timed out after {HTTP_TIMEOUT_SECONDS}s")
        result.limitations.append("Fetch timed out. Server may be slow or unreachable.")
        return result
    except httpx.ConnectError as e:
        result.errors.append(f"Connection error: {e}")
        return result
    except httpx.UnsupportedProtocol:
        result.errors.append("Unsupported protocol")
        return result
    except Exception as e:
        result.errors.append(f"Fetch error: {e}")
        return result

    sha = hashlib.sha256(body).hexdigest() if body else None

    result.body_bytes = body
    result.body_sha256 = sha
    result.content_length_bytes = len(body) if body else 0

    if 200 <= result.http_status < 300:
        result.status = "success"
    elif result.http_status is not None:
        result.status = "failed"
        result.errors.append(f"HTTP {result.http_status} response")
        result.limitations.append(
            f"Server returned HTTP {result.http_status}. Content may be incomplete or absent."
        )
    else:
        result.status = "failed"

    return result


def _fetch_with_redirects(original_url: str) -> FetchResult:
    """Follow redirects with per-hop policy checks, loop detection, depth limit."""
    from search_tool.url_policy import check_url, normalize_url

    def _redirect_key(url: str) -> str:
        """Redirect-safe normalization for loop detection (preserves trailing slash)."""
        return _redirect_safe_url(url)

    visited: set[str] = set()
    current_url = original_url
    all_hops: list[dict] = []

    for hop_index in range(MAX_REDIRECTS + 1):
        policy = check_url(current_url)
        if not policy.passed:
            if hop_index == 0:
                return FetchResult(
                    status="blocked",
                    errors=[policy.blocked_reason] if policy.blocked_reason else [],
                    limitations=[],
                )
            if all_hops:
                all_hops[-1]["blocked_reason"] = policy.blocked_reason
            return FetchResult(
                status="blocked",
                http_status=all_hops[-1]["status"] if all_hops else None,
                redirects=all_hops,
                errors=[f"redirect target blocked: {policy.blocked_reason}"] if policy.blocked_reason else [],
                limitations=[],
            )

        rkey = _redirect_key(current_url)
        if rkey in visited:
            return FetchResult(
                status="failed",
                http_status=all_hops[-1]["status"] if all_hops else None,
                redirects=all_hops,
                errors=["redirect loop detected"],
                limitations=[],
            )

        visited.add(rkey)

        result = _fetch_single(current_url)

        if result.status != "success" and not (300 <= (result.http_status or 0) < 400):
            if all_hops:
                result.redirects = all_hops + result.redirects
            return result

        if 300 <= (result.http_status or 0) < 400:
            location = result.redirects[-1]["location"] if result.redirects else ""
            if not location:
                return FetchResult(
                    status="failed",
                    http_status=result.http_status,
                    redirects=all_hops + result.redirects,
                    errors=["redirect response missing Location header"],
                    limitations=[],
                )

            resolved = urljoin(current_url, location)
            normalized_target = normalize_url(resolved)
            hop = result.redirects[-1]
            hop["from_url"] = current_url
            hop["resolved_url"] = normalized_target
            hop["blocked_reason"] = None
            all_hops.append(hop)
            current_url = _redirect_safe_url(resolved)
            continue

        # 2xx success
        if all_hops:
            result.redirects = all_hops
        return result

    # Exceeded max depth
    return FetchResult(
        status="failed",
        http_status=all_hops[-1]["status"] if all_hops else None,
        redirects=all_hops,
        errors=[f"redirect chain exceeded maximum depth of {MAX_REDIRECTS}"],
        limitations=[],
    )
