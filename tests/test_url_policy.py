"""Tests for URL policy — all DNS mocked, no live internet."""

from unittest.mock import patch

import pytest

from search_tool.url_policy import (
    check_url,
    has_credentials,
    normalize_url,
    PRIVATE_NETWORKS,
)


# --- DNS mock fixture ---

@pytest.fixture
def mock_public_dns():
    """Mock DNS to resolve any hostname to 93.184.216.34 (example.com)."""
    with patch("search_tool.url_policy.socket.getaddrinfo") as mock_dns:
        mock_dns.return_value = [(2, 1, 6, "", ("93.184.216.34", 0))]
        yield mock_dns


class TestSchemeRejection:
    def test_block_file(self):
        r = check_url("file:///etc/passwd")
        assert not r.passed
        assert "file" in r.blocked_reason

    def test_block_data(self):
        r = check_url("data:text/html,<script>alert(1)</script>")
        assert not r.passed
        assert "data" in r.blocked_reason

    def test_block_ftp(self):
        r = check_url("ftp://example.com/file")
        assert not r.passed
        assert "ftp" in r.blocked_reason

    def test_block_gopher(self):
        r = check_url("gopher://example.com")
        assert not r.passed
        assert "gopher" in r.blocked_reason

    def test_block_mailto(self):
        r = check_url("mailto:test@example.com")
        assert not r.passed

    def test_block_javascript(self):
        r = check_url("javascript:alert(1)")
        assert not r.passed

    def test_allow_http(self, mock_public_dns):
        r = check_url("http://example.com")
        assert r.passed

    def test_allow_https(self, mock_public_dns):
        r = check_url("https://example.com")
        assert r.passed


# --- Host rejection (localhost and loopback aliases) ---


class TestHostRejection:
    def test_block_localhost(self):
        r = check_url("http://localhost")
        assert not r.passed
        assert r.private_ip_blocked

    def test_block_localhost_localdomain(self):
        r = check_url("http://localhost.localdomain")
        assert not r.passed
        assert r.private_ip_blocked


# --- IP rejection via mocked DNS ---


