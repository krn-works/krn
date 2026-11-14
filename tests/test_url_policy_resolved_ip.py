"""Tests for check_resolved_ip — DNS mocked, no live internet."""

from unittest.mock import patch

from search_tool.url_policy import check_resolved_ip


def _infos(ip):
    return [(2, 1, 6, "", (ip, 0))]


def test_blocks_loopback_resolution():
    with patch("socket.getaddrinfo", return_value=_infos("127.0.0.1")):
        result = check_resolved_ip("example.test")
    assert not result.passed
    assert result.private_ip_blocked
    assert "127.0.0.1" in result.blocked_reason


def test_allow_private_permits_loopback():
    with patch("socket.getaddrinfo", return_value=_infos("127.0.0.1")):
        assert check_resolved_ip("example.test", allow_private=True).passed


def test_public_ip_passes():
    with patch("socket.getaddrinfo", return_value=_infos("93.184.216.34")):
        assert check_resolved_ip("example.test").passed
