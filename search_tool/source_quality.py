"""Deterministic source quality metadata based on URL/domain heuristics."""

from __future__ import annotations

from dataclasses import dataclass
from urllib.parse import urlparse

SOURCE_TYPES = frozenset({
    "official_docs",
    "repository",
    "paper",
    "advisory",
    "standards",
    "docs_site",
    "blog",
    "forum",
    "seo",
    "unknown",
})


@dataclass(frozen=True)
class SourceQuality:
    source_type: str
    authority_score: int
    is_official: bool
    is_primary_source: bool
    domain: str
    reason: str


_OFFICIAL_DOCS_DOMAINS: frozenset[str] = frozenset({
    "docs.python.org",
    "developer.mozilla.org",
})

_REPOSITORY_DOMAINS: frozenset[str] = frozenset({
    "github.com",
    "raw.githubusercontent.com",
    "gitlab.com",
})

_PAPER_DOMAINS: frozenset[str] = frozenset({
    "arxiv.org",
    "doi.org",
})

_STANDARDS_DOMAINS: frozenset[str] = frozenset({
    "owasp.org",
    "openssf.org",
})

_ADVISORY_DOMAINS: frozenset[str] = frozenset({
    "cve.org",
    "nist.gov",
})

_FORUM_DOMAINS: frozenset[str] = frozenset({
    "reddit.com",
    "stackoverflow.com",
    "news.ycombinator.com",
})

_BLOG_DOMAINS: frozenset[str] = frozenset({
    "medium.com",
    "dev.to",
    "substack.com",
})

# Official vendor research/blog domains — primary sources but not docs
_PRIMARY_BLOG_DOMAINS: frozenset[str] = frozenset({
    "anthropic.com",
    "openai.com",
})

# Official vendor developer blog domains
_PRIMARY_DEV_BLOG_DOMAINS: frozenset[str] = frozenset({
    "developers.googleblog.com",
})


def _extract_host(url: str) -> str:
    try:
        parsed = urlparse(url)
        host = (parsed.hostname or "").lower()
        if host.startswith("www."):
            host = host[4:]
        return host
    except Exception:
        return ""


def classify_source_quality(url: str, title: str | None = None) -> SourceQuality:
    host = _extract_host(url)

    if not host:
        return SourceQuality(
            source_type="unknown", authority_score=0,
            is_official=False, is_primary_source=False,
            domain="", reason="malformed URL",
        )

    # Extract path for additional heuristics
    try:
        path = urlparse(url).path.lower().lstrip("/")
    except Exception:
        path = ""

    # Official docs — seed set
    if host in _OFFICIAL_DOCS_DOMAINS:
        return SourceQuality(
            source_type="official_docs", authority_score=3,
            is_official=True, is_primary_source=True,
            domain=host, reason="official documentation domain",
        )

    # Generic docs.* pattern (subdomain or path)
    if host.startswith("docs."):
        return SourceQuality(
            source_type="official_docs", authority_score=3,
            is_official=True, is_primary_source=True,
            domain=host, reason="docs subdomain",
        )

    # /docs path pattern (platform.openai.com/docs, etc.)
    if path.startswith("docs/") or path == "docs":
        return SourceQuality(
            source_type="official_docs", authority_score=3,
            is_official=True, is_primary_source=True,
            domain=host, reason="docs path",
        )

    # code.claude.com/docs
    if host == "code.claude.com":
        return SourceQuality(
            source_type="official_docs", authority_score=3,
            is_official=True, is_primary_source=True,
            domain=host, reason="official Claude Code docs",
        )

    # Standards
    if host in _STANDARDS_DOMAINS:
        return SourceQuality(
            source_type="standards", authority_score=3,
            is_official=True, is_primary_source=True,
            domain=host, reason="standards organization",
        )

    # Advisory
    if host in _ADVISORY_DOMAINS:
        return SourceQuality(
            source_type="advisory", authority_score=3,
            is_official=True, is_primary_source=True,
            domain=host, reason="official advisory source",
        )

    # Repository
    if host in _REPOSITORY_DOMAINS:
        is_official = title is not None and any(
            kw in title.lower() for kw in ("official", "documentation", "docs")
        )
        return SourceQuality(
            source_type="repository", authority_score=3 if is_official else 2,
            is_official=is_official, is_primary_source=is_official,
            domain=host, reason="code repository",
        )

    # Paper
    if host in _PAPER_DOMAINS:
        return SourceQuality(
            source_type="paper", authority_score=2,
            is_official=False, is_primary_source=True,
            domain=host, reason="academic paper/preprint",
        )

    # Forum
    if host in _FORUM_DOMAINS:
        return SourceQuality(
            source_type="forum", authority_score=1,
            is_official=False, is_primary_source=False,
            domain=host, reason="community forum",
        )

    # Blog
    if host in _BLOG_DOMAINS or host.endswith(".substack.com"):
        return SourceQuality(
            source_type="blog", authority_score=1,
            is_official=False, is_primary_source=False,
            domain=host, reason="blog platform",
        )

    # Official vendor research/blog — primary source
    if host in _PRIMARY_BLOG_DOMAINS:
        return SourceQuality(
            source_type="blog", authority_score=3,
            is_official=True, is_primary_source=True,
            domain=host, reason="official vendor research blog",
        )

    # Official vendor developer blog
    if host in _PRIMARY_DEV_BLOG_DOMAINS:
        return SourceQuality(
            source_type="blog", authority_score=3,
            is_official=True, is_primary_source=True,
            domain=host, reason="official vendor developer blog",
        )

    # Private/internal — never official
    is_private = (
        host in ("localhost", "127.0.0.1", "::1")
        or host.endswith(".local")
        or host.endswith(".internal")
        or host.startswith("10.")
        or host.startswith("172.16.") or host.startswith("172.17.") or host.startswith("172.18.") or host.startswith("172.19.")
        or host.startswith("172.2") or host.startswith("172.3")
        or host.startswith("192.168.")
        or host.startswith("127.")
    )
    if is_private:
        return SourceQuality(
            source_type="unknown", authority_score=0,
            is_official=False, is_primary_source=False,
            domain=host, reason="private/internal address",
        )

    # Default: unknown docs_site if looks like docs, otherwise unknown
    if "doc" in host:
        return SourceQuality(
            source_type="docs_site", authority_score=2,
            is_official=False, is_primary_source=False,
            domain=host, reason="documentation site",
        )

    return SourceQuality(
        source_type="unknown", authority_score=1,
        is_official=False, is_primary_source=False,
        domain=host, reason="unclassified domain",
    )
