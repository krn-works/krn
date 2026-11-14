"""Tests for fetch module using mocked HTTP — no live internet."""

from unittest.mock import patch, MagicMock

import httpx

from search_tool.fetch import fetch_url, MAX_RESPONSE_BYTES, HTTP_TIMEOUT_SECONDS, MAX_REDIRECTS


def _mock_stream_response(status_code, headers, body_chunks=None):
    """Build a mock httpx Client that streams a response."""
    mock_client = MagicMock()
    mock_response = MagicMock()
    mock_response.status_code = status_code
    mock_response.headers = headers
    mock_response.iter_bytes.return_value = iter(body_chunks or [])
    mock_ctx = MagicMock()
    mock_ctx.__enter__ = MagicMock(return_value=mock_response)
    mock_ctx.__exit__ = MagicMock(return_value=False)
    mock_client.stream.return_value = mock_ctx
    mock_client.__enter__ = MagicMock(return_value=mock_client)
    mock_client.__exit__ = MagicMock(return_value=False)
    mock_client_cls = MagicMock(return_value=mock_client)
    return mock_client, mock_client_cls


def _mock_policy(passed=True, blocked_reason=None):
    from search_tool.url_policy import URLPolicyResult
    return URLPolicyResult(passed=passed, blocked_reason=blocked_reason)


class TestFetchConfig:
    def test_uses_httpx_with_trust_env_false(self):
        _, mock_client_cls = _mock_stream_response(200, {"content-type": "text/html"}, [b"hello"])
        with patch("search_tool.fetch.httpx.Client", mock_client_cls):
            fetch_url("https://example.com")
        mock_client_cls.assert_called_once_with(
            trust_env=False,
            follow_redirects=False,
            timeout=HTTP_TIMEOUT_SECONDS,
        )

    def test_does_not_follow_redirects(self):
        _, mock_client_cls = _mock_stream_response(
            301,
            {"content-type": "text/html", "location": "https://other.com"},
        )
        with patch("search_tool.fetch.httpx.Client", mock_client_cls):
            result = fetch_url("https://example.com")
        assert result.http_status == 301
        assert len(result.redirects) == 1
        assert result.redirects[0]["status"] == 301
        assert result.redirects[0]["location"] == "https://other.com"
        # Body should be empty (discarded)
        assert result.body_bytes is None or result.body_bytes == b""


class TestRedirectDetection:
    """All 300-399 status codes should be treated as redirects."""

    def _check_redirect(self, code):
        _, mock_client_cls = _mock_stream_response(
            code,
            {"content-type": "text/html", "location": f"https://other.com/{code}"},
        )
        with patch("search_tool.fetch.httpx.Client", mock_client_cls):
            result = fetch_url("https://example.com")
        assert result.http_status == code
        assert len(result.redirects) == 1
        assert result.redirects[0]["status"] == code
        assert "not followed" in " ".join(result.limitations).lower()

    def test_300_multiple_choices(self):
        self._check_redirect(300)

    def test_301_moved_permanently(self):
        self._check_redirect(301)

    def test_302_found(self):
        self._check_redirect(302)

    def test_303_see_other(self):
        self._check_redirect(303)

    def test_307_temporary_redirect(self):
        self._check_redirect(307)

    def test_308_permanent_redirect(self):
        self._check_redirect(308)

    def test_redirect_without_location(self):
        _, mock_client_cls = _mock_stream_response(302, {"content-type": "text/html"})
        with patch("search_tool.fetch.httpx.Client", mock_client_cls):
            result = fetch_url("https://example.com")
        assert result.http_status == 302
        assert len(result.redirects) == 1
        assert result.redirects[0]["location"] == ""

    def test_redirect_truncates_long_location(self):
        long_loc = "https://other.com/" + "a" * 5000
        _, mock_client_cls = _mock_stream_response(
            302, {"content-type": "text/html", "location": long_loc}
        )
        with patch("search_tool.fetch.httpx.Client", mock_client_cls):
            result = fetch_url("https://example.com")
        assert len(result.redirects[0]["location"]) < len(long_loc)
        assert "truncated" in result.redirects[0]["location"]

    def test_redirect_does_not_consume_unbounded_body(self):
        """Redirect with a huge body must not read all chunks."""
        huge_chunk = b"x" * (MAX_RESPONSE_BYTES + 1)
        mock_response = MagicMock()
        mock_response.status_code = 301
        mock_response.headers = {"content-type": "text/html", "location": "https://other.com"}
        # iter_bytes should NOT be fully consumed for redirects
        mock_response.iter_bytes.return_value = iter([huge_chunk, huge_chunk, huge_chunk])
        mock_ctx = MagicMock()
        mock_ctx.__enter__ = MagicMock(return_value=mock_response)
        mock_ctx.__exit__ = MagicMock(return_value=False)
        mock_client = MagicMock()
        mock_client.stream.return_value = mock_ctx
        mock_client.__enter__ = MagicMock(return_value=mock_client)
        mock_client.__exit__ = MagicMock(return_value=False)
        mock_client_cls = MagicMock(return_value=mock_client)

        with patch("search_tool.fetch.httpx.Client", mock_client_cls):
            result = fetch_url("https://example.com")

        assert result.http_status == 301
        assert result.body_bytes is None or len(result.body_bytes) == 0
        # iter_bytes should NOT have been exhausted
        assert not mock_response.iter_bytes.called or mock_response.close.called


