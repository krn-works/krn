"""URL policy: validate and reject unsafe URLs before any network request."""

from __future__ import annotations

import ipaddress
import socket
from urllib.parse import urlparse

ALLOWED_SCHEMES = {"http", "https"}

BLOCKED_HOSTS = {
    "localhost",
    "localhost.localdomain",
}

PRIVATE_NETWORKS = [
    ipaddress.ip_network("127.0.0.0/8"),        # loopback
    ipaddress.ip_network("::1/128"),             # loopback v6
    ipaddress.ip_network("169.254.0.0/16"),      # link-local / metadata
    ipaddress.ip_network("10.0.0.0/8"),          # RFC1918
    ipaddress.ip_network("172.16.0.0/12"),       # RFC1918
    ipaddress.ip_network("192.168.0.0/16"),      # RFC1918
    ipaddress.ip_network("fe80::/10"),           # IPv6 link-local
    ipaddress.ip_network("fc00::/7"),            # IPv6 unique local
    ipaddress.ip_network("ff00::/8"),            # IPv6 multicast
    ipaddress.ip_network("0.0.0.0/8"),           # current network
    ipaddress.ip_network("100.64.0.0/10"),       # carrier-grade NAT
    ipaddress.ip_network("198.18.0.0/15"),       # benchmarking
    ipaddress.ip_network("224.0.0.0/4"),         # multicast
    ipaddress.ip_network("240.0.0.0/4"),         # reserved
    ipaddress.ip_network("192.0.2.0/24"),        # TEST-NET-1 (documentation)
    ipaddress.ip_network("198.51.100.0/24"),     # TEST-NET-2 (documentation)
    ipaddress.ip_network("203.0.113.0/24"),      # TEST-NET-3 (documentation)
    ipaddress.ip_network("2001:db8::/32"),       # documentation v6
]


class URLPolicyResult:
    def __init__(
        self,
        *,
        passed: bool,
        blocked_reason: str | None = None,
        credentials_in_url: bool = False,
        private_ip_blocked: bool = False,
    ):
        self.passed = passed
        self.blocked_reason = blocked_reason
        self.credentials_in_url = credentials_in_url
        self.private_ip_blocked = private_ip_blocked

    def __repr__(self) -> str:
        status = "passed" if self.passed else f"blocked: {self.blocked_reason}"
        return f"URLPolicyResult({status})"


def check_url(url: str, *, allow_private: bool = False) -> URLPolicyResult:
    """Validate a URL against the security policy. Returns a URLPolicyResult."""
    # Check for credentials in URL
    if has_credentials(url):
        return URLPolicyResult(
            passed=False,
            blocked_reason="credentials in URL",
            credentials_in_url=True,
        )

    try:
        parsed = urlparse(url)
    except Exception:
        return URLPolicyResult(passed=False, blocked_reason="malformed URL")

    # Scheme check
    if parsed.scheme not in ALLOWED_SCHEMES:
        return URLPolicyResult(
            passed=False,
            blocked_reason=f"scheme not allowed: {parsed.scheme!r}",
        )

    hostname = parsed.hostname
    if not hostname:
        return URLPolicyResult(passed=False, blocked_reason="missing hostname")

    # Blocked hostnames
    if not allow_private and hostname.lower() in BLOCKED_HOSTS:
        return URLPolicyResult(
            passed=False,
            blocked_reason="hostname is localhost or loopback alias",
            private_ip_blocked=True,
        )

    # DNS resolution check
    ip_result = check_resolved_ip(hostname, allow_private=allow_private)
    if not ip_result.passed:
        return ip_result

    return URLPolicyResult(passed=True)


def has_credentials(url: str) -> bool:
    """Check if URL contains username:password@host."""
    try:
        parsed = urlparse(url)
        return parsed.username is not None or parsed.password is not None
    except Exception:
        return False


def check_resolved_ip(hostname: str, *, allow_private: bool = False) -> URLPolicyResult:
    """Resolve hostname and check if the IP is private/loopback/link-local."""
    try:
        addr_infos = socket.getaddrinfo(hostname, None, socket.AF_UNSPEC, socket.SOCK_STREAM)
    except socket.gaierror:
        return URLPolicyResult(passed=False, blocked_reason="DNS resolution failed")
    except Exception:
        return URLPolicyResult(passed=False, blocked_reason="DNS resolution error")

    if not addr_infos:
        return URLPolicyResult(passed=False, blocked_reason="no addresses resolved")

    if not allow_private:
        for _, _, _, _, sockaddr in addr_infos:
            ip_str = sockaddr[0]
            try:
                ip = ipaddress.ip_address(ip_str)
            except ValueError:
                continue
            for network in PRIVATE_NETWORKS:
                if ip in network:
                    return URLPolicyResult(
                        passed=False,
                        blocked_reason=f"resolved to private/reserved IP: {ip_str}",
                        private_ip_blocked=True,
                    )

    return URLPolicyResult(passed=True)


def normalize_url(url: str) -> str:
    """Return a normalized form of the URL for cache keying.

    Preserves: scheme (lowercased), hostname (lowercased), explicit non-default port,
    path, query string.
    Removes: fragment (not sent over HTTP), default ports (80 for http, 443 for https).
    Credentials are never present here because such URLs are blocked before fetch.
    """
    try:
        parsed = urlparse(url)
        scheme = parsed.scheme.lower()
        host = parsed.hostname.lower() if parsed.hostname else ""
        port = parsed.port

        # Normalize default ports away
        if (scheme == "http" and port == 80) or (scheme == "https" and port == 443):
            port = None

        path = parsed.path or "/"
        if not path.startswith("/"):
            path = "/" + path
        # Strip trailing slash except for root
        if len(path) > 1 and path.endswith("/"):
            path = path.rstrip("/")

        result = f"{scheme}://{host}"

        if port is not None:
            result += f":{port}"

        result += path

        # Preserve query string
        if parsed.query:
            result += f"?{parsed.query}"

        # Deliberately drop fragment — it is not sent to the server
        return result
    except Exception:
        return url
