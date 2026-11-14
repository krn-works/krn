import pytest
import socket
from unittest.mock import patch

@pytest.fixture
def mock_dns_mapper():
    """Mock DNS with a configurable mapping: hostname -> ip_string."""
    mapping = {}

    def _fake_getaddrinfo(host, port, family=0, type=0):
        # Allow 127.0.0.1 to resolve to itself for the test server
        if host == "127.0.0.1":
            return [(socket.AF_INET, socket.SOCK_STREAM, socket.IPPROTO_TCP, "", ("127.0.0.1", port))]
        # Default to a safe public IP if not in mapping
        ip = mapping.get(host, "93.184.216.34")
        return [(socket.AF_INET, socket.SOCK_STREAM, socket.IPPROTO_TCP, "", (ip, 0))]

    with patch("search_tool.url_policy.socket.getaddrinfo") as mock_dns:
        mock_dns.side_effect = _fake_getaddrinfo
        yield mapping
