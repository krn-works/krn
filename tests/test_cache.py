"""Tests for filesystem cache — no live internet."""

import json

import pytest

from search_tool import cache as cache_mod
from search_tool.cache import (
    get as cache_get,
    put as cache_put,
    _make_key,
    _body_ref,
)


@pytest.fixture(autouse=True)
def temp_cache_dir(tmp_path, monkeypatch):
    """Redirect cache dirs to a temp directory."""
    objects_dir = tmp_path / "cache" / "objects"
    entries_dir = tmp_path / "cache" / "entries"
    objects_dir.mkdir(parents=True)
    entries_dir.mkdir(parents=True)
    monkeypatch.setattr(cache_mod, "CACHE_DIR", tmp_path / "cache")
    monkeypatch.setattr(cache_mod, "OBJECTS_DIR", objects_dir)
    monkeypatch.setattr(cache_mod, "ENTRIES_DIR", entries_dir)


def _objects_dir():
    return cache_mod.OBJECTS_DIR


def _entries_dir():
    return cache_mod.ENTRIES_DIR


class TestCacheKey:
    def test_same_url_same_key(self):
        k1 = _make_key("https://example.com/")
        k2 = _make_key("https://example.com/")
        assert k1 == k2

    def test_different_url_different_key(self):
        k1 = _make_key("https://example.com/")
        k2 = _make_key("https://other.com/")
        assert k1 != k2

    def test_url_path_not_filesystem_path(self):
        """Cache key should be a hash, not derived from URL path."""
        key = _make_key("https://example.com/path/to/file")
        assert "/" not in key
        assert len(key) == 32

    def test_query_string_changes_key(self):
        k1 = _make_key("https://example.com/docs?page=1")
        k2 = _make_key("https://example.com/docs?page=2")
        assert k1 != k2

    def test_port_changes_key(self):
        k1 = _make_key("https://example.com/")
        k2 = _make_key("https://example.com:8080/")
        assert k1 != k2

    def test_refresh_not_in_key(self):
        """Refresh should not affect the key identity."""
        k1 = _make_key("https://example.com/")
        # _make_key no longer accepts refresh param
        k2 = _make_key("https://example.com/")
        assert k1 == k2

    def test_follow_redirects_default_preserves_key(self):
        """follow_redirects=False (default) should produce same key as before."""
        k1 = _make_key("https://example.com/")
        k2 = _make_key("https://example.com/", follow_redirects=False)
        assert k1 == k2

    def test_follow_redirects_true_changes_key(self):
        """follow_redirects=True should produce a different key."""
        k1 = _make_key("https://example.com/")
        k2 = _make_key("https://example.com/", follow_redirects=True)
        assert k1 != k2

    def test_max_redirects_changes_key(self):
        """Different max_redirects should produce a different key."""
        k1 = _make_key("https://example.com/", follow_redirects=True, max_redirects=3)
        k2 = _make_key("https://example.com/", follow_redirects=True, max_redirects=5)
        assert k1 != k2

    def test_max_redirects_equals_fetch_constant(self):
        """Cache key with max_redirects=MAX_REDIRECTS should match the key produced by the fetch config."""
        from search_tool.fetch import MAX_REDIRECTS
        k1 = _make_key("https://example.com/", follow_redirects=True, max_redirects=MAX_REDIRECTS)
        k2 = _make_key("https://example.com/", follow_redirects=True, max_redirects=3)
        assert k1 == k2


class TestCacheMiss:
    def test_first_run_miss(self):
        result = cache_get("https://example.com/", False)
        assert result.status == "miss"
        assert result.cached_body is None


class TestCacheHit:
    def test_second_run_hit(self):
        url = "https://example.com/"
        body = b"hello world"
        cache_put(url, body, {"http_status": 200})
        result = cache_get(url, False)
        assert result.status == "hit"
        assert result.cached_body == body


class TestCacheRefresh:
    def test_refresh_bypass(self):
        url = "https://example.com/"
        cache_put(url, b"old data", {"http_status": 200})
        result = cache_get(url, True)
        assert result.status == "bypass"

    def test_refresh_bypass_still_produces_key(self):
        url = "https://example.com/"
        result = cache_get(url, True)
        assert result.key is not None
        assert result.status == "bypass"


class TestCacheBodyRef:
    def test_body_ref_is_sha256(self):
        ref = _body_ref(b"hello")
        assert len(ref) == 64


class TestCacheAtomic:
    def test_put_creates_files(self):
        cache_put("https://example.com/", b"data", {"http_status": 200})
        key = _make_key("https://example.com/")
        entry_path = _entries_dir() / f"{key}.json"
        assert entry_path.exists()
        metadata = json.loads(entry_path.read_text())
        assert metadata["body_size"] == 4

        ref = _body_ref(b"data")
        body_path = _objects_dir() / ref
        assert body_path.exists()
        assert body_path.read_bytes() == b"data"


class TestCacheCorruptedEntry:
    def test_corrupted_json_returns_miss(self):
        cache_put("https://example.com/", b"valid data", {})
        key = _make_key("https://example.com/")
        entry_path = _entries_dir() / f"{key}.json"
        entry_path.write_text("not json {{{")
        result = cache_get("https://example.com/", False)
        assert result.status == "miss"


class TestCacheMissingBody:
    def test_missing_body_returns_miss(self):
        cache_put("https://example.com/", b"valid data", {})
        key = _make_key("https://example.com/")
        entry_path = _entries_dir() / f"{key}.json"
        metadata = json.loads(entry_path.read_text())
        body_path = _objects_dir() / metadata["body_ref"]
        body_path.unlink()
        result = cache_get("https://example.com/", False)
        assert result.status == "miss"


def test_ensure_dirs_creates_objects_and_entries(tmp_path):
    base = tmp_path / "fresh_cache"
    cache_mod.ensure_dirs(base)
    assert (base / "objects").is_dir()
    assert (base / "entries").is_dir()
    # idempotent
    cache_mod.ensure_dirs(base)
