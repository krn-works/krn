"""Search query composition: discover candidates then fetch evidence."""

from __future__ import annotations

import hashlib
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlparse, urlunparse

import json as _json

from search_tool.canonical import canonicalize_url_for_dedup
from search_tool.discovery import DiscoveryResult, DiscoveryProvider, urls_for_fetch, redact_query
from search_tool.evidence import EVIDENCE_DIR, SAFETY_NOTICE, _yaml_safe
from search_tool.relevance import tokenize_query, score_candidate_relevance, score_evidence_relevance, EvidenceComponents
from search_tool.source_quality import classify_source_quality


@dataclass(frozen=True)
class EvidenceWriteResult:
    original_url: str
    normalized_url: str
    evidence_path: Path
    fetch_status: str
    http_status: int | None
    cache_status: str
    extraction_status: str
    text_chars: int
    truncated: bool
    errors: tuple[str, ...]
    limitations: tuple[str, ...]
    final_url: str | None = None
    dedup_status: str = "unique"
    duplicate_of_url: str | None = None
    duplicate_of_evidence_path: Path | None = None


@dataclass(frozen=True)
class EvidenceRelevanceEntry:
    url: str
    score: float
    components: EvidenceComponents


def _quality_score(result: EvidenceWriteResult) -> int:
    """Fetch/extraction outcome score 0-3. Not a content-usefulness assessment.

    0 = blocked or fetch failed
    1 = fetch succeeded but extraction skipped or failed
    2 = fetch and extraction succeeded but content was truncated
    3 = fetch and extraction fully succeeded
    """
    if result.fetch_status == "blocked":
        return 0
    if result.fetch_status == "failed":
        return 0
    if result.extraction_status == "skipped":
        return 1
    if result.extraction_status == "failed":
        return 1
    if result.truncated:
        return 2
    return 3


def _md_table_safe(text: str) -> str:
    """Escape text for safe use inside a Markdown table cell."""
    return (
        text.replace("\\", "\\\\")
        .replace("|", "\\|")
        .replace("<", "\\<")
        .replace(">", "\\>")
    )


@dataclass(frozen=True)
class SearchRunResult:
    discovery: DiscoveryResult
    evidence_results: tuple[EvidenceWriteResult, ...]
    manifest_path: Path | None
    search_manifest_path: Path | None
    limitations: tuple[str, ...]
    discovery_diagnostics_path: Path | None = None
    evidence_relevance: tuple[EvidenceRelevanceEntry, ...] = ()


