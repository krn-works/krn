"""llms.txt discovery provider: parse llms.txt/docs-index files and emit discovery candidates.

L.2 scope: single-file fetch, parse Key URLs/sections, deterministic keyword scoring,
no recursive llms.txt fetching, stdlib only for parsing.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, replace as dc_replace
from typing import Protocol
from urllib.parse import urljoin, urlparse

from search_tool.discovery import (
    DiscoveryError,
    DiscoveryResult,
    RawDiscoveryCandidate,
    build_discovery_result,
    normalize_query,
    redact_query,
)
from search_tool.fetch import fetch_url as _fetch_url, FetchResult
from search_tool.url_policy import (
    ALLOWED_SCHEMES as _ALLOWED_SCHEMES,
    check_url as _check_url,
    normalize_url as _normalize_url,
)


@dataclass
class _ParsedEntry:
    url: str
    title: str | None = None
    snippet: str | None = None
    section: str | None = None
    line_number: int = 0


# Sections recognised in llms.txt (H2 headers)
_SECTION_RE = re.compile(r"^##\s+(.+)$", re.MULTILINE)

# Markdown link: [Title](URL) or [Title](URL): description
# Also matches optional leading bullet "- " or "* "
_MARKDOWN_LINK_RE = re.compile(
    r"^\s*[-*]?\s*\[([^\]]+)\]\(([^)]+)\)\s*(?::\s*(.+))?$",
)

# Raw URL on its own line (starts with http/https, ends before whitespace)
_RAW_URL_RE = re.compile(r"^\s*(https?://\S+)\s*$")

# Named URL: `Title: URL` or `- Title: URL` (used in Key URLs section)
_NAMED_URL_RE = re.compile(
    r"^\s*[-]?\s*(.+?):\s*(https?://\S+)\s*$",
)

# Fenced code block markers
_FENCED_CODE_RE = re.compile(r"^```")

# Explicitly unsupported schemes (before url_policy check — skip parsing effort)
_BLOCKED_SCHEMES = frozenset({"file", "javascript", "data", "mailto"})

_REDACTION_LIMITATION = "Query redaction is best-effort and not a security boundary."


class _FetcherProtocol(Protocol):
    def __call__(self, url: str, **kwargs) -> FetchResult: ...


def _strip_fenced_code_blocks(text: str) -> str:
    """Remove fenced code blocks (```) from markdown text."""
    result = []
    inside = False
    for line in text.split("\n"):
        if _FENCED_CODE_RE.match(line.strip()):
            inside = not inside
            continue
        if not inside:
            result.append(line)
    return "\n".join(result)


def _resolve_relative(url: str, base: str) -> str:
    """Resolve a relative URL against a base URL (the llms.txt source).

    Supports:
    - Absolute paths: /docs/guide -> https://example.com/docs/guide
    - Relative paths: guide -> https://example.com/docs/guide (against parent of base)
    """
    resolved = urljoin(base, url)
    parsed = urlparse(resolved)
    # Only allow http/https after resolution
    if parsed.scheme.lower() not in _ALLOWED_SCHEMES:
        return ""
    # Reject fragment-only URLs (has scheme but no netloc/path beyond scheme)
    if not parsed.netloc:
        return ""
    return resolved


def _is_valid_candidate_url(url: str) -> bool:
    """Check if a URL is a valid candidate (not blocked scheme, not empty, not fragment-only)."""
    if not url or not url.strip():
        return False
    try:
        parsed = urlparse(url)
    except Exception:
        return False
    scheme = parsed.scheme.lower()
    if scheme in _BLOCKED_SCHEMES:
        return False
    if scheme not in _ALLOWED_SCHEMES:
        return False
    if not parsed.netloc:
        return False
    return True


def _normalize_candidate_url(url: str) -> str:
    """Normalize a candidate URL for dedup."""
    try:
        return _normalize_url(url)
    except Exception:
        return url


def parse_llms_txt(body: bytes, source_url: str) -> tuple[list[_ParsedEntry], list[str]]:
    """Parse llms.txt body into structured entries.

    Rules:
    - Markdown links: [Title](URL) with optional description
    - Bullet links: - [Title](URL)
    - Raw URL lines: https://example.com
    - H2 sections captured for subsequent entries
    - Fenced code blocks ignored
    - Relative URLs resolved against source_url
    - Blocked schemes (file, javascript, data, mailto) skipped
    - Duplicates deduped by normalized URL (first occurrence kept)

    Returns: (entries, warnings)
    """
    text = body.decode("utf-8", errors="replace")
    text = _strip_fenced_code_blocks(text)
    lines = text.split("\n")

    entries: list[_ParsedEntry] = []
    seen_normalized: dict[str, int] = {}
    current_section: str | None = None
    warnings: list[str] = []

    for i, line in enumerate(lines):
        stripped = line.strip()

        # Track H2 sections
        section_match = _SECTION_RE.match(line)
        if section_match:
            current_section = section_match.group(1).strip()
            continue

        # Try markdown link
        link_match = _MARKDOWN_LINK_RE.match(line)
        if link_match:
            title = link_match.group(1).strip()
            raw_url = link_match.group(2).strip()
            description = link_match.group(3)

            # Clean trailing punctuation from URL
            raw_url = raw_url.rstrip("):,")

            # Skip empty-title links (e.g. "[](...)")
            if not title:
                warnings.append(f"line {i+1}: skipped empty-title link")
                continue

            # Resolve relative URLs
            if not raw_url.startswith("http://") and not raw_url.startswith("https://"):
                resolved = _resolve_relative(raw_url, source_url)
                if not resolved:
                    warnings.append(f"line {i+1}: relative URL resolved to unsupported scheme: {raw_url!r}")
                    continue
                raw_url = resolved

            if not _is_valid_candidate_url(raw_url):
                warnings.append(f"line {i+1}: skipped invalid URL in link: {raw_url!r}")
                continue

            normalized = _normalize_candidate_url(raw_url)
            if normalized in seen_normalized:
                continue

            entry = _ParsedEntry(
                url=raw_url,
                title=title if title else None,
                snippet=description.strip() if description else None,
                section=current_section,
                line_number=i + 1,
            )
            idx = len(entries)
            entries.append(entry)
            seen_normalized[normalized] = idx
            continue

        # Try raw URL
        raw_match = _RAW_URL_RE.match(line)
        if raw_match:
            raw_url = raw_match.group(1).rstrip("):,")
            if not _is_valid_candidate_url(raw_url):
                warnings.append(f"line {i+1}: skipped invalid raw URL: {raw_url!r}")
                continue

            normalized = _normalize_candidate_url(raw_url)
            if normalized in seen_normalized:
                continue

            entry = _ParsedEntry(
                url=raw_url,
                section=current_section,
                line_number=i + 1,
            )
            idx = len(entries)
            entries.append(entry)
            seen_normalized[normalized] = idx
            continue

        # Try named URL: "Title: URL" or "- Title: URL"
        named_match = _NAMED_URL_RE.match(line)
        if named_match:
            title = named_match.group(1).strip()
            raw_url = named_match.group(2).strip().rstrip("):,")
            if not _is_valid_candidate_url(raw_url):
                warnings.append(f"line {i+1}: skipped invalid named URL: {raw_url!r}")
                continue

            normalized = _normalize_candidate_url(raw_url)
            if normalized in seen_normalized:
                continue

            entry = _ParsedEntry(
                url=raw_url,
                title=title if title else None,
                section=current_section,
                line_number=i + 1,
            )
            idx = len(entries)
            entries.append(entry)
            seen_normalized[normalized] = idx
            continue

    return entries, warnings


def _score_candidate(entry: _ParsedEntry, query: str) -> int:
    """Score a candidate by keyword match quality. Higher is better.

    Priority:
    1. Exact query term match in title (highest)
    2. Term match in section/description
    3. Term match in URL
    4. Index order (tie-break via line number)
    """
    if not query.strip():
        return 0

    query_lower = query.lower()
    terms = query_lower.split()
    score = 0

    title = (entry.title or "").lower()
    section = (entry.section or "").lower()
    snippet = (entry.snippet or "").lower()
    url = (entry.url or "").lower()

    for term in terms:
        if term in title:
            score += 10
        if term in section or term in snippet:
            score += 5
        if term in url:
            score += 3

    return score


def _convert_entries_to_raw(
    entries: list[_ParsedEntry],
    query: str,
) -> list[RawDiscoveryCandidate]:
    """Convert parsed entries to RawDiscoveryCandidates with query-based scoring."""
    scored: list[tuple[int, int, RawDiscoveryCandidate]] = []

    for entry in entries:
        score = _score_candidate(entry, query)
        raw = RawDiscoveryCandidate(
            url=entry.url,
            title=entry.title,
            snippet=entry.snippet or entry.section,
            source_engine="llms",
        )
        scored.append((score, entry.line_number, raw))

    # Sort by score desc, then line_number asc (stable)
    scored.sort(key=lambda x: (-x[0], x[1]))

    return [r for _, _, r in scored]


@dataclass(frozen=True)
class LlmsTxtProvider:
    """Discovery provider that fetches and parses an llms.txt/docs-index file.

    CLI usage: --provider llms --url <llms.txt-url>
    follow_redirects controls redirect handling for the source llms.txt fetch only.
    Candidate evidence fetch redirect policy is independent.
    """

    name: str = "llms"
    timeout_seconds: float = 15.0
    follow_redirects: bool = False
    llms_url: str | None = None
    _fetcher: _FetcherProtocol | None = None

    def discover(
        self,
        query: str,
        *,
        max_candidates: int = 10,
        llms_url: str | None = None,
    ) -> DiscoveryResult:
        norm_q = normalize_query(query)
        redacted_q = redact_query(norm_q)

        if not norm_q:
            return DiscoveryResult(
                schema_version="0.1",
                query_original=query,
                query_normalized=norm_q,
                query_redacted=redacted_q,
                provider_name=self.name,
                candidates=(),
                errors=(DiscoveryError(code="empty_query", message="query is empty or whitespace-only"),),
                limitations=(_REDACTION_LIMITATION,),
            )

        if not llms_url:
            llms_url = getattr(self, "llms_url", None)
        if not llms_url:
            return DiscoveryResult(
                schema_version="0.1",
                query_original=query,
                query_normalized=norm_q,
                query_redacted=redacted_q,
                provider_name=self.name,
                candidates=(),
                errors=(DiscoveryError(code="missing_url", message="--url/--llms-url/--docs-index-url is required for llms provider"),),
                limitations=(_REDACTION_LIMITATION,),
            )

        # Validate llms.txt source URL
        policy = _check_url(llms_url)
        if not policy.passed:
            return DiscoveryResult(
                schema_version="0.1",
                query_original=query,
                query_normalized=norm_q,
                query_redacted=redacted_q,
                provider_name=self.name,
                candidates=(),
                errors=(DiscoveryError(
                    code="invalid_index_url",
                    message=f"llms.txt URL blocked by policy: {policy.blocked_reason}",
                ),),
                limitations=(_REDACTION_LIMITATION,),
            )

        # Fetch llms.txt
        fetcher = self._fetcher or _do_fetch
        try:
            fetch_result = fetcher(llms_url, follow_redirects=self.follow_redirects, timeout=self.timeout_seconds)
        except Exception as exc:
            return DiscoveryResult(
                schema_version="0.1",
                query_original=query,
                query_normalized=norm_q,
                query_redacted=redacted_q,
                provider_name=self.name,
                candidates=(),
                errors=(DiscoveryError(code="fetch_error", message=f"failed to fetch llms.txt: {exc}"),),
                limitations=(_REDACTION_LIMITATION,),
            )

        if fetch_result.status != "success":
            return DiscoveryResult(
                schema_version="0.1",
                query_original=query,
                query_normalized=norm_q,
                query_redacted=redacted_q,
                provider_name=self.name,
                candidates=(),
                errors=(DiscoveryError(
                    code="fetch_failed",
                    message=f"llms.txt fetch failed: {fetch_result.http_status} {'; '.join(fetch_result.errors)}",
                ),),
                limitations=(_REDACTION_LIMITATION,),
            )

        if not fetch_result.body_bytes:
            return DiscoveryResult(
                schema_version="0.1",
                query_original=query,
                query_normalized=norm_q,
                query_redacted=redacted_q,
                provider_name=self.name,
                candidates=(),
                errors=(DiscoveryError(code="empty_response", message="llms.txt fetch returned no body"),),
                limitations=(_REDACTION_LIMITATION,),
            )

        # Parse
        entries, parse_warnings = parse_llms_txt(fetch_result.body_bytes, llms_url)

        # Surface parser warnings in limitations (deduped, capped)
        _llms_warnings = tuple(dict.fromkeys(
            f"llms parser warning: {w}" for w in parse_warnings
        ))[:20]

        if not entries:
            return DiscoveryResult(
                schema_version="0.1",
                query_original=query,
                query_normalized=norm_q,
                query_redacted=redacted_q,
                provider_name=self.name,
                candidates=(),
                errors=(DiscoveryError(code="no_entries", message="llms.txt contained no parseable URLs"),),
                limitations=(_REDACTION_LIMITATION,) + _llms_warnings,
            )

        raw_candidates = _convert_entries_to_raw(entries, query)

        result = build_discovery_result(
            query=query,
            provider_name=self.name,
            raw_candidates=raw_candidates,
            max_candidates=max_candidates,
        )
        # Append parser warnings to limitations
        if _llms_warnings:
            result = dc_replace(
                result,
                limitations=result.limitations + _llms_warnings,
            )
        return result


def _do_fetch(url: str, follow_redirects: bool = False, timeout: float = 15.0) -> FetchResult:
    """Internal: fetch a URL using the existing fetch_url function."""
    return _fetch_url(url, follow_redirects=follow_redirects)
