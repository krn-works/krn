"""Discovery contract: data model and validation for query discovery candidates."""

from __future__ import annotations

import re
from collections.abc import Sequence
from dataclasses import dataclass
from typing import Protocol

import httpx

from search_tool.canonical import canonicalize_url_for_dedup as _canonicalize
from search_tool.url_policy import check_url, normalize_url as _normalize_url

SCHEMA_VERSION = "0.1"

_REDACTION_PATTERNS = [
    re.compile(r"\bsk-[A-Za-z0-9_\-]{10,}\b"),
    re.compile(r"\bghp_[A-Za-z0-9]{36,}\b"),
    re.compile(r"\bgho_[A-Za-z0-9]{36,}\b"),
    re.compile(r"\bgithub_pat_[A-Za-z0-9_]{20,}\b"),
    re.compile(r"Bearer\s+[A-Za-z0-9_\-\.]{20,}", re.IGNORECASE),
    re.compile(r"(?:api_key|apikey)\s*=\s*\S+", re.IGNORECASE),
    re.compile(r"(?:token)\s*=\s*\S+", re.IGNORECASE),
    re.compile(r"(?:password|passwd|pwd)\s*=\s*\S+", re.IGNORECASE),
]


@dataclass(frozen=True)
class RawDiscoveryCandidate:
    url: str
    title: str | None = None
    snippet: str | None = None
    source_engine: str | None = None
    rank: int | None = None


@dataclass(frozen=True)
class DiscoveryCandidate:
    rank: int
    url: str
    normalized_url: str | None
    title: str | None
    snippet: str | None
    source_engine: str | None
    url_policy: str  # "passed" | "blocked"
    blocked_reason: str | None
    selected_for_fetch: bool
    duplicate_of: str | None = None


@dataclass(frozen=True)
class DiscoveryError:
    code: str
    message: str


@dataclass(frozen=True)
class DiscoveryResult:
    schema_version: str
    query_original: str
    query_normalized: str
    query_redacted: str
    provider_name: str
    candidates: tuple[DiscoveryCandidate, ...]
    errors: tuple[DiscoveryError, ...]
    limitations: tuple[str, ...]


def normalize_query(query: str) -> str:
    return " ".join(query.split())


def redact_query(query: str) -> str:
    redacted = query
    for pat in _REDACTION_PATTERNS:
        redacted = pat.sub("[REDACTED]", redacted)
    return redacted


def build_discovery_result(
    query: str,
    provider_name: str,
    raw_candidates: Sequence[RawDiscoveryCandidate],
    *,
    max_candidates: int = 10,
) -> DiscoveryResult:
    errors: list[DiscoveryError] = []
    limitations: list[str] = []

    normalized_q = normalize_query(query)
    redacted_q = redact_query(normalized_q)

    if not normalized_q:
        errors.append(DiscoveryError(code="empty_query", message="query is empty or whitespace-only"))
        return DiscoveryResult(
            schema_version=SCHEMA_VERSION,
            query_original=query,
            query_normalized=normalized_q,
            query_redacted=redacted_q,
            provider_name=provider_name.strip() or "unknown",
            candidates=(),
            errors=tuple(errors),
            limitations=tuple(limitations),
        )

    effective_provider = provider_name.strip() or "unknown"
    if not provider_name.strip():
        errors.append(DiscoveryError(code="empty_provider", message="provider_name was empty, using 'unknown'"))

    if max_candidates <= 0:
        errors.append(DiscoveryError(code="max_candidates_zero", message=f"max_candidates={max_candidates}, no candidates processed"))
        limitations.append("No candidates selected because max_candidates <= 0.")
        return DiscoveryResult(
            schema_version=SCHEMA_VERSION,
            query_original=query,
            query_normalized=normalized_q,
            query_redacted=redacted_q,
            provider_name=effective_provider,
            candidates=(),
            errors=tuple(errors),
            limitations=tuple(limitations),
        )

    # Canonical dedup: collapse candidates with the same canonical URL.
    seen_canonical: dict[str, int] = {}
    deduped: list[RawDiscoveryCandidate] = []
    for raw in raw_candidates:
        key = _canonicalize(raw.url)
        if key not in seen_canonical:
            seen_canonical[key] = len(deduped)
            deduped.append(raw)
    collapsed_count = len(raw_candidates) - len(deduped)

    capped = list(deduped[:max_candidates])
    if len(deduped) > max_candidates:
        limitations.append(f"Capped candidates from {len(deduped)} to {max_candidates}.")

    if collapsed_count > 0:
        limitations.append(f"Collapsed {collapsed_count} duplicate candidate URLs by canonical dedup.")

    seen_normalized: dict[str, int] = {}
    candidates: list[DiscoveryCandidate] = []

    for idx, raw in enumerate(capped, start=1):
        policy = check_url(raw.url)
        if not policy.passed:
            candidates.append(DiscoveryCandidate(
                rank=idx,
                url=raw.url,
                normalized_url=None,
                title=raw.title,
                snippet=raw.snippet,
                source_engine=raw.source_engine,
                url_policy="blocked",
                blocked_reason=policy.blocked_reason,
                selected_for_fetch=False,
            ))
            continue

        norm = _normalize_url(raw.url)
        if norm in seen_normalized:
            candidates.append(DiscoveryCandidate(
                rank=idx,
                url=raw.url,
                normalized_url=norm,
                title=raw.title,
                snippet=raw.snippet,
                source_engine=raw.source_engine,
                url_policy="passed",
                blocked_reason=None,
                selected_for_fetch=False,
                duplicate_of=norm,
            ))
            continue

        seen_normalized[norm] = idx
        candidates.append(DiscoveryCandidate(
            rank=idx,
            url=raw.url,
            normalized_url=norm,
            title=raw.title,
            snippet=raw.snippet,
            source_engine=raw.source_engine,
            url_policy="passed",
            blocked_reason=None,
            selected_for_fetch=True,
        ))

    return DiscoveryResult(
        schema_version=SCHEMA_VERSION,
        query_original=query,
        query_normalized=normalized_q,
        query_redacted=redacted_q,
        provider_name=effective_provider,
        candidates=tuple(candidates),
        errors=tuple(errors),
        limitations=tuple(limitations) + ("Query redaction is best-effort and not a security boundary.",),
    )