def write_search_run_manifest(
    *,
    discovery: DiscoveryResult,
    evidence_results: tuple[EvidenceWriteResult, ...],
    fetch_list_manifest: Path | None,
    query: str,
    provider_config: Mapping[str, object] | None = None,
    refresh: bool = False,
    follow_redirects: bool = False,
    evidence_dir: Path | None = None,
    limitations: tuple[str, ...] | None = None,
    evidence_relevance: tuple[EvidenceRelevanceEntry, ...] = (),
) -> Path:
    """Write a Markdown search-run manifest with YAML frontmatter."""
    now = datetime.now(timezone.utc)
    ts = now.strftime("%Y%m%dT%H%M%SZ")

    # Hash for filename uniqueness: (query_redacted, provider_name, selected_count, ts)
    selected_count = sum(1 for c in discovery.candidates if c.selected_for_fetch)
    hash_input = f"{discovery.query_redacted}|{discovery.provider_name}|{selected_count}|{ts}"
    run_hash = hashlib.sha256(hash_input.encode()).hexdigest()[:12]

    target_dir = evidence_dir or EVIDENCE_DIR
    target_dir.mkdir(parents=True, exist_ok=True)
    manifest_path = target_dir / f"search-{ts}-{run_hash}.md"

    original_sha256 = hashlib.sha256(query.encode()).hexdigest()

    # Summarize discovery
    discovery_total = len(discovery.candidates)
    discovery_selected = selected_count
    discovery_blocked = sum(1 for c in discovery.candidates if c.url_policy == "blocked")
    discovery_duplicates = sum(1 for c in discovery.candidates if c.duplicate_of is not None)
    discovery_errors = len(discovery.errors)

    # Summarize fetch
    fetch_requested = len(evidence_results)
    fetch_evidence = sum(1 for r in evidence_results if r.fetch_status in ("success",) and r.extraction_status in ("success", "truncated"))
    fetch_succeeded = sum(1 for r in evidence_results if r.fetch_status == "success" and r.extraction_status in ("success", "truncated"))
    fetch_blocked = sum(1 for r in evidence_results if r.fetch_status == "blocked")
    fetch_failed = sum(1 for r in evidence_results if r.fetch_status == "failed" or (r.fetch_status == "success" and r.extraction_status in ("failed", "skipped")))
    fetch_skipped = sum(1 for r in evidence_results if r.fetch_status == "skipped_duplicate")

    lines: list[str] = []
    lines.append("---")
    lines.append('schema_version: "0.1"')
    lines.append('artifact_type: "search_run_manifest"')
    lines.append(f'generated_at_utc: "{now.isoformat()}"')
    lines.append("command:")
    lines.append('  name: "search-query"')
    lines.append(f"  refresh: {str(refresh).lower()}")
    lines.append(f"  follow_redirects: {str(follow_redirects).lower()}")
    lines.append("query:")
    lines.append(f'  original_sha256: "{original_sha256}"')
    lines.append(f'  redacted: "{_yaml_safe(discovery.query_redacted)}"')
    lines.append("provider:")
    lines.append(f'  name: "{_yaml_safe(discovery.provider_name)}"')
    if provider_config:
        lines.append("  config:")
        # Blacklist sensitive keys that should never be written to the manifest
        blacklist = {"searxng_url", "api_key", "password", "token", "secret"}
        for k, v in provider_config.items():
            if k.lower() in blacklist:
                continue
            if isinstance(v, (str, int, float, bool)) or v is None:
                val = _yaml_safe(str(v)) if isinstance(v, str) else str(v).lower() if isinstance(v, bool) else v
                if v is None:
                    lines.append(f"    {k}: null")
                elif isinstance(v, str):
                    lines.append(f'    {k}: "{val}"')
                else:
                    lines.append(f"    {k}: {val}")
            elif isinstance(v, (list, tuple)):
                lines.append(f"    {k}: {list(v)}")

    lines.append("discovery:")
    lines.append(f"  candidates_total: {discovery_total}")
    lines.append(f"  selected_for_fetch: {discovery_selected}")
    lines.append(f"  blocked: {discovery_blocked}")
    lines.append(f"  duplicates: {discovery_duplicates}")
    lines.append(f"  errors: {discovery_errors}")
    lines.append("fetch:")
    lines.append(f"  requested_urls: {fetch_requested}")
    lines.append(f"  evidence_packs: {fetch_evidence}")
    lines.append(f"  succeeded: {fetch_succeeded}")
    lines.append(f"  blocked: {fetch_blocked}")
    lines.append(f"  failed: {fetch_failed}")
    lines.append(f"  skipped_duplicates: {fetch_skipped}")
    lines.append("artifacts:")
    if fetch_list_manifest:
        lines.append(f'  fetch_list_manifest: "{_yaml_safe(str(fetch_list_manifest))}"')
    else:
        lines.append("  fetch_list_manifest: null")
    lines.append("limitations:")
    all_limitations = (list(limitations) if limitations else list(discovery.limitations))
    for lim in all_limitations:
        lines.append(f'  - "{_yaml_safe(lim)}"')
    if evidence_relevance:
        lines.append("evidence_relevance:")
        for er in evidence_relevance:
            lines.append(f'  - url: "{_yaml_safe(er.url)}"')
            lines.append(f"    score: {er.score}")
    lines.append("---")
    lines.append("")
    lines.append("# Search Run Manifest")
    lines.append("")
    lines.append("## Query")
    lines.append(f"- **Redacted:** `{discovery.query_redacted}`")
    lines.append(f"- **Original SHA-256:** `{original_sha256}`")
    lines.append("")
    lines.append("## Provider")
    lines.append(f"- **Name:** {discovery.provider_name}")
    if provider_config and "searxng_url_redacted" in provider_config:
        lines.append(f"- **Instance:** {provider_config['searxng_url_redacted']}")
    lines.append("")
    lines.append("## Discovery Summary")
    lines.append(f"- **Total candidates:** {discovery_total}")
    lines.append(f"- **Selected for fetch:** {discovery_selected}")
    lines.append(f"- **Blocked:** {discovery_blocked}")
    lines.append(f"- **Duplicates:** {discovery_duplicates}")
    lines.append("")

    if discovery_selected > 0:
        lines.append("### Selected URLs")
        lines.append("")
        lines.append("| Rank | URL | Title |")
        lines.append("|------|-----|-------|")
        for c in discovery.candidates:
            if c.selected_for_fetch:
                safe_url = _md_table_safe(c.url)
                safe_title = _md_table_safe(c.title or "")
                lines.append(f"| {c.rank} | {safe_url} | {safe_title} |")
        lines.append("")

    if discovery_blocked > 0:
        lines.append("### Blocked Candidates")
        lines.append("")
        lines.append("| Rank | URL | Reason |")
        lines.append("|------|-----|--------|")
        for c in discovery.candidates:
            if c.url_policy == "blocked":
                safe_url = _md_table_safe(c.url)
                safe_reason = _md_table_safe(c.blocked_reason or "Unknown reason")
                lines.append(f"| {c.rank} | {safe_url} | {safe_reason} |")
        lines.append("")

    if discovery_duplicates > 0:
        lines.append("### Duplicate Candidates")
        lines.append("")
        lines.append("| Rank | URL | Duplicate Of |")
        lines.append("|------|-----|--------------|")
        for c in discovery.candidates:
            if c.duplicate_of:
                safe_url = _md_table_safe(c.url)
                safe_dup = _md_table_safe(c.duplicate_of)
                lines.append(f"| {c.rank} | {safe_url} | {safe_dup} |")
        lines.append("")

    if discovery_errors > 0:
        lines.append("### Discovery Errors")
        lines.append("")
        for err in discovery.errors:
            lines.append(f"- **{err.code}:** {err.message}")
        lines.append("")

    lines.append("## Fetch Summary")
    lines.append(f"- **Requested:** {fetch_requested}")
    lines.append(f"- **Evidence packs written:** {fetch_evidence}")
    lines.append(f"- **Succeeded:** {fetch_succeeded}")
    lines.append(f"- **Failed/Blocked:** {fetch_failed + fetch_blocked}")
    if fetch_skipped > 0:
        lines.append(f"- **Skipped duplicates:** {fetch_skipped}")
    lines.append("")

    lines.append("## Safety notice")
    lines.append("")
    lines.append(SAFETY_NOTICE)
    lines.append("")

    lines.append("## Artifacts")
    if fetch_list_manifest:
        rel_path = fetch_list_manifest.name
        lines.append(f"- [Fetch List Manifest]({rel_path})")
    else:
        lines.append("- _None recorded._")
    lines.append("")

    lines.append("## Limitations")
    all_limitations = (list(limitations) if limitations else list(discovery.limitations))
    for lim in all_limitations:
        lines.append(f"- {lim}")
    if not fetch_list_manifest:
        lines.append("- Fetch list manifest was not written or could not be linked.")
    lines.append("")

    content = "\n".join(lines)
    manifest_path.write_text(content, encoding="utf-8")
    return manifest_path