class TestHttpStatusSemantics:
    """2xx = success, 4xx/5xx = failed."""

    def test_200_success(self):
        _, mock_client_cls = _mock_stream_response(200, {"content-type": "text/html"}, [b"ok"])
        with patch("search_tool.fetch.httpx.Client", mock_client_cls):
            result = fetch_url("https://example.com")
        assert result.status == "success"
        assert result.http_status == 200

    def test_201_success(self):
        _, mock_client_cls = _mock_stream_response(201, {"content-type": "application/json"}, [b"{}"])
        with patch("search_tool.fetch.httpx.Client", mock_client_cls):
            result = fetch_url("https://example.com")
        assert result.status == "success"

    def test_404_failed(self):
        _, mock_client_cls = _mock_stream_response(404, {"content-type": "text/html"}, [b"Not Found"])
        with patch("search_tool.fetch.httpx.Client", mock_client_cls):
            result = fetch_url("https://example.com")
        assert result.status == "failed"
        assert result.http_status == 404
        assert any("404" in e for e in result.errors)

    def test_500_failed(self):
        _, mock_client_cls = _mock_stream_response(500, {"content-type": "text/html"}, [b"Error"])
        with patch("search_tool.fetch.httpx.Client", mock_client_cls):
            result = fetch_url("https://example.com")
        assert result.status == "failed"
        assert result.http_status == 500
        assert any("500" in e for e in result.errors)

    def test_403_failed(self):
        _, mock_client_cls = _mock_stream_response(403, {"content-type": "text/html"}, [b"Forbidden"])
        with patch("search_tool.fetch.httpx.Client", mock_client_cls):
            result = fetch_url("https://example.com")
        assert result.status == "failed"
        assert result.http_status == 403


class TestFetchErrors:
    def test_timeout_error(self):
        mock_client = MagicMock()
        mock_client.stream.side_effect = httpx.TimeoutException("timeout")
        mock_client.__enter__ = MagicMock(return_value=mock_client)
        mock_client.__exit__ = MagicMock(return_value=False)
        mock_client_cls = MagicMock(return_value=mock_client)
        with patch("search_tool.fetch.httpx.Client", mock_client_cls):
            result = fetch_url("https://example.com")
        assert result.status == "failed"
        assert any("timed out" in e.lower() or "timeout" in e.lower() for e in result.errors)

    def test_connection_error(self):
        mock_client_cls = MagicMock(side_effect=httpx.ConnectError("refused"))
        with patch("search_tool.fetch.httpx.Client", mock_client_cls):
            result = fetch_url("https://example.com")
        assert result.status == "failed"
        assert any("connection" in e.lower() for e in result.errors)

    def test_dns_error(self):
        mock_client_cls = MagicMock(side_effect=httpx.ConnectError("dns failed"))
        with patch("search_tool.fetch.httpx.Client", mock_client_cls):
            result = fetch_url("https://example.com")
        assert result.status == "failed"


