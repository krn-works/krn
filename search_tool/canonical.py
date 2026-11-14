"""Canonical URL normalization for candidate-level dedup.

Stricter than normalize_url(): strips tracking query params, collapses
duplicate path slashes, sorts retained params. Does NOT change cache
keying (that still uses normalize_url).
"""

from __future__ import annotations

from urllib.parse import urlparse, parse_qs, urlencode, urlunparse

# Exact-tracking param names to remove.
_TRACKING_EXACT = frozenset({
    "fbclid",
    "gclid",
    "msclkid",
    "mc_cid",
    "mc_eid",
    "igshid",
})

# Tracking param name prefix to remove.
_TRACKING_PREFIX = "utm_"

# Meaningful params to preserve even though they look like tracking.
_RETAINED_EXACT = frozenset({"ref", "source", "via"})


def canonicalize_url_for_dedup(url: str) -> str:
    """Return a canonical URL string for dedup comparison.

    Rules:
    - Lowercase scheme and host.
    - Remove default ports (80/http, 443/https).
    - Empty path -> "/".
    - Collapse duplicate slashes in path (not scheme).
    - Strip trailing slash (except root "/").
    - Strip fragment always.
    - Remove tracking query params (utm_*, fbclid, gclid, msclkid,
      mc_cid, mc_eid, igshid).
    - Preserve ref, source, via.
    - Sort retained query params deterministically.
    - Preserve repeated retained params.
    - Preserve path case.
    - Non http/https URLs passed through via urlparse + reconstruction;
      tracking param removal and sorting still apply.
    """
    try:
        parsed = urlparse(url)
    except Exception:
        return url

    scheme = parsed.scheme.lower()
    host = parsed.hostname.lower() if parsed.hostname else ""
    port = parsed.port

    # Remove default ports.
    if (scheme == "http" and port == 80) or (scheme == "https" and port == 443):
        port = None

    # Path: normalise empty, collapse slashes, strip trailing slash.
    path = parsed.path or "/"
    if not path.startswith("/"):
        path = "/" + path
    # Collapse duplicate slashes in path only.
    while "//" in path:
        path = path.replace("//", "/")
    if len(path) > 1 and path.endswith("/"):
        path = path.rstrip("/")

    # Query: remove tracking params, sort retained.
    query_string = parsed.query
    if query_string:
        query_string = _filter_and_sort_query(query_string)

    # Reconstruct without fragment.
    parts = (scheme, host, path, "", query_string, "")
    if port is not None:
        parts = (scheme, f"{host}:{port}", path, "", query_string, "")

    return urlunparse(parts)


def _filter_and_sort_query(query_string: str) -> str:
    """Remove tracking params, sort retained params deterministically.

    Handles repeated params (e.g. ?a=1&a=2) by preserving them in sorted
    order within their key group.
    """
    params = parse_qs(query_string, keep_blank_values=True)
    filtered: dict[str, list[str]] = {}

    for key, values in params.items():
        # Check exact match removal.
        if key in _TRACKING_EXACT:
            continue
        # Check prefix removal (but not if it's in retained set).
        if key in _RETAINED_EXACT:
            filtered[key] = list(values)
            continue
        if key.startswith(_TRACKING_PREFIX):
            continue
        # Preserve all other params.
        filtered[key] = list(values)

    # Sort by key, then by value within each key for determinism.
    sorted_parts = []
    for key in sorted(filtered.keys()):
        for value in sorted(filtered[key]):
            sorted_parts.append((key, value))

    if not sorted_parts:
        return ""
    return urlencode(sorted_parts)