def _redact_url_for_diagnostics(url: str) -> str:
    """Strip username/password from URL for diagnostics artifact output."""
    try:
        parsed = urlparse(url)
        host = parsed.hostname or ""
        if not host:
            return "[REDACTED_URL]"
        netloc = host
        if parsed.port is not None:
            netloc = f"{host}:{parsed.port}"
        return urlunparse((
            parsed.scheme,
            netloc,
            parsed.path,
            parsed.params,
            parsed.query,
            parsed.fragment,
        ))
    except Exception:
        return "[REDACTED_URL]"


def write_discovery_diagnostics(
    *,
    discovery: DiscoveryResult,
    query: str,
    target_dir: Path,
) -> Path:
    """Write a JSON diagnostics artifact recording discovery-stage accounting."""
    query_hash = hashlib.sha256(query.encode()).hexdigest()

    selected = [c for c in discovery.candidates if c.selected_for_fetch]
    blocked = [c for c in discovery.candidates if c.url_policy == "blocked"]
    duplicates = [c for c in discovery.candidates if c.duplicate_of is not None]

    qt = tokenize_query(query)
    selected_entries = []
    for c in selected:
        safe_url = _redact_url_for_diagnostics(c.url)
        sq = classify_source_quality(safe_url, c.title)
        cr = score_candidate_relevance(qt, c, sq)
        selected_entries.append({
            "rank": c.rank,
            "url": safe_url,
            "title": c.title,
            "snippet": c.snippet,
            "source_engine": c.source_engine,
            "source_quality": {
                "source_type": sq.source_type,
                "authority_score": sq.authority_score,
                "is_official": sq.is_official,
                "is_primary_source": sq.is_primary_source,
                "domain": sq.domain,
                "reason": sq.reason,
            },
            "candidate_relevance": {
                "score": cr.score,
                "components": {
                    "title_overlap": cr.components.title_overlap,
                    "snippet_overlap": cr.components.snippet_overlap,
                    "url_path_overlap": cr.components.url_path_overlap,
                    "exact_phrase_in_title": cr.components.exact_phrase_in_title,
                    "exact_phrase_in_snippet": cr.components.exact_phrase_in_snippet,
                    "source_quality_modifier": cr.components.source_quality_modifier,
                    "generic_page_penalty": cr.components.generic_page_penalty,
                },
            },
        })

    blocked_entries = [
        {"rank": c.rank, "url": _redact_url_for_diagnostics(c.url), "reason": c.blocked_reason}
        for c in blocked
    ]

    duplicate_entries = [
        {"rank": c.rank, "url": _redact_url_for_diagnostics(c.url), "duplicate_of": _redact_url_for_diagnostics(c.duplicate_of) if c.duplicate_of else None}
        for c in duplicates
    ]

    error_entries = [
        {"code": e.code, "message": e.message}
        for e in discovery.errors
    ]

    diagnostics = {
        "schema_version": "0.1",
        "artifact_type": "discovery_diagnostics",
        "query": {
            "hash_sha256": query_hash,
            "redacted": discovery.query_redacted,
        },
        "provider_name": discovery.provider_name,
        "candidates_total": len(discovery.candidates),
        "selected_for_fetch": len(selected),
        "blocked_candidates": blocked_entries,
        "duplicate_candidates": duplicate_entries,
        "selected_candidates": selected_entries,
        "discovery_errors": error_entries,
        "discovery_limitations": list(discovery.limitations),
    }

    target_dir.mkdir(parents=True, exist_ok=True)
    path = target_dir / "discovery-diagnostics.json"
    path.write_text(_json.dumps(diagnostics, indent=2, ensure_ascii=False), encoding="utf-8")
    return path


