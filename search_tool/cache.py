"""Cache: SHA256-based filesystem cache for fetched content."""

from __future__ import annotations

import hashlib
import json
import os
import tempfile
from dataclasses import dataclass
from pathlib import Path

CACHE_DIR = Path("cache")
OBJECTS_DIR = CACHE_DIR / "objects"
ENTRIES_DIR = CACHE_DIR / "entries"


@dataclass
class CacheResult:
    status: str  # "miss", "hit", "bypass", "not_written"
    key: str | None = None
    body_cache_ref: str | None = None
    cached_body: bytes | None = None
    cached_metadata: dict | None = None


def _make_key(normalized_url: str, *, follow_redirects: bool = False, max_redirects: int = 3) -> str:
    """Create a SHA256-based cache key from URL and fetch config.

    Refresh is not part of the key — it bypasses cache, it does not define
    a different cached object identity.
    """
    config = {
        "url": normalized_url,
        "trust_env": False,
        "follow_redirects": follow_redirects,
        "max_redirects": max_redirects,
        "timeout": 30.0,
        "max_bytes": 10 * 1024 * 1024,
    }
    raw = json.dumps(config, sort_keys=True)
    return hashlib.sha256(raw.encode()).hexdigest()[:32]


def _body_ref(body: bytes) -> str:
    """SHA256 of body bytes."""
    return hashlib.sha256(body).hexdigest()


def ensure_dirs(cache_dir: Path | None = None) -> None:
    base = cache_dir or CACHE_DIR
    (base / "objects").mkdir(parents=True, exist_ok=True)
    (base / "entries").mkdir(parents=True, exist_ok=True)


def _resolve_dirs(cache_dir: Path | None = None) -> tuple[Path, Path]:
    base = cache_dir or CACHE_DIR
    return base / "objects", base / "entries"


def get(normalized_url: str, refresh: bool, *, follow_redirects: bool = False, max_redirects: int = 3, cache_dir: Path | None = None) -> CacheResult:
    """Check cache for a previous fetch. Returns CacheResult."""
    if refresh:
        return CacheResult(status="bypass", key=_make_key(normalized_url, follow_redirects=follow_redirects, max_redirects=max_redirects))

    key = _make_key(normalized_url, follow_redirects=follow_redirects, max_redirects=max_redirects)
    objects_dir, entries_dir = _resolve_dirs(cache_dir)
    entry_path = entries_dir / f"{key}.json"

    if not entry_path.exists():
        return CacheResult(status="miss", key=key)

    try:
        metadata = json.loads(entry_path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return CacheResult(status="miss", key=key)

    body_ref = metadata.get("body_ref")
    if not body_ref:
        return CacheResult(status="miss", key=key)

    body_path = objects_dir / body_ref
    if not body_path.exists():
        return CacheResult(status="miss", key=key)

    try:
        body = body_path.read_bytes()
    except OSError:
        return CacheResult(status="miss", key=key)

    return CacheResult(
        status="hit",
        key=key,
        body_cache_ref=body_ref,
        cached_body=body,
        cached_metadata=metadata,
    )


def put(
    normalized_url: str,
    body: bytes | None,
    metadata: dict,
    *,
    follow_redirects: bool = False,
    max_redirects: int = 3,
    cache_dir: Path | None = None,
) -> CacheResult:
    """Store fetch result in cache. Returns CacheResult."""
    ensure_dirs(cache_dir)

    if body is None:
        return CacheResult(status="not_written")

    key = _make_key(normalized_url, follow_redirects=follow_redirects, max_redirects=max_redirects)
    objects_dir, entries_dir = _resolve_dirs(cache_dir)
    ref = _body_ref(body)
    body_path = objects_dir / ref
    entry_path = entries_dir / f"{key}.json"

    # Write body atomically via temp file
    try:
        fd, tmp = tempfile.mkstemp(dir=str(objects_dir))
        try:
            os.write(fd, body)
        finally:
            os.close(fd)
        os.replace(tmp, str(body_path))
    except OSError:
        return CacheResult(status="not_written", key=key)

    # Write entry metadata
    entry_data = {
        "body_ref": ref,
        "url": normalized_url,
        "body_size": len(body),
    }
    entry_data.update(metadata)

    try:
        fd, tmp = tempfile.mkstemp(dir=str(entries_dir))
        try:
            os.write(fd, json.dumps(entry_data, sort_keys=True).encode("utf-8"))
        finally:
            os.close(fd)
        os.replace(tmp, str(entry_path))
    except OSError:
        return CacheResult(status="not_written", key=key, body_cache_ref=ref)

    return CacheResult(
        status="miss",
        key=key,
        body_cache_ref=ref,
        cached_body=body,
        cached_metadata=entry_data,
    )
