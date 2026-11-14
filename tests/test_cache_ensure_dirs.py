"""Tests for cache.ensure_dirs."""

from search_tool.cache import ensure_dirs


def test_ensure_dirs_creates_objects_and_entries_idempotently(tmp_path):
    base = tmp_path / "nested" / "cache"
    ensure_dirs(base)
    ensure_dirs(base)
    assert (base / "objects").is_dir()
    assert (base / "entries").is_dir()