class TestSuccessfulFetch:
    def test_basic_fetch(self):
        body = b"<html><body>Hello</body></html>"
        _, mock_client_cls = _mock_stream_response(200, {"content-type": "text/html"}, [body])
        with patch("search_tool.fetch.httpx.Client", mock_client_cls):
            result = fetch_url("https://example.com")
        assert result.status == "success"
        assert result.body_bytes == body
        assert result.body_sha256 is not None
        assert result.content_length_bytes == len(body)
        assert result.http_status == 200
        assert result.content_type == "text/html"


class TestResponseSizeLimit:
    def test_large_response_truncated(self):
        chunk = b"x" * (MAX_RESPONSE_BYTES // 2 + 1)
        _, mock_client_cls = _mock_stream_response(200, {"content-type": "text/plain"}, [chunk, chunk])
        with patch("search_tool.fetch.httpx.Client", mock_client_cls):
            result = fetch_url("https://example.com")
        assert result.status == "success"
        assert len(result.body_bytes) <= MAX_RESPONSE_BYTES * 2
        assert any("exceeded" in e.lower() or "truncated" in e.lower() for e in result.errors)


class TestFollowRedirectsBasic:
    """Test redirect following with --follow-redirects behavior."""

    def _setup_multi_response(self, responses):
        """responses: list of (status_code, headers, body_chunks) tuples."""
        mock_client = MagicMock()
        contexts = []
        for status_code, headers, body_chunks in responses:
            mock_response = MagicMock()
            mock_response.status_code = status_code
            mock_response.headers = headers
            mock_response.iter_bytes.return_value = iter(body_chunks or [])
            mock_ctx = MagicMock()
            mock_ctx.__enter__ = MagicMock(return_value=mock_response)
            mock_ctx.__exit__ = MagicMock(return_value=False)
            contexts.append(mock_ctx)

        def _stream_side_effect(method, url, **kwargs):
            return contexts.pop(0)

        mock_client.stream.side_effect = _stream_side_effect
        mock_client.__enter__ = MagicMock(return_value=mock_client)
        mock_client.__exit__ = MagicMock(return_value=False)
        return mock_client

    def _mock_dns_policy(self):
        return patch("search_tool.url_policy.check_url", return_value=_mock_policy()), \
               patch("search_tool.url_policy.normalize_url", side_effect=lambda u: u)

    def test_follow_301_redirect(self):
        client = self._setup_multi_response([
            (301, {"content-type": "text/html", "location": "https://final.com/page"}, []),
            (200, {"content-type": "text/html"}, [b"final content"]),
        ])
        patches = self._mock_dns_policy()
        with patches[0], patches[1], patch("search_tool.fetch.httpx.Client", return_value=client):
            result = fetch_url("https://start.com", follow_redirects=True)
        assert result.status == "success"
        assert result.http_status == 200
        assert result.body_bytes == b"final content"
        assert len(result.redirects) == 1
        assert result.redirects[0]["status"] == 301
        assert result.redirects[0]["resolved_url"] == "https://final.com/page"

    def test_follow_302_redirect(self):
        client = self._setup_multi_response([
            (302, {"content-type": "text/html", "location": "https://final.com"}, []),
            (200, {"content-type": "text/html"}, [b"ok"]),
        ])
        patches = self._mock_dns_policy()
        with patches[0], patches[1], patch("search_tool.fetch.httpx.Client", return_value=client):
            result = fetch_url("https://start.com", follow_redirects=True)
        assert result.status == "success"
        assert result.body_bytes == b"ok"

    def test_follow_303_redirect(self):
        client = self._setup_multi_response([
            (303, {"content-type": "text/html", "location": "https://final.com"}, []),
            (200, {"content-type": "text/html"}, [b"see other"]),
        ])
        patches = self._mock_dns_policy()
        with patches[0], patches[1], patch("search_tool.fetch.httpx.Client", return_value=client):
            result = fetch_url("https://start.com", follow_redirects=True)
        assert result.status == "success"

    def test_follow_307_redirect(self):
        client = self._setup_multi_response([
            (307, {"content-type": "text/html", "location": "https://final.com"}, []),
            (200, {"content-type": "text/html"}, [b"temp redirect"]),
        ])
        patches = self._mock_dns_policy()
        with patches[0], patches[1], patch("search_tool.fetch.httpx.Client", return_value=client):
            result = fetch_url("https://start.com", follow_redirects=True)
        assert result.status == "success"

    def test_follow_308_redirect(self):
        client = self._setup_multi_response([
            (308, {"content-type": "text/html", "location": "https://final.com"}, []),
            (200, {"content-type": "text/html"}, [b"perm redirect"]),
        ])
        patches = self._mock_dns_policy()
        with patches[0], patches[1], patch("search_tool.fetch.httpx.Client", return_value=client):
            result = fetch_url("https://start.com", follow_redirects=True)
        assert result.status == "success"

    def test_relative_redirect(self):
        client = self._setup_multi_response([
            (301, {"content-type": "text/html", "location": "/new-page"}, []),
            (200, {"content-type": "text/html"}, [b"relative ok"]),
        ])
        patches = self._mock_dns_policy()
        with patches[0], patches[1], patch("search_tool.fetch.httpx.Client", return_value=client):
            result = fetch_url("https://start.com/old-page", follow_redirects=True)
        assert result.status == "success"
        assert result.redirects[0]["resolved_url"] == "https://start.com/new-page"

    def test_cross_origin_redirect(self):
        client = self._setup_multi_response([
            (301, {"content-type": "text/html", "location": "https://other-domain.com/page"}, []),
            (200, {"content-type": "text/html"}, [b"cross origin"]),
        ])
        patches = self._mock_dns_policy()
        with patches[0], patches[1], patch("search_tool.fetch.httpx.Client", return_value=client):
            result = fetch_url("https://start.com", follow_redirects=True)
        assert result.status == "success"
        assert result.redirects[0]["resolved_url"] == "https://other-domain.com/page"

    def test_multi_hop_redirect_chain(self):
        client = self._setup_multi_response([
            (301, {"content-type": "text/html", "location": "https://hop2.com"}, []),
            (302, {"content-type": "text/html", "location": "https://final.com"}, []),
            (200, {"content-type": "text/html"}, [b"multi hop"]),
        ])
        patches = self._mock_dns_policy()
        with patches[0], patches[1], patch("search_tool.fetch.httpx.Client", return_value=client):
            result = fetch_url("https://hop1.com", follow_redirects=True)
        assert result.status == "success"
        assert len(result.redirects) == 2
        assert result.redirects[0]["resolved_url"] == "https://hop2.com"
        assert result.redirects[1]["resolved_url"] == "https://final.com"

    def test_no_follow_default(self):
        """follow_redirects=False is the default — redirect should NOT be followed."""
        _, mock_client_cls = _mock_stream_response(
            301, {"content-type": "text/html", "location": "https://other.com"}
        )
        with patch("search_tool.fetch.httpx.Client", mock_client_cls):
            result = fetch_url("https://example.com")
        assert result.http_status == 301
        assert len(result.redirects) == 1
        assert "not followed" in " ".join(result.limitations).lower()

    def test_explicit_no_follow(self):
        _, mock_client_cls = _mock_stream_response(
            301, {"content-type": "text/html", "location": "https://other.com"}
        )
        with patch("search_tool.fetch.httpx.Client", mock_client_cls):
            result = fetch_url("https://example.com", follow_redirects=False)
        assert result.http_status == 301


class TestFollowRedirectsUnsafe:
    """Test that unsafe redirect targets are blocked and NOT fetched."""

    def _make_redirect_client(self, redirect_target, called_urls):
        """Return a mock client that issues a 301 to redirect_target on first call."""
        mock_client = MagicMock()
        mock_client.__enter__ = MagicMock(return_value=mock_client)
        mock_client.__exit__ = MagicMock(return_value=False)

        def _stream(method, url, **kwargs):
            called_urls.append(url)
            mock_response = MagicMock()
            mock_response.status_code = 301
            mock_response.headers = {"location": redirect_target}
            mock_response.iter_bytes.return_value = iter([])
            mock_ctx = MagicMock()
            mock_ctx.__enter__ = MagicMock(return_value=mock_response)
            mock_ctx.__exit__ = MagicMock(return_value=False)
            return mock_ctx

        mock_client.stream.side_effect = _stream
        return mock_client

    def test_file_redirect_target_blocked(self):
        called_urls = []
        client = self._make_redirect_client("file:///etc/passwd", called_urls)

        def _policy_side_effect(url):
            if url.startswith("file://"):
                return _mock_policy(False, "scheme not allowed: 'file'")
            return _mock_policy()

        with patch("search_tool.url_policy.check_url", side_effect=_policy_side_effect), \
             patch("search_tool.url_policy.normalize_url", side_effect=lambda u: u), \
             patch("search_tool.fetch.httpx.Client", return_value=client):
            result = fetch_url("https://safe.com", follow_redirects=True)

        assert result.status == "blocked"
        assert "redirect target blocked" in " ".join(result.errors)
        assert not any("file://" in u for u in called_urls)
        assert result.redirects[-1]["blocked_reason"] == "scheme not allowed: 'file'"

    def test_localhost_redirect_target_blocked(self):
        called_urls = []
        client = self._make_redirect_client("http://127.0.0.1/admin", called_urls)

        def _policy_side_effect(url):
            if "127.0.0.1" in url or "localhost" in url:
                return _mock_policy(False, "resolved to private/reserved IP: 127.0.0.1")
            return _mock_policy()

        with patch("search_tool.url_policy.check_url", side_effect=_policy_side_effect), \
             patch("search_tool.url_policy.normalize_url", side_effect=lambda u: u), \
             patch("search_tool.fetch.httpx.Client", return_value=client):
            result = fetch_url("https://safe.com", follow_redirects=True)

        assert result.status == "blocked"
        assert not any("127.0.0.1" in u for u in called_urls)
        assert result.redirects[-1]["blocked_reason"] == "resolved to private/reserved IP: 127.0.0.1"

    def test_credentials_redirect_target_blocked(self):
        called_urls = []
        client = self._make_redirect_client("https://evil.com/path?user:pass@host", called_urls)

        def _policy_side_effect(url):
            if "user:pass@" in url:
                return _mock_policy(False, "credentials in URL")
            return _mock_policy()

        with patch("search_tool.url_policy.check_url", side_effect=_policy_side_effect), \
             patch("search_tool.url_policy.normalize_url", side_effect=lambda u: u), \
             patch("search_tool.fetch.httpx.Client", return_value=client):
            result = fetch_url("https://safe.com", follow_redirects=True)

        assert result.status == "blocked"
        assert "credentials" in " ".join(result.errors).lower()
        assert not any("user:pass@" in u for u in called_urls)
        assert result.redirects[-1]["blocked_reason"] == "credentials in URL"

    def test_hop_records_blocked_reason(self):
        """Blocked redirect hop should have blocked_reason in the record."""
        called_urls = []
        client = self._make_redirect_client("evil-scheme://evil.com/path", called_urls)

        def _policy_side_effect(url):
            if "evil.com" in url:
                return _mock_policy(False, "scheme not allowed: 'evil-scheme'")
            return _mock_policy()

        with patch("search_tool.url_policy.check_url", side_effect=_policy_side_effect), \
             patch("search_tool.url_policy.normalize_url", side_effect=lambda u: u), \
             patch("search_tool.fetch.httpx.Client", return_value=client):
            result = fetch_url("https://safe.com", follow_redirects=True)

        assert result.status == "blocked"
        assert len(result.redirects) >= 1
        assert "evil.com" in result.redirects[-1].get("resolved_url", "")
        assert result.redirects[-1]["blocked_reason"] == "scheme not allowed: 'evil-scheme'"


class TestFollowRedirectsEdgeCases:
    """Loop detection, max depth, missing Location."""

    def test_redirect_loop_detected(self):
        """A -> B -> A should be detected as a loop."""
        mock_client = MagicMock()
        mock_client.__enter__ = MagicMock(return_value=mock_client)
        mock_client.__exit__ = MagicMock(return_value=False)
        call_count = 0

        def _stream(method, url, **kwargs):
            nonlocal call_count
            call_count += 1
            if call_count <= 2:
                target = "https://b.com" if "a.com" in url else "https://a.com"
                mock_response = MagicMock()
                mock_response.status_code = 301
                mock_response.headers = {"location": target}
                mock_response.iter_bytes.return_value = iter([])
                mock_ctx = MagicMock()
                mock_ctx.__enter__ = MagicMock(return_value=mock_response)
                mock_ctx.__exit__ = MagicMock(return_value=False)
                return mock_ctx
            raise AssertionError("Should not fetch after loop detected")

        mock_client.stream.side_effect = _stream

        with patch("search_tool.url_policy.check_url", return_value=_mock_policy()), \
             patch("search_tool.url_policy.normalize_url", side_effect=lambda u: u), \
             patch("search_tool.fetch.httpx.Client", return_value=mock_client):
            result = fetch_url("https://a.com", follow_redirects=True)

        assert result.status == "failed"
        assert "loop" in " ".join(result.errors).lower()

    def test_max_depth_exceeded(self):
        """More than MAX_REDIRECTS hops should fail."""
        responses = []
        for i in range(MAX_REDIRECTS + 2):
            next_loc = f"https://hop{i + 1}.com"
            responses.append((301, {"location": next_loc}, []))
        # Final response would be 200 but we never get there
        responses.append((200, {"content-type": "text/html"}, [b"never reached"]))

        mock_client = MagicMock()
        mock_client.__enter__ = MagicMock(return_value=mock_client)
        mock_client.__exit__ = MagicMock(return_value=False)

        def _stream(method, url, **kwargs):
            resp = responses.pop(0)
            mock_response = MagicMock()
            mock_response.status_code = resp[0]
            mock_response.headers = resp[1]
            mock_response.iter_bytes.return_value = iter(resp[2])
            mock_ctx = MagicMock()
            mock_ctx.__enter__ = MagicMock(return_value=mock_response)
            mock_ctx.__exit__ = MagicMock(return_value=False)
            return mock_ctx

        mock_client.stream.side_effect = _stream

        with patch("search_tool.url_policy.check_url", return_value=_mock_policy()), \
             patch("search_tool.url_policy.normalize_url", side_effect=lambda u: u), \
             patch("search_tool.fetch.httpx.Client", return_value=mock_client):
            result = fetch_url("https://hop0.com", follow_redirects=True)

        assert result.status == "failed"
        assert "exceeded" in " ".join(result.errors).lower() or "depth" in " ".join(result.errors).lower()

    def test_missing_location_header(self):
        """302 without Location should fail."""
        client = MagicMock()
        client.__enter__ = MagicMock(return_value=client)
        client.__exit__ = MagicMock(return_value=False)

        mock_response = MagicMock()
        mock_response.status_code = 302
        mock_response.headers = {"content-type": "text/html"}
        mock_response.iter_bytes.return_value = iter([])
        mock_ctx = MagicMock()
        mock_ctx.__enter__ = MagicMock(return_value=mock_response)
        mock_ctx.__exit__ = MagicMock(return_value=False)
        client.stream.return_value = mock_ctx

        with patch("search_tool.url_policy.check_url", return_value=_mock_policy()), \
             patch("search_tool.url_policy.normalize_url", side_effect=lambda u: u), \
             patch("search_tool.fetch.httpx.Client", return_value=client):
            result = fetch_url("https://example.com", follow_redirects=True)

        assert result.status == "failed"
        assert "location" in " ".join(result.errors).lower()


class TestRedirectNormalization:
    """Verify redirect targets are normalized before fetch, loop detection, and final_url."""

    def _mock_client(self, responses):
        """responses: list of (method, url) -> should match in order."""
        mock_client = MagicMock()
        mock_client.__enter__ = MagicMock(return_value=mock_client)
        mock_client.__exit__ = MagicMock(return_value=False)
        called_with = []
        response_queue = list(responses)

        def _stream(method, url, **kwargs):
            called_with.append(url)
            resp = response_queue.pop(0)
            mock_response = MagicMock()
            mock_response.status_code = resp["status"]
            mock_response.headers = resp.get("headers", {})
            mock_response.iter_bytes.return_value = iter(resp.get("body", []))
            mock_ctx = MagicMock()
            mock_ctx.__enter__ = MagicMock(return_value=mock_response)
            mock_ctx.__exit__ = MagicMock(return_value=False)
            return mock_ctx

        mock_client.stream.side_effect = _stream
        return mock_client, called_with

    def test_redirect_target_fragment_stripped(self):
        """Redirect to URL with fragment should normalize fragment away."""
        client, called_with = self._mock_client([
            {"status": 301, "headers": {"location": "https://final.com/page#section"}},
            {"status": 200, "headers": {"content-type": "text/html"}, "body": [b"ok"]},
        ])

        def _norm(url):
            # Strip fragments
            if "#" in url:
                url = url.split("#")[0]
            return url

        with patch("search_tool.url_policy.check_url", return_value=_mock_policy()), \
             patch("search_tool.url_policy.normalize_url", side_effect=_norm), \
             patch("search_tool.fetch.httpx.Client", return_value=client):
            result = fetch_url("https://start.com", follow_redirects=True)

        assert result.status == "success"
        # resolved_url should be normalized (no fragment)
        assert "#section" not in result.redirects[0]["resolved_url"]
        assert result.redirects[0]["resolved_url"] == "https://final.com/page"
        # The fetch should have been called with normalized URL
        assert "#section" not in called_with[-1]

    def test_redirect_target_default_port_normalized(self):
        """Redirect to http://host:80/path should normalize to http://host/path."""
        client, called_with = self._mock_client([
            {"status": 301, "headers": {"location": "http://final.com:80/page"}},
            {"status": 200, "headers": {"content-type": "text/html"}, "body": [b"ok"]},
        ])

        def _norm(url):
            if ":80/" in url:
                url = url.replace(":80/", "/")
            return url

        with patch("search_tool.url_policy.check_url", return_value=_mock_policy()), \
             patch("search_tool.url_policy.normalize_url", side_effect=_norm), \
             patch("search_tool.fetch.httpx.Client", return_value=client):
            result = fetch_url("https://start.com", follow_redirects=True)

        assert result.status == "success"
        assert ":80" not in result.redirects[0]["resolved_url"]
        assert result.redirects[0]["resolved_url"] == "http://final.com/page"

    def test_loop_detection_uses_normalized_urls(self):
        """Loop detection should catch A/ -> A (trailing slash difference) as same URL."""
        client, called_with = self._mock_client([
            {"status": 301, "headers": {"location": "https://start.com"}},
            {"status": 301, "headers": {"location": "https://start.com/old-page"}},
        ])

        call_count = 0
        def _norm(url):
            return url.rstrip("/") if url != "https://start.com" else url

        with patch("search_tool.url_policy.check_url", return_value=_mock_policy()), \
             patch("search_tool.url_policy.normalize_url", side_effect=_norm), \
             patch("search_tool.fetch.httpx.Client", return_value=client):
            result = fetch_url("https://start.com/old-page", follow_redirects=True)

        assert result.status == "failed"
        assert "loop" in " ".join(result.errors).lower()




class TestTrailingSlashRedirect:
    """Trailing-slash redirects should not be mistaken for redirect loops."""

    def test_trailing_slash_redirect_not_loop(self):
        """Redirect from no-trailing-slash to trailing-slash should succeed."""
        from unittest.mock import MagicMock, patch
        from search_tool.fetch import fetch_url

        mock_client = MagicMock()
        mock_client.__enter__ = MagicMock(return_value=mock_client)
        mock_client.__exit__ = MagicMock(return_value=False)

        call_count = [0]
        call_urls = []

        def _stream(method, url, **kwargs):
            call_urls.append(url)
            call_count[0] += 1
            if call_count[0] == 1:
                mock_response = MagicMock()
                mock_response.status_code = 301
                mock_response.headers = {"location": "https://openai.github.io/openai-agents-python/"}
                mock_response.iter_bytes.return_value = iter([])
                mock_ctx = MagicMock()
                mock_ctx.__enter__ = MagicMock(return_value=mock_response)
                mock_ctx.__exit__ = MagicMock(return_value=False)
                return mock_ctx
            else:
                mock_response = MagicMock()
                mock_response.status_code = 200
                mock_response.headers = {"content-type": "text/html"}
                mock_response.iter_bytes.return_value = iter([b"<html><body>ok</body></html>"])
                mock_ctx = MagicMock()
                mock_ctx.__enter__ = MagicMock(return_value=mock_response)
                mock_ctx.__exit__ = MagicMock(return_value=False)
                return mock_ctx

        mock_client.stream.side_effect = _stream

        with patch("search_tool.url_policy.check_url", return_value=type("_mp", (), {"passed": True, "blocked_reason": None})()), \
             patch("search_tool.fetch.httpx.Client", return_value=mock_client):
            result = fetch_url("https://openai.github.io/openai-agents-python", follow_redirects=True)

        assert result.status == "success"
        assert result.http_status == 200
        assert len(call_urls) == 2

    def test_genuine_loop_still_detected(self):
        """A genuine A->B->A redirect loop should still be detected."""
        from unittest.mock import MagicMock, patch
        from search_tool.fetch import fetch_url

        mock_client = MagicMock()
        mock_client.__enter__ = MagicMock(return_value=mock_client)
        mock_client.__exit__ = MagicMock(return_value=False)

        def _stream(method, url, **kwargs):
            if "a.com" in url:
                mock_response = MagicMock()
                mock_response.status_code = 301
                mock_response.headers = {"location": "https://b.com"}
                mock_response.iter_bytes.return_value = iter([])
            else:
                mock_response = MagicMock()
                mock_response.status_code = 301
                mock_response.headers = {"location": "https://a.com"}
                mock_response.iter_bytes.return_value = iter([])
            mock_ctx = MagicMock()
            mock_ctx.__enter__ = MagicMock(return_value=mock_response)
            mock_ctx.__exit__ = MagicMock(return_value=False)
            return mock_ctx

        mock_client.stream.side_effect = _stream

        with patch("search_tool.url_policy.check_url", return_value=type("_mp", (), {"passed": True, "blocked_reason": None})()), \
             patch("search_tool.url_policy.normalize_url", side_effect=lambda u: u), \
             patch("search_tool.fetch.httpx.Client", return_value=mock_client):
            result = fetch_url("https://a.com", follow_redirects=True)

        assert result.status == "failed"
        assert "redirect loop detected" in result.errors
