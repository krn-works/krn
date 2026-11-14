"""Core run functions for the search tool pipeline."""

from __future__ import annotations

import hashlib
from datetime import datetime, timezone
from pathlib import Path

from search_tool.cache import get as cache_get, put as cache_put
from search_tool.evidence import build_evidence_pack, write_evidence_pack, EVIDENCE_DIR, SAFETY_NOTICE, _yaml_safe
from search_tool.extract import extract
from search_tool.fetch import FetchResult, fetch_url, MAX_REDIRECTS
from search_tool.url_policy import check_url, normalize_url
from search_tool.canonical import canonicalize_url_for_dedup
from search_tool.search import EvidenceWriteResult, _quality_score, _md_table_safe


class InputError(Exception):
    """Input contract violation (missing file, too many URLs, etc.)."""


def _blocked_fetch() -> FetchResult:
    return FetchResult(status="blocked", errors=[], limitations=[])


def _failed_fetch(errors: list[str]) -> FetchResult:
    return FetchResult(status="failed", errors=errors, limitations=[])


def fetch_url_to_evidence(
    url: str,
    refresh: bool,
    follow_redirects: bool = False,
    evidence_dir: Path | None = None,
    cache_dir: Path | None = None,
    _final_url_dedup_registry: dict[str, EvidenceWriteResult] | None = None,
) -> EvidenceWriteResult:
    """Run the full single-URL fetch/cache/extract/evidence/write pipeline.

    Returns a structured result. Callers decide what to do with it
    (print path, collect for batch, etc.).

    When ``_final_url_dedup_registry`` is provided, this function checks
    whether the fetched final_url is a duplicate of a previously succeeded
    result.  If so it returns a synthetic result with
    ``fetch_status="skipped_duplicate"`` pointing to the kept evidence
    pack — no extraction or evidence file is written.
    """
    policy = check_url(url)

    if not policy.passed:
        normalized = normalize_url(url)
        extraction = extract(None, None)
        pack = build_evidence_pack(
            original_url=url,
            normalized_url=normalized,
            url_policy=policy,
            fetch=_blocked_fetch(),
            extraction=extraction,
            cache_status="not_written",
            cache_key=None,
            cache_body_ref=None,
            refresh=refresh,
        )
        path = write_evidence_pack(pack, normalized, evidence_dir=evidence_dir)
        return EvidenceWriteResult(
            original_url=url,
            normalized_url=normalized,
            evidence_path=path,
            fetch_status="blocked",
            http_status=None,
            cache_status="not_written",
            extraction_status=extraction.status,
            text_chars=extraction.text_chars,
            truncated=extraction.truncated,
            errors=tuple(policy.blocked_reason.split(". ") if policy.blocked_reason else []),
            limitations=(),
        )

    normalized = normalize_url(url)

    cache_result = cache_get(normalized, refresh, follow_redirects=follow_redirects, max_redirects=MAX_REDIRECTS, cache_dir=cache_dir)

    if cache_result.status == "hit":
        metadata = cache_result.cached_metadata or {}
        cached_body = cache_result.cached_body
        fetch_result = FetchResult(
            status="success",
            http_status=metadata.get("http_status"),
            content_type=metadata.get("content_type"),
            content_length_bytes=len(cached_body) if cached_body else None,
            body_bytes=cached_body,
            body_sha256=metadata.get("body_sha256"),
            redirects=metadata.get("redirects", []),
            errors=[],
            limitations=["Content served from filesystem cache."],
        )

        final_url_override = None
        if follow_redirects and fetch_result.redirects:
            final_hop = fetch_result.redirects[-1]
            final_url_override = final_hop.get("resolved_url") or normalize_url(url)
        elif follow_redirects and not fetch_result.redirects:
            # No redirects — the final URL is the fetched URL itself.
            final_url_override = normalized

        # Pre-extraction dedup check (M.7: skip duplicate extraction).
        skip_result = _maybe_skip_duplicate(
            url=url,
            normalized=normalized,
            cache_result=cache_result,
            fetch_result=fetch_result,
            final_url_override=final_url_override,
            follow_redirects=follow_redirects,
            dedup_registry=_final_url_dedup_registry,
        )
        if skip_result is not None:
            return skip_result

        extraction_result = extract(cached_body, fetch_result.content_type)

        pack = build_evidence_pack(
            original_url=url,
            normalized_url=normalized,
            url_policy=policy,
            fetch=fetch_result,
            extraction=extraction_result,
            cache_status="hit",
            cache_key=cache_result.key,
            cache_body_ref=cache_result.body_cache_ref,
            refresh=refresh,
            final_url_override=final_url_override,
        )
        path = write_evidence_pack(pack, normalized, evidence_dir=evidence_dir)

        # Register in dedup registry on successful write.
        _maybe_register_final_url(
            path=path,
            fetch_status="success",
            final_url_override=final_url_override,
            original_url=url,
            normalized_url=normalized,
            dedup_registry=_final_url_dedup_registry,
        )

        return EvidenceWriteResult(
            original_url=url,
            normalized_url=normalized,
            evidence_path=path,
            fetch_status=fetch_result.status,
            http_status=fetch_result.http_status,
            cache_status="hit",
            extraction_status=extraction_result.status,
            text_chars=extraction_result.text_chars,
            truncated=extraction_result.truncated,
            errors=tuple(fetch_result.errors + extraction_result.errors),
            limitations=tuple(fetch_result.limitations + extraction_result.limitations),
            final_url=final_url_override,
        )

    try:
        fetch_result = fetch_url(url, follow_redirects=follow_redirects)
    except Exception as e:
        fetch_result = _failed_fetch([str(e)])

    # Determine final_url for followed redirects
    final_url_override = None
    if follow_redirects and fetch_result.status == "success" and fetch_result.redirects:
        final_hop = fetch_result.redirects[-1]
        final_url_override = final_hop.get("resolved_url") or normalize_url(url)
    elif follow_redirects and fetch_result.status == "success" and not fetch_result.redirects:
        # No redirects — the final URL is the fetched URL itself.
        final_url_override = normalized

    cache_put_result = None
    if fetch_result.status == "success" and fetch_result.body_bytes:
        cache_put_result = cache_put(
            normalized,
            fetch_result.body_bytes,
            metadata={
                "http_status": fetch_result.http_status,
                "content_type": fetch_result.content_type,
                "body_sha256": fetch_result.body_sha256,
                "redirects": fetch_result.redirects,
                "follow_redirects": follow_redirects,
                "max_redirects": MAX_REDIRECTS,
            },
            follow_redirects=follow_redirects,
            max_redirects=MAX_REDIRECTS,
            cache_dir=cache_dir,
        )

    # Pre-extraction dedup check (M.7: skip duplicate extraction).
    skip_result = _maybe_skip_duplicate(
        url=url,
        normalized=normalized,
        cache_result=cache_result,
        fetch_result=fetch_result,
        final_url_override=final_url_override,
        follow_redirects=follow_redirects,
        dedup_registry=_final_url_dedup_registry,
    )
    if skip_result is not None:
        return skip_result

    extraction_result = extract(fetch_result.body_bytes, fetch_result.content_type)

    if cache_result.status == "bypass":
        cache_status = "bypass"
    elif cache_put_result and cache_put_result.body_cache_ref:
        cache_status = "miss"
    else:
        cache_status = "not_written"

    pack = build_evidence_pack(
        original_url=url,
        normalized_url=normalized,
        url_policy=policy,
        fetch=fetch_result,
        extraction=extraction_result,
        cache_status=cache_status,
        cache_key=(cache_put_result.key if cache_put_result else None) or cache_result.key,
        cache_body_ref=cache_put_result.body_cache_ref if cache_put_result else None,
        refresh=refresh,
        final_url_override=final_url_override,
    )
    path = write_evidence_pack(pack, normalized, evidence_dir=evidence_dir)

    # Register in dedup registry on successful write.
    _maybe_register_final_url(
        path=path,
        fetch_status=fetch_result.status,
        final_url_override=final_url_override,
        original_url=url,
        normalized_url=normalized,
        dedup_registry=_final_url_dedup_registry,
    )

    return EvidenceWriteResult(
        original_url=url,
        normalized_url=normalized,
        evidence_path=path,
        fetch_status=fetch_result.status,
        http_status=fetch_result.http_status,
        cache_status=cache_status,
        extraction_status=extraction_result.status,
        text_chars=extraction_result.text_chars,
        truncated=extraction_result.truncated,
        errors=tuple(fetch_result.errors + extraction_result.errors),
        limitations=tuple(fetch_result.limitations + extraction_result.limitations),
        final_url=final_url_override,
    )