class TestIpRejection:
    def test_block_127_0_0_1(self, mock_dns_mapper):
        mock_dns_mapper["127.0.0.1"] = "127.0.0.1"
        r = check_url("http://127.0.0.1")
        assert not r.passed
        assert r.private_ip_blocked
        assert "127.0.0.1" in r.blocked_reason

    def test_block_127_0_0_0_network(self, mock_dns_mapper):
        mock_dns_mapper["127.0.0.100"] = "127.0.0.100"
        r = check_url("http://127.0.0.100")
        assert not r.passed
        assert r.private_ip_blocked

    def test_block_ipv6_loopback(self, mock_dns_mapper):
        # URL with IPv6 literal
        with patch("search_tool.url_policy.socket.getaddrinfo") as mock_dns:
            mock_dns.return_value = [(10, 1, 6, "", ("::1", 0, 0, 0))]
            r = check_url("http://[::1]")
        assert not r.passed
        assert r.private_ip_blocked

    def test_block_metadata_endpoint(self, mock_dns_mapper):
        mock_dns_mapper["169.254.169.254"] = "169.254.169.254"
        r = check_url("http://169.254.169.254/latest/meta-data/")
        assert not r.passed
        assert r.private_ip_blocked
        assert "169.254" in r.blocked_reason

    def test_block_10_0_0_1(self, mock_dns_mapper):
        mock_dns_mapper["internal.corp"] = "10.0.0.1"
        r = check_url("http://internal.corp")
        assert not r.passed
        assert r.private_ip_blocked
        assert "10.0.0.1" in r.blocked_reason

    def test_block_172_16_0_1(self, mock_dns_mapper):
        mock_dns_mapper["inside.corp"] = "172.16.0.1"
        r = check_url("http://inside.corp")
        assert not r.passed
        assert r.private_ip_blocked

    def test_block_172_31_255_255(self, mock_dns_mapper):
        mock_dns_mapper["rfc1918.corp"] = "172.31.255.255"
        r = check_url("http://rfc1918.corp")
        assert not r.passed
        assert r.private_ip_blocked

    def test_block_192_168_0_1(self, mock_dns_mapper):
        mock_dns_mapper["home.local"] = "192.168.0.1"
        r = check_url("http://home.local")
        assert not r.passed
        assert r.private_ip_blocked
        assert "192.168" in r.blocked_reason

    def test_block_0_0_0_0(self, mock_dns_mapper):
        mock_dns_mapper["zero"] = "0.0.0.0"
        r = check_url("http://zero")
        assert not r.passed
        assert r.private_ip_blocked

    def test_block_100_64_0_1(self, mock_dns_mapper):
        mock_dns_mapper["cgnat"] = "100.64.0.1"
        r = check_url("http://cgnat")
        assert not r.passed
        assert r.private_ip_blocked

    def test_block_198_18_0_1(self, mock_dns_mapper):
        mock_dns_mapper["bench"] = "198.18.0.1"
        r = check_url("http://bench")
        assert not r.passed
        assert r.private_ip_blocked

    def test_block_224_0_0_1_multicast(self, mock_dns_mapper):
        mock_dns_mapper["multi"] = "224.0.0.1"
        r = check_url("http://multi")
        assert not r.passed
        assert r.private_ip_blocked

    def test_block_240_0_0_1_reserved(self, mock_dns_mapper):
        mock_dns_mapper["future"] = "240.0.0.1"
        r = check_url("http://future")
        assert not r.passed
        assert r.private_ip_blocked

    def test_block_fe80_ipv6_link_local(self, mock_dns_mapper):
        with patch("search_tool.url_policy.socket.getaddrinfo") as mock_dns:
            mock_dns.return_value = [(10, 1, 6, "", ("fe80::1", 0, 0, 0))]
            r = check_url("http://[fe80::1]")
        assert not r.passed
        assert r.private_ip_blocked

    def test_block_fc00_ipv6_unique_local(self, mock_dns_mapper):
        with patch("search_tool.url_policy.socket.getaddrinfo") as mock_dns:
            mock_dns.return_value = [(10, 1, 6, "", ("fc00::1", 0, 0, 0))]
            r = check_url("http://[fc00::1]")
        assert not r.passed
        assert r.private_ip_blocked

    def test_block_ff00_ipv6_multicast(self, mock_dns_mapper):
        with patch("search_tool.url_policy.socket.getaddrinfo") as mock_dns:
            mock_dns.return_value = [(10, 1, 6, "", ("ff00::1", 0, 0, 0))]
            r = check_url("http://[ff00::1]")
        assert not r.passed
        assert r.private_ip_blocked

    def test_block_192_0_2_1_documentation(self, mock_dns_mapper):
        mock_dns_mapper["doc1"] = "192.0.2.1"
        r = check_url("http://doc1")
        assert not r.passed
        assert r.private_ip_blocked

    def test_block_198_51_100_1_documentation(self, mock_dns_mapper):
        mock_dns_mapper["doc2"] = "198.51.100.1"
        r = check_url("http://doc2")
        assert not r.passed
        assert r.private_ip_blocked

    def test_block_203_0_113_1_documentation(self, mock_dns_mapper):
        mock_dns_mapper["doc3"] = "203.0.113.1"
        r = check_url("http://doc3")
        assert not r.passed
        assert r.private_ip_blocked

    def test_block_2001_db8_ipv6_documentation(self, mock_dns_mapper):
        with patch("search_tool.url_policy.socket.getaddrinfo") as mock_dns:
            mock_dns.return_value = [(10, 1, 6, "", ("2001:db8::1", 0, 0, 0))]
            r = check_url("http://[2001:db8::1]")
        assert not r.passed
        assert r.private_ip_blocked

    def test_dns_failure_blocks(self):
        with patch("search_tool.url_policy.socket.getaddrinfo") as mock_dns:
            import socket
            mock_dns.side_effect = socket.gaierror("DNS failed")
            r = check_url("http://nonexistent.invalid")
        assert not r.passed
        assert "DNS" in r.blocked_reason


# --- Credentials rejection ---


class TestCredentialsRejection:
    def test_block_credentials(self):
        r = check_url("https://user:pass@example.com")
        assert not r.passed
        assert r.credentials_in_url

    def test_block_user_only(self):
        r = check_url("https://user@example.com")
        assert not r.passed
        assert r.credentials_in_url

    def test_no_credentials(self, mock_public_dns):
        r = check_url("https://example.com/path")
        assert r.passed
        assert not r.credentials_in_url


# --- Missing host ---


class TestMissingHost:
    def test_missing_hostname(self):
        r = check_url("http://")
        assert not r.passed

    def test_empty_url(self):
        r = check_url("")
        assert not r.passed


# --- Normalize URL ---


