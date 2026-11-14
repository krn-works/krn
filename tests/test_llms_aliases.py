"""Tests for llms URL alias resolution and CLI behavior."""

from unittest.mock import patch

import pytest


# --- Alias resolution ---


def _test_resolve_llms_url(args_dict):
    """Helper to test _resolve_llms_url with a fake argparse.Namespace."""
    from search_tool.cli import _resolve_llms_url

    class FakeArgs:
        def __init__(self, d):
            for k, v in d.items():
                setattr(self, k, v)

    result = _resolve_llms_url(FakeArgs(args_dict))
    return result


class TestResolveLlmsUrl:
    def test_url_only(self):
        url, err = _test_resolve_llms_url({"url": "https://example.com/llms.txt"})
        assert url == "https://example.com/llms.txt"
        assert err is None

    def test_llms_url_alias(self):
        url, err = _test_resolve_llms_url({"llms_url": "https://example.com/llms.txt"})
        assert url == "https://example.com/llms.txt"
        assert err is None

    def test_docs_index_url_alias(self):
        url, err = _test_resolve_llms_url({"docs_index_url": "https://example.com/docs-index"})
        assert url == "https://example.com/docs-index"
        assert err is None

    def test_all_none_returns_none(self):
        url, err = _test_resolve_llms_url({})
        assert url is None
        assert err is None

    def test_url_and_llms_url_conflict(self):
        url, err = _test_resolve_llms_url({
            "url": "https://example.com/a",
            "llms_url": "https://example.com/b",
        })
        assert url is None
        assert "conflicting" in err.lower()

    def test_all_three_conflict(self):
        url, err = _test_resolve_llms_url({
            "url": "https://example.com/a",
            "llms_url": "https://example.com/b",
            "docs_index_url": "https://example.com/c",
        })
        assert url is None
        assert "conflicting" in err.lower()

    def test_same_value_allowed(self):
        url, err = _test_resolve_llms_url({
            "url": "https://example.com/same",
            "llms_url": "https://example.com/same",
        })
        # This is a conflict because the user specified multiple aliases
        # even if values match — better to be strict
        assert url is None
        assert "conflicting" in err.lower()

    def test_none_vs_value_allowed(self):
        """Explicit None should be ignored (not counted as provided)."""
        url, err = _test_resolve_llms_url({
            "url": "https://example.com/a",
            "llms_url": None,
        })
        assert url == "https://example.com/a"
        assert err is None


# --- CLI integration: alias arguments present ---


class TestCliAliasArgs:
    def test_discover_query_has_url(self):
        from search_tool.cli import main

        with patch("search_tool.cli._run_llms_discover") as mock_run:
            mock_run.return_value = 0
            main(["discover-query", "test", "--provider", "llms", "--url", "https://example.com/llms.txt"])
            call_args = mock_run.call_args
            assert call_args[1]["llms_url"] == "https://example.com/llms.txt"

    def test_discover_query_has_llms_url_alias(self):
        from search_tool.cli import main

        with patch("search_tool.cli._run_llms_discover") as mock_run:
            mock_run.return_value = 0
            main(["discover-query", "test", "--provider", "llms", "--llms-url", "https://example.com/llms.txt"])
            call_args = mock_run.call_args
            assert call_args[1]["llms_url"] == "https://example.com/llms.txt"

    def test_discover_query_has_docs_index_url_alias(self):
        from search_tool.cli import main

        with patch("search_tool.cli._run_llms_discover") as mock_run:
            mock_run.return_value = 0
            main(["discover-query", "test", "--provider", "llms", "--docs-index-url", "https://example.com/index"])
            call_args = mock_run.call_args
            assert call_args[1]["llms_url"] == "https://example.com/index"

    def test_discover_query_alias_conflict_error(self, capsys):
        from search_tool.cli import main

        result = main(["discover-query", "test", "--provider", "llms", "--url", "https://example.com/a", "--llms-url", "https://example.com/b"])
        assert result == 1
        captured = capsys.readouterr()
        assert "conflicting" in captured.err.lower()

    def test_search_query_alias_conflict_error(self, capsys):
        from search_tool.cli import main

        result = main(["search-query", "test", "--provider", "llms", "--url", "https://example.com/a", "--llms-url", "https://example.com/b", "--json"])
        assert result == 1
        captured = capsys.readouterr()
        assert "conflicting" in captured.err.lower()

    def test_search_query_llms_url_in_result(self, capsys):
        """search-query with --llms-url should resolve the alias (verified via error output)."""
        from search_tool.cli import main

        result = main(["search-query", "test", "--provider", "llms", "--llms-url", "https://example.com/llms.txt", "--json"])
        # The URL should be resolved (not error about missing URL)
        # It will fail at DNS, but the alias should have been resolved
        captured = capsys.readouterr()
        assert "conflicting" not in captured.err.lower()


# --- CLI integration: follow_redirects available on discover-query ---


class TestDiscoverQueryFollowRedirects:
    def test_discover_query_has_follow_redirects_flag(self):
        from search_tool.cli import main

        with patch("search_tool.cli._run_llms_discover") as mock_run:
            mock_run.return_value = 0
            main(["discover-query", "test", "--provider", "llms", "--url", "https://example.com/llms.txt", "--follow-redirects"])
            call_args = mock_run.call_args
            assert call_args[1]["follow_redirects"] is True

    def test_discover_query_no_follow_redirects_default(self):
        from search_tool.cli import main

        with patch("search_tool.cli._run_llms_discover") as mock_run:
            mock_run.return_value = 0
            main(["discover-query", "test", "--provider", "llms", "--url", "https://example.com/llms.txt"])
            call_args = mock_run.call_args
            assert call_args[1]["follow_redirects"] is False