def _maybe_skip_duplicate(url, normalized, cache_result, fetch_result, final_url_override, follow_redirects, dedup_registry):
    """Return a synthetic EvidenceWriteResult if this URL is a duplicate final_url.

    Returns ``None`` when the URL should be extracted normally.
    """
    if dedup_registry is None:
        return None
    if not follow_redirects:
        return None
    if final_url_override is None:
        return None
    if fetch_result.status != "success":
        return None

    key = canonicalize_url_for_dedup(final_url_override)
    if key not in dedup_registry:
        return None

    kept = dedup_registry[key]
    # Duplicate! Return synthetic result without extraction or writing.
    http_status = fetch_result.http_status
    cache_status = cache_result.status
    if cache_status == "bypass":
        cache_status = "bypass"
    return EvidenceWriteResult(
        original_url=url,
        normalized_url=normalized,
        evidence_path=kept.evidence_path,
        fetch_status="skipped_duplicate",
        http_status=http_status,
        cache_status=cache_status,
        extraction_status="skipped",
        text_chars=0,
        truncated=False,
        errors=(),
        limitations=(),
        final_url=final_url_override,
        dedup_status="duplicate_final_url",
        duplicate_of_url=kept.final_url,
        duplicate_of_evidence_path=kept.evidence_path,
    )


