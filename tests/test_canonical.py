"""Tests for search_tool.canonical — canonicalize_url_for_dedup."""

from search_tool.canonical import canonicalize_url_for_dedup


class TestLowercaseSchemeHost:
    def test_https_uppercase(self):
        assert canonicalize_url_for_dedup("HTTPS://EXAMPLE.COM/page") == "https://example.com/page"

    def test_http_uppercase(self):
        assert canonicalize_url_for_dedup("HTTP://EXAMPLE.COM/page") == "http://example.com/page"

    def test_mixed_case_host(self):
        assert canonicalize_url_for_dedup("https://ExAmPlE.CoM/page") == "https://example.com/page"


class TestDefaultPortRemoval:
    def test_https_443(self):
        assert canonicalize_url_for_dedup("https://example.com:443/") == "https://example.com/"

    def test_http_80(self):
        assert canonicalize_url_for_dedup("http://example.com:80/") == "http://example.com/"

    def test_http_80_no_trailing(self):
        assert canonicalize_url_for_dedup("http://example.com:80/path") == "http://example.com/path"


class TestNonDefaultPortPreserved:
    def test_https_8443(self):
        assert canonicalize_url_for_dedup("https://example.com:8443/") == "https://example.com:8443/"

    def test_http_8080(self):
        assert canonicalize_url_for_dedup("http://example.com:8080/path") == "http://example.com:8080/path"


class TestEmptyPathNormalized:
    def test_no_path(self):
        assert canonicalize_url_for_dedup("https://example.com") == "https://example.com/"

    def test_empty_path_slash(self):
        assert canonicalize_url_for_dedup("https://example.com/") == "https://example.com/"


class TestDuplicateSlashCollapse:
    def test_double_slash(self):
        assert canonicalize_url_for_dedup("https://example.com//a//b") == "https://example.com/a/b"

    def test_triple_slash(self):
        assert canonicalize_url_for_dedup("https://example.com///a") == "https://example.com/a"

    def test_multiple_double_slashes(self):
        assert canonicalize_url_for_dedup("https://example.com/a//b//c") == "https://example.com/a/b/c"


class TestTrailingSlashStripped:
    def test_trailing_slash_removed(self):
        assert canonicalize_url_for_dedup("https://example.com/docs/") == "https://example.com/docs"

    def test_root_slash_preserved(self):
        assert canonicalize_url_for_dedup("https://example.com/") == "https://example.com/"

    def test_no_trailing_slash_unchanged(self):
        assert canonicalize_url_for_dedup("https://example.com/docs") == "https://example.com/docs"


class TestFragmentStripped:
    def test_fragment_removed(self):
        assert canonicalize_url_for_dedup("https://example.com/page#section") == "https://example.com/page"

    def test_fragment_with_params(self):
        assert canonicalize_url_for_dedup("https://example.com/page?a=1#top") == "https://example.com/page?a=1"

    def test_no_fragment_unchanged(self):
        assert canonicalize_url_for_dedup("https://example.com/page") == "https://example.com/page"


class TestTrackingParamRemoval:
    def test_utm_source(self):
        assert canonicalize_url_for_dedup("https://example.com/page?utm_source=foo") == "https://example.com/page"

    def test_utm_campaign(self):
        assert canonicalize_url_for_dedup("https://example.com/page?utm_campaign=bar") == "https://example.com/page"

    def test_multiple_utm_params(self):
        assert canonicalize_url_for_dedup("https://example.com/page?utm_source=foo&utm_campaign=bar&utm_term=baz") == "https://example.com/page"

    def test_fbclid(self):
        assert canonicalize_url_for_dedup("https://example.com/page?fbclid=123") == "https://example.com/page"

    def test_gclid(self):
        assert canonicalize_url_for_dedup("https://example.com/page?gclid=xyz") == "https://example.com/page"

    def test_msclkid(self):
        assert canonicalize_url_for_dedup("https://example.com/page?msclkid=abc") == "https://example.com/page"

    def test_mc_cid(self):
        assert canonicalize_url_for_dedup("https://example.com/page?mc_cid=def") == "https://example.com/page"

    def test_mc_eid(self):
        assert canonicalize_url_for_dedup("https://example.com/page?mc_eid=ghi") == "https://example.com/page"

    def test_igshid(self):
        assert canonicalize_url_for_dedup("https://example.com/page?igshid=jkl") == "https://example.com/page"

    def test_utm_id(self):
        assert canonicalize_url_for_dedup("https://example.com/page?utm_id=123") == "https://example.com/page"

    def test_mixed_tracking_and_retained(self):
        result = canonicalize_url_for_dedup("https://example.com/page?utm_source=foo&ref=bar")
        assert result == "https://example.com/page?ref=bar"