def search_query(
    provider: DiscoveryProvider,
    query: str,
    *,
    max_candidates: int = 10,
    refresh: bool = False,
    follow_redirects: bool = False,
    fetcher: Callable[..., EvidenceWriteResult],
    manifest_writer: Callable[..., Path] | None = None,
    search_manifest_writer: Callable[..., Path] | None = None,
    provider_config: Mapping[str, object] | None = None,
    evidence_dir: Path | None = None,
    cache_dir: Path | None = None,
) -> SearchRunResult:
    discovery = provider.discover(query, max_candidates=max_candidates)
    fetch_urls = urls_for_fetch(discovery)

    discovery_diagnostics_path = None
    if evidence_dir is not None:
        try:
            discovery_diagnostics_path = write_discovery_diagnostics(
                discovery=discovery, query=query, target_dir=evidence_dir,
            )
        except Exception:
            discovery_diagnostics_path = None

    if not fetch_urls:
        if manifest_writer is not None:
            try:
                manifest_path = manifest_writer([], "search-query", refresh)
            except Exception:
                manifest_path = None
        else:
            manifest_path = None

        search_manifest_path = None
        if search_manifest_writer is not None:
            try:
                search_manifest_path = search_manifest_writer(
                    discovery=discovery,
                    evidence_results=(),
                    fetch_list_manifest=manifest_path,
                    query=query,
                    provider_config=provider_config,
                    refresh=refresh,
                    follow_redirects=follow_redirects,
                    evidence_dir=evidence_dir,
                )
            except Exception:
                search_manifest_path = None

        return SearchRunResult(
            discovery=discovery,
            evidence_results=(),
            manifest_path=manifest_path,
            search_manifest_path=search_manifest_path,
            discovery_diagnostics_path=discovery_diagnostics_path,
            limitations=discovery.limitations,
        )

    evidence_results: list[EvidenceWriteResult] = []
    # Build dedup registry before fetch loop (M.7: skip extraction).
    dedup_registry: dict[str, EvidenceWriteResult] = {}
    for url in fetch_urls:
        result = fetcher(url, refresh, follow_redirects, _final_url_dedup_registry=dedup_registry)
        evidence_results.append(result)

    # Count skipped and remaining duplicates for limitations (M.7: skip extraction).
    # M.6 post-processing: populate dedup metadata on duplicates that
    # weren't already marked by the in-fetcher dedup (e.g. fake fetchers
    # in tests that bypass fetch_url_to_evidence).
    skipped_count = 0
    seen_final_urls: dict[str, tuple[int, EvidenceWriteResult]] = {}
    duplicate_count = 0
    for i, er in enumerate(evidence_results):
        if er.fetch_status == "skipped_duplicate":
            skipped_count += 1
            duplicate_count += 1
            continue
        if er.fetch_status != "success" or er.final_url is None:
            continue
        key = canonicalize_url_for_dedup(er.final_url)
        if key not in seen_final_urls:
            seen_final_urls[key] = (i, er)
        else:
            duplicate_count += 1
            _, kept = seen_final_urls[key]
            # Already marked by in-fetcher dedup — skip re-marking.
            if er.dedup_status == "duplicate_final_url":
                continue
            evidence_results[i] = EvidenceWriteResult(
                original_url=er.original_url,
                normalized_url=er.normalized_url,
                evidence_path=er.evidence_path,
                fetch_status=er.fetch_status,
                http_status=er.http_status,
                cache_status=er.cache_status,
                extraction_status=er.extraction_status,
                text_chars=er.text_chars,
                truncated=er.truncated,
                errors=er.errors,
                limitations=er.limitations,
                final_url=er.final_url,
                dedup_status="duplicate_final_url",
                duplicate_of_url=kept.final_url,
                duplicate_of_evidence_path=kept.evidence_path,
            )

    limitations = list(discovery.limitations)
    if duplicate_count > 0:
        if skipped_count > 0:
            limitations.append(
                f"Skipped {skipped_count} duplicate fetched URLs by final_url canonical dedup."
            )
        else:
            limitations.append(
                f"Detected {duplicate_count} duplicate fetched URLs by final_url canonical dedup."
            )

    # Compute evidence relevance (post-fetch textual overlap)
    qt = tokenize_query(query)
    evidence_relevance_entries: list[EvidenceRelevanceEntry] = []
    for er in evidence_results:
        ev_rel = score_evidence_relevance(
            qt, er.evidence_path,
            fetch_status=er.fetch_status,
            extraction_status=er.extraction_status,
        )
        url = er.final_url or er.normalized_url
        evidence_relevance_entries.append(EvidenceRelevanceEntry(
            url=url,
            score=ev_rel.score,
            components=ev_rel.components,
        ))

    manifest_path = None
    if manifest_writer is not None:
        try:
            manifest_path = manifest_writer(evidence_results, "search-query", refresh)
        except Exception:
            manifest_path = None

    search_manifest_path = None
    if search_manifest_writer is not None:
        try:
            search_manifest_path = search_manifest_writer(
                discovery=discovery,
                evidence_results=tuple(evidence_results),
                fetch_list_manifest=manifest_path,
                query=query,
                provider_config=provider_config,
                refresh=refresh,
                follow_redirects=follow_redirects,
                limitations=tuple(limitations),
                evidence_relevance=tuple(evidence_relevance_entries),
            )
        except Exception:
            search_manifest_path = None

    return SearchRunResult(
        discovery=discovery,
        evidence_results=tuple(evidence_results),
        manifest_path=manifest_path,
        search_manifest_path=search_manifest_path,
        discovery_diagnostics_path=discovery_diagnostics_path,
        limitations=tuple(limitations),
        evidence_relevance=tuple(evidence_relevance_entries),
    )