def _maybe_register_final_url(path, fetch_status, final_url_override, original_url, normalized_url, dedup_registry):
    """Register a successfully written final_url in the dedup registry.

    Only registers successful fetches so failed/blocked results don't
    prevent future matches.
    """
    if dedup_registry is None:
        return
    if fetch_status != "success":
        return
    if final_url_override is None:
        return

    key = canonicalize_url_for_dedup(final_url_override)
    if key not in dedup_registry:
        # Register placeholder; the real result will be returned from
        # fetch_url_to_evidence().  We store a minimal entry keyed by
        # the canonical final_url.
        dedup_registry[key] = EvidenceWriteResult(
            original_url=original_url,
            normalized_url=normalized_url,
            evidence_path=path,
            fetch_status="success",
            http_status=None,
            cache_status="miss",
            extraction_status="success",
            text_chars=0,
            truncated=False,
            errors=(),
            limitations=(),
            final_url=final_url_override,
        )


def write_fetch_list_manifest(
    results: list[EvidenceWriteResult] | tuple[EvidenceWriteResult, ...],
    source_name: str,
    refresh: bool,
    evidence_dir: Path | None = None,
) -> Path:
    """Write a Markdown manifest with YAML frontmatter linking to evidence packs."""
    now = datetime.now(timezone.utc)
    ts = now.strftime("%Y%m%dT%H%M%SZ")

    url_list_str = "\n".join(r.original_url for r in results)
    url_hash = hashlib.sha256(url_list_str.encode()).hexdigest()[:12]

    target_dir = evidence_dir or EVIDENCE_DIR
    target_dir.mkdir(parents=True, exist_ok=True)
    manifest_path = target_dir / f"manifest-{ts}-{url_hash}.md"

    succeeded = sum(1 for r in results if r.fetch_status == "success" and r.extraction_status in ("success", "truncated"))
    blocked = sum(1 for r in results if r.fetch_status == "blocked")
    failed = sum(1 for r in results if r.fetch_status in ("failed",) or (r.fetch_status == "success" and r.extraction_status in ("failed", "skipped")))
    skipped = sum(1 for r in results if r.fetch_status == "skipped_duplicate")
    unique_urls = len(set(r.normalized_url for r in results))

    cache_hit = sum(1 for r in results if r.cache_status == "hit")
    cache_miss = sum(1 for r in results if r.cache_status == "miss")
    cache_bypass = sum(1 for r in results if r.cache_status == "bypass")
    cache_not_written = sum(1 for r in results if r.cache_status == "not_written")

    total_errors = sum(len(r.errors) for r in results)
    total_limitations = sum(len(r.limitations) for r in results)

    lines: list[str] = []
    lines.append("---")
    lines.append('manifest_version: "0.1"')
    lines.append('schema_version: "0.1"')
    lines.append(f'generated_at_utc: "{now.isoformat()}"')
    lines.append("tool:")
    lines.append('  name: "krn-search-lab"')
    lines.append('  version: "0.1.0"')
    lines.append("command:")
    lines.append('  name: "fetch-list"')
    lines.append(f"  refresh: {str(refresh).lower()}")
    lines.append("input:")
    lines.append(f'  source_file: "{_yaml_safe(source_name)}"')
    lines.append(f"  total_urls: {len(results)}")
    lines.append(f"  unique_urls: {unique_urls}")
    lines.append("results:")
    lines.append(f"  succeeded: {succeeded}")
    lines.append(f"  blocked: {blocked}")
    lines.append(f"  failed: {failed}")
    lines.append(f"  skipped: {skipped}")
    lines.append("cache:")
    lines.append(f"  hit: {cache_hit}")
    lines.append(f"  miss: {cache_miss}")
    lines.append(f"  bypass: {cache_bypass}")
    lines.append(f"  not_written: {cache_not_written}")
    lines.append(f"  errors: {total_errors}")
    lines.append(f"  limitations: {total_limitations}")
    lines.append("---")
    lines.append("")
    lines.append("# Fetch-List Manifest")
    lines.append("")
    lines.append(f"- **Source file:** {_yaml_safe(source_name)}")
    lines.append(f"- **Generated at UTC:** {now.isoformat()}")
    lines.append(f"- **Refresh:** {refresh}")
    lines.append(f"- **Total URLs:** {len(results)}")
    lines.append(f"- **Unique URLs:** {unique_urls}")
    lines.append(f"- **Succeeded:** {succeeded}")
    lines.append(f"- **Blocked:** {blocked}")
    lines.append(f"- **Failed:** {failed}")
    lines.append(f"- **Skipped:** {skipped}")
    lines.append(f"- **Cache:** hit={cache_hit} miss={cache_miss} bypass={cache_bypass} not_written={cache_not_written}")
    lines.append(f"- **Errors:** {total_errors} total across all packs")
    lines.append(f"- **Limitations:** {total_limitations} total across all packs")
    lines.append("")

    lines.append("## Safety notice")
    lines.append("")
    lines.append(SAFETY_NOTICE)
    lines.append("")

    lines.append("## Evidence Packs")
    lines.append("")
    lines.append("| # | URL | Status | Cache | Quality | Evidence |")
    lines.append("|---|-----|--------|-------|---------|----------|")

    for i, r in enumerate(results, 1):
        qs = _quality_score(r)
        status_label = r.fetch_status
        if r.fetch_status == "success" and r.extraction_status == "truncated":
            status_label = "truncated"
        elif r.fetch_status == "success" and r.extraction_status in ("failed", "skipped"):
            status_label = r.extraction_status
        rel = str(r.evidence_path.name)  # Relative link in same dir
        safe_url = _md_table_safe(r.original_url)
        lines.append(f"| {i} | {safe_url} | {status_label} | {r.cache_status} | {qs}/3 | [{rel}]({rel}) |")

    lines.append("")

    content = "\n".join(lines)
    manifest_path.write_text(content, encoding="utf-8")
    return manifest_path


def parse_urls_file(path: Path) -> list[str]:
    """Read a UTF-8 URLs file. Skip blank lines and full-line comments (#...).

    Raises InputError on I/O or decode errors.
    """
    try:
        raw = path.read_text(encoding="utf-8")
    except FileNotFoundError:
        raise InputError(f"urls file not found: {path}")
    except OSError as e:
        raise InputError(f"cannot read urls file: {e}")
    except UnicodeDecodeError:
        raise InputError(f"urls file is not valid UTF-8: {path}")

    urls: list[str] = []
    for line in raw.splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            continue
        urls.append(stripped)
    return urls