class TestRetainedParamsPreserved:
    def test_ref_preserved(self):
        assert canonicalize_url_for_dedup("https://example.com/page?ref=foo") == "https://example.com/page?ref=foo"

    def test_source_preserved(self):
        assert canonicalize_url_for_dedup("https://example.com/page?source=bar") == "https://example.com/page?source=bar"

    def test_via_preserved(self):
        assert canonicalize_url_for_dedup("https://example.com/page?via=baz") == "https://example.com/page?via=baz"


class TestRetainedParamsSorted:
    def test_params_sorted_alphabetically(self):
        assert canonicalize_url_for_dedup("https://example.com/page?z=1&a=2") == "https://example.com/page?a=2&z=1"

    def test_params_sorted_with_retained_and_tracking(self):
        result = canonicalize_url_for_dedup("https://example.com/page?z=1&a=2&utm_source=foo&ref=bar")
        assert result == "https://example.com/page?a=2&ref=bar&z=1"

    def test_empty_query_after_removal(self):
        result = canonicalize_url_for_dedup("https://example.com/page?utm_source=foo&gclid=123")
        assert result == "https://example.com/page"


class TestRepeatedParams:
    def test_repeated_retained_params_preserved_and_sorted(self):
        result = canonicalize_url_for_dedup("https://example.com/page?a=2&a=1")
        assert result == "https://example.com/page?a=1&a=2"

    def test_repeated_different_keys_preserved(self):
        result = canonicalize_url_for_dedup("https://example.com/page?b=1&a=2&a=1")
        assert result == "https://example.com/page?a=1&a=2&b=1"


class TestPathCasePreserved:
    def test_uppercase_path_preserved(self):
        assert canonicalize_url_for_dedup("https://example.com/Docs/Guide") == "https://example.com/Docs/Guide"

    def test_mixed_case_path_preserved(self):
        assert canonicalize_url_for_dedup("https://example.com/docs/MyPage.html") == "https://example.com/docs/MyPage.html"


class TestNonHttpPassthrough:
    def test_file_scheme_passed_through(self):
        result = canonicalize_url_for_dedup("file:///etc/passwd")
        assert result == "file:///etc/passwd"

    def test_file_scheme_with_tracking_removed(self):
        result = canonicalize_url_for_dedup("file:///etc/passwd?utm_foo=1")
        assert result == "file:///etc/passwd"


class TestCombined:
    def test_full_normalization(self):
        url = "HTTPS://Example.COM:443/Docs//Guide/?utm_source=foo&ref=bar#top"
        result = canonicalize_url_for_dedup(url)
        assert result == "https://example.com/Docs/Guide?ref=bar"

    def test_only_tracking_params(self):
        url = "https://example.com/page?utm_source=foo&gclid=123&fbclid=456"
        result = canonicalize_url_for_dedup(url)
        assert result == "https://example.com/page"

    def test_no_changes_needed(self):
        url = "https://example.com/docs/guide"
        result = canonicalize_url_for_dedup(url)
        assert result == "https://example.com/docs/guide"