class TestNormalizeUrl:
    def test_normalizes_scheme_and_host(self):
        assert normalize_url("https://Example.COM/path") == "https://example.com/path"

    def test_adds_trailing_slash_for_root(self):
        assert normalize_url("https://example.com") == "https://example.com/"

    def test_strips_trailing_slash(self):
        assert normalize_url("https://example.com/path/") == "https://example.com/path"

    def test_preserves_query_string(self):
        assert normalize_url("https://example.com/docs?page=1") == "https://example.com/docs?page=1"

    def test_different_query_different_key(self):
        n1 = normalize_url("https://example.com/docs?page=1")
        n2 = normalize_url("https://example.com/docs?page=2")
        assert n1 != n2

    def test_removes_fragment(self):
        assert normalize_url("https://example.com/path#section") == "https://example.com/path"

    def test_removes_fragment_keeps_query(self):
        assert normalize_url("https://example.com/path?q=1#s") == "https://example.com/path?q=1"

    def test_normalizes_http_port_80_away(self):
        assert normalize_url("http://example.com:80/") == "http://example.com/"

    def test_normalizes_https_port_443_away(self):
        assert normalize_url("https://example.com:443/") == "https://example.com/"

    def test_preserves_non_default_port(self):
        assert normalize_url("https://example.com:8080/path") == "https://example.com:8080/path"

    def test_preserves_http_non_default_port(self):
        assert normalize_url("http://example.com:8080/path") == "http://example.com:8080/path"

    def test_handles_invalid(self):
        result = normalize_url("not-a-url")
        assert "not-a-url" in result


# --- Has credentials ---


class TestHasCredentials:
    def test_detects_credentials(self):
        assert has_credentials("https://user:pass@host.com")

    def test_no_credentials(self):
        assert not has_credentials("https://host.com")

    def test_malformed(self):
        assert not has_credentials(":::")


# --- Private networks coverage ---


class TestPrivateNetworksCoverage:
    """Verify all expected networks are in PRIVATE_NETWORKS."""

    def test_loopback_v4(self):
        import ipaddress
        assert ipaddress.ip_address("127.0.0.1") in ipaddress.ip_network("127.0.0.0/8")

    def test_rfc1918_networks_present(self):
        import ipaddress
        expected_prefixes = {"10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16"}
        actual_prefixes = {str(n) for n in PRIVATE_NETWORKS}
        for prefix in expected_prefixes:
            assert prefix in actual_prefixes, f"Missing {prefix}"


# --- Bypass (allow_private) ---


class TestPolicyBypass:
    def test_allow_private_defaults_to_false(self, mock_dns_mapper):
        mock_dns_mapper["localhost"] = "127.0.0.1"
        # Explicitly testing default parameter value
        r = check_url("http://localhost")
        assert not r.passed
        assert "localhost" in r.blocked_reason

    def test_allow_localhost_when_bypass_enabled(self):
        # Normally blocked
        r = check_url("http://localhost")
        assert not r.passed

        # Bypass allowed
        r = check_url("http://localhost", allow_private=True)
        assert r.passed

    def test_localhost_still_blocked_by_default(self, mock_dns_mapper):
        mock_dns_mapper["localhost"] = "127.0.0.1"
        r = check_url("http://localhost")
        assert not r.passed
        assert "localhost" in r.blocked_reason

    def test_127_0_0_1_still_blocked_by_default(self):
        r = check_url("http://127.0.0.1")
        assert not r.passed

    def test_169_254_169_254_still_blocked_by_default(self):
        r = check_url("http://169.254.169.254")
        assert not r.passed

    def test_rfc1918_still_blocked_by_default(self, mock_dns_mapper):
        mock_dns_mapper["private.local"] = "192.168.1.1"
        r = check_url("http://private.local")
        assert not r.passed

    def test_allow_private_ip_when_bypass_enabled(self, mock_dns_mapper):
        mock_dns_mapper["192.168.1.1"] = "192.168.1.1"

        # Normally blocked
        r = check_url("http://192.168.1.1")
        assert not r.passed

        # Bypass allowed
        r = check_url("http://192.168.1.1", allow_private=True)
        assert r.passed

    def test_allow_link_local_when_bypass_enabled(self, mock_dns_mapper):
        mock_dns_mapper["169.254.169.254"] = "169.254.169.254"
        r = check_url("http://169.254.169.254", allow_private=True)
        assert r.passed

    def test_still_block_malformed_even_with_bypass(self):
        r = check_url("http://", allow_private=True)
        assert not r.passed
        assert r.blocked_reason == "missing hostname"

    def test_still_block_invalid_scheme_even_with_bypass(self):
        r = check_url("file:///etc/passwd", allow_private=True)
        assert not r.passed
        assert "scheme not allowed" in r.blocked_reason

    def test_still_block_credentials_even_with_bypass(self):
        r = check_url("https://user:pass@example.com", allow_private=True)
        assert not r.passed
        assert r.credentials_in_url