def urls_for_fetch(result: DiscoveryResult) -> list[str]:
    return [
        c.normalized_url
        for c in result.candidates
        if c.selected_for_fetch and c.normalized_url is not None
    ]


class DiscoveryProvider(Protocol):
    name: str

    def discover(
        self,
        query: str,
        *,
        max_candidates: int = 10,
    ) -> DiscoveryResult: ...


@dataclass(frozen=True)
class StaticDiscoveryProvider:
    name: str
    candidates: tuple[RawDiscoveryCandidate, ...]

    def discover(
        self,
        query: str,
        *,
        max_candidates: int = 10,
    ) -> DiscoveryResult:
        return build_discovery_result(
            query=query,
            provider_name=self.name,
            raw_candidates=self.candidates,
            max_candidates=max_candidates,
        )


def static_provider(
    candidates: Sequence[RawDiscoveryCandidate],
    *,
    name: str = "static",
) -> StaticDiscoveryProvider:
    return StaticDiscoveryProvider(name=name, candidates=tuple(candidates))


@dataclass(frozen=True)
class SearxngDiscoveryProvider:
    base_url: str
    name: str = "searxng"
    timeout_seconds: float = 10.0
    default_language: str | None = None
    default_categories: tuple[str, ...] = ()
    safesearch: int | None = None
    _client: httpx.Client | None = None

    def discover(self, query: str, *, max_candidates: int = 10) -> DiscoveryResult:
        norm_q = normalize_query(query)
        redacted_q = redact_query(norm_q)

        if not norm_q:
            return DiscoveryResult(
                schema_version=SCHEMA_VERSION,
                query_original=query,
                query_normalized=norm_q,
                query_redacted=redacted_q,
                provider_name=self.name,
                candidates=(),
                errors=(DiscoveryError(code="empty_query", message="query is empty or whitespace-only"),),
                limitations=("Query redaction is best-effort and not a security boundary.",),
            )

        policy = check_url(self.base_url, allow_private=True)
        if not policy.passed:
            return DiscoveryResult(
                schema_version=SCHEMA_VERSION,
                query_original=query,
                query_normalized=norm_q,
                query_redacted=redacted_q,
                provider_name=self.name,
                candidates=(),
                errors=(DiscoveryError(code="invalid_base_url", message=f"base_url blocked: {policy.blocked_reason}"),),
                limitations=(
                    "Provider was not contacted due to blocked base_url.",
                    "Query redaction is best-effort and not a security boundary.",
                ),
            )

        base = _normalize_url(self.base_url).rstrip("/")
        endpoint = base + "/search"

        data = {"q": norm_q, "format": "json"}
        if self.default_language is not None:
            data["language"] = self.default_language
        if self.default_categories:
            data["categories"] = ",".join(self.default_categories)
        if self.safesearch is not None:
            data["safesearch"] = str(self.safesearch)

        errors: list[DiscoveryError] = []
        limitations: list[str] = ["Query redaction is best-effort and not a security boundary."]

        client = self._client
        own_client = client is None

        try:
            if client is None:
                client = httpx.Client(
                    trust_env=False,
                    follow_redirects=False,
                    timeout=self.timeout_seconds,
                )
            response = client.post(endpoint, data=data)
        except httpx.TimeoutException:
            errors.append(DiscoveryError(code="timeout", message=f"request timed out after {self.timeout_seconds}s"))
            limitations.append("Provider failed: timeout.")
            return _empty_result(query, norm_q, redacted_q, self.name, errors, limitations)
        except (httpx.ConnectError, httpx.UnsupportedProtocol):
            errors.append(DiscoveryError(code="connection_error", message="failed to connect to SearXNG instance"))
            limitations.append("Provider failed: connection error.")
            return _empty_result(query, norm_q, redacted_q, self.name, errors, limitations)
        except Exception as exc:
            errors.append(DiscoveryError(code="unexpected_error", message=f"unexpected error: {exc}"))
            limitations.append("Provider failed: unexpected error.")
            return _empty_result(query, norm_q, redacted_q, self.name, errors, limitations)
        finally:
            if own_client and client is not None:
                client.close()

        if 300 <= response.status_code < 400:
            errors.append(DiscoveryError(
                code="redirect_not_followed",
                message=f"server returned redirect ({response.status_code}); redirects are not followed",
            ))
            limitations.append("Provider failed: redirect response not followed.")
            return _empty_result(query, norm_q, redacted_q, self.name, errors, limitations)

        if response.status_code == 403:
            errors.append(DiscoveryError(
                code="api_forbidden",
                message="HTTP 403 — JSON format likely disabled in settings.yml (search.formats must include 'json')",
            ))
            limitations.append("Provider failed: API forbidden. Check that 'json' is in search.formats in settings.yml.")
            return _empty_result(query, norm_q, redacted_q, self.name, errors, limitations)

        if response.status_code == 429:
            errors.append(DiscoveryError(code="rate_limited", message="HTTP 429 — rate limited by SearXNG instance"))
            limitations.append("Provider failed: rate limited.")
            return _empty_result(query, norm_q, redacted_q, self.name, errors, limitations)

        if 500 <= response.status_code < 600:
            errors.append(DiscoveryError(code="server_error", message=f"HTTP {response.status_code} — SearXNG server error"))
            limitations.append("Provider failed: server error.")
            return _empty_result(query, norm_q, redacted_q, self.name, errors, limitations)

        if response.status_code != 200:
            errors.append(DiscoveryError(code="unexpected_status", message=f"unexpected HTTP {response.status_code}"))
            limitations.append("Provider returned unexpected status code.")
            return _empty_result(query, norm_q, redacted_q, self.name, errors, limitations)

        try:
            body = response.json()
        except Exception:
            errors.append(DiscoveryError(code="malformed_response", message="response is not valid JSON"))
            limitations.append("Provider failed: malformed JSON response.")
            return _empty_result(query, norm_q, redacted_q, self.name, errors, limitations)

        if not isinstance(body, dict):
            errors.append(DiscoveryError(code="invalid_response", message="response JSON is not an object"))
            limitations.append("Provider failed: invalid response structure.")
            return _empty_result(query, norm_q, redacted_q, self.name, errors, limitations)

        raw_results = body.get("results")
        if not isinstance(raw_results, list):
            errors.append(DiscoveryError(code="invalid_response", message="response missing 'results' array"))
            limitations.append("Provider failed: invalid response structure.")
            return _empty_result(query, norm_q, redacted_q, self.name, errors, limitations)

        parse_errors: list[DiscoveryError] = []
        raw_candidates: list[RawDiscoveryCandidate] = []

        for item in raw_results:
            if not isinstance(item, dict):
                continue
            url_val = item.get("url")
            if not isinstance(url_val, str) or not url_val.strip():
                parse_errors.append(DiscoveryError(
                    code="skipped_result",
                    message="result missing or invalid 'url' field",
                ))
                continue
            raw_candidates.append(RawDiscoveryCandidate(
                url=url_val,
                title=item.get("title") or None,
                snippet=item.get("content") or None,
                source_engine="searxng",
            ))

        result = build_discovery_result(
            query=query,
            provider_name=self.name,
            raw_candidates=raw_candidates,
            max_candidates=max_candidates,
        )
        if parse_errors:
            return DiscoveryResult(
                schema_version=result.schema_version,
                query_original=result.query_original,
                query_normalized=result.query_normalized,
                query_redacted=result.query_redacted,
                provider_name=result.provider_name,
                candidates=result.candidates,
                errors=result.errors + tuple(parse_errors),
                limitations=result.limitations,
            )
        return result


def _empty_result(
    query_original: str,
    query_normalized: str,
    query_redacted: str,
    provider_name: str,
    errors: list[DiscoveryError],
    limitations: list[str],
) -> DiscoveryResult:
    return DiscoveryResult(
        schema_version=SCHEMA_VERSION,
        query_original=query_original,
        query_normalized=query_normalized,
        query_redacted=query_redacted,
        provider_name=provider_name,
        candidates=(),
        errors=tuple(errors),
        limitations=tuple(limitations),
    )
