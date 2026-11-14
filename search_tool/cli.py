"""CLI entry point for krn-search fetch-url / fetch-list / discover-query."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import sys
from dataclasses import dataclass
from datetime import datetime, timezone
from functools import partial
from pathlib import Path

from search_tool import __version__
from search_tool.cache import get as cache_get, put as cache_put
from search_tool.discovery import (
    DiscoveryResult,
    RawDiscoveryCandidate,
    StaticDiscoveryProvider,
    SearxngDiscoveryProvider,
    urls_for_fetch,
)
from search_tool.search import (
    search_query as _search_query_fn,
    EvidenceWriteResult,
    EvidenceRelevanceEntry,
    SearchRunResult,
    _quality_score,
    _md_table_safe,
    write_search_run_manifest,
)
from search_tool.run import (
    fetch_url_to_evidence,
    write_fetch_list_manifest,
    InputError,
    parse_urls_file,
)
from search_tool.evidence import build_evidence_pack, write_evidence_pack, EVIDENCE_DIR, SAFETY_NOTICE, _yaml_safe
from search_tool.extract import extract
from search_tool.fetch import FetchResult, fetch_url, MAX_REDIRECTS
from search_tool.url_policy import check_url, normalize_url
from search_tool.source_quality import classify_source_quality
from search_tool.compact import write_compact_summary, _strip_nav_chrome
from search_tool.profiles import get_profile as get_query_profile, VALID_PROFILE_NAMES, profile_to_json
from search_tool.session import (
    create_session as _create_session,
    update_session_metadata as _update_session_metadata,
    SessionRunRecord as _SessionRunRecord,
    session_dir_path as _session_dir_path,
    generate_session_id as _generate_session_id,
)

MAX_LIST_URLS = 50

# LLMs provider URL alias names
_LLMS_URL_ALIASES = ("url", "llms_url", "docs_index_url")


def _resolve_llms_url(args: argparse.Namespace) -> tuple[str | None, str | None]:
    """Resolve the effective llms.txt URL from aliased CLI arguments.

    Returns (effective_url, error_message).
    On success: (url_string, None)
    On conflict: (None, error_string)
    On missing: (None, None)
    """
    values: dict[str, str | None] = {}
    for alias in _LLMS_URL_ALIASES:
        values[alias] = getattr(args, alias, None)

    provided = {k: v for k, v in values.items() if v is not None}

    if len(provided) > 1:
        names = ", ".join(f"--{n.replace('_', '-')}" for n in provided)
        return None, f"conflicting llms URL aliases: {names} (use only one)"

    if len(provided) == 1:
        return next(iter(provided.values())), None

    return None, None


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="krn-search",
        description="Controlled URL to evidence pack tool",
    )
    parser.add_argument("--version", action="version", version=f"%(prog)s {__version__}")
    subparsers = parser.add_subparsers(dest="command")

    fetch_parser = subparsers.add_parser("fetch-url", help="Fetch a URL and produce an evidence pack")
    fetch_parser.add_argument("url", help="URL to fetch")
    fetch_parser.add_argument("--refresh", action="store_true", help="Bypass cache and re-fetch")
    fetch_parser.add_argument("--follow-redirects", action="store_true", help="Follow 3xx redirects (up to 3 hops)")

    list_parser = subparsers.add_parser("fetch-list", help="Fetch URLs from a file and produce a manifest")
    list_parser.add_argument("urls_file", help="Path to UTF-8 file with one URL per line")
    list_parser.add_argument("--refresh", action="store_true", help="Bypass cache and re-fetch")
    list_parser.add_argument("--follow-redirects", action="store_true", help="Follow 3xx redirects (up to 3 hops)")

    discover_parser = subparsers.add_parser("discover-query", help="Discover candidate URLs for a query")
    discover_parser.add_argument("query", help="Search query")
    discover_parser.add_argument("--provider", required=True, choices=["static", "searxng", "llms", "auto"], help="Discovery provider")
    discover_parser.add_argument("--max-candidates", type=int, default=10, help="Maximum candidates (default: 10)")

    # Static provider options
    discover_parser.add_argument("--candidate-url", action="append", default=[], help="Candidate URL (repeatable)")
    discover_parser.add_argument("--candidate-title", action="append", default=[], help="Candidate title (repeatable)")
    discover_parser.add_argument("--candidate-snippet", action="append", default=[], help="Candidate snippet (repeatable)")
    discover_parser.add_argument("--candidate-engine", action="append", default=[], help="Candidate source engine (repeatable)")

    # SearXNG provider options
    discover_parser.add_argument("--searxng-url", help="SearXNG instance base URL (required for searxng provider)")
    discover_parser.add_argument("--language", help="Language code for SearXNG")
    discover_parser.add_argument("--category", action="append", default=[], help="SearXNG category (repeatable)")
    discover_parser.add_argument("--safesearch", type=int, help="Safe search level (0, 1, or 2)")
    discover_parser.add_argument("--timeout", type=float, default=10.0, help="Request timeout in seconds (default: 10.0)")
    discover_parser.add_argument("--follow-redirects", action="store_true", help="Follow 3xx redirects for llms.txt source URL (up to 3 hops)")

    # llms provider options
    discover_parser.add_argument("--url", dest="url", help="URL of llms.txt/docs-index file (required for llms provider)")
    discover_parser.add_argument("--llms-url", dest="llms_url", help="Alias for --url (llms.txt source URL)")
    discover_parser.add_argument("--docs-index-url", dest="docs_index_url", help="Alias for --url (llms.txt source URL)")

    search_parser = subparsers.add_parser("search-query", help="Discover and fetch URLs for a query")
    search_parser.add_argument("query", help="Search query")
    search_parser.add_argument("--provider", choices=["static", "searxng", "llms", "auto"], help="Discovery provider (default: auto with --research)")
    search_parser.add_argument("--max-candidates", type=int, default=10, help="Maximum candidates (default: 10)")

    search_parser.add_argument("--candidate-url", action="append", default=[], help="Candidate URL (repeatable)")
    search_parser.add_argument("--candidate-title", action="append", default=[], help="Candidate title (repeatable)")
    search_parser.add_argument("--candidate-snippet", action="append", default=[], help="Candidate snippet (repeatable)")
    search_parser.add_argument("--candidate-engine", action="append", default=[], help="Candidate source engine (repeatable)")

    search_parser.add_argument("--searxng-url", help="SearXNG instance base URL (required for searxng provider)")
    search_parser.add_argument("--language", help="Language code for SearXNG")
    search_parser.add_argument("--category", action="append", default=[], help="SearXNG category (repeatable)")
    search_parser.add_argument("--safesearch", type=int, help="Safe search level (0, 1, or 2)")
    search_parser.add_argument("--timeout", type=float, default=10.0, help="Request timeout in seconds (default: 10.0)")

    # llms provider options
    search_parser.add_argument("--url", dest="url", help="URL of llms.txt/docs-index file (required for llms provider)")
    search_parser.add_argument("--llms-url", dest="llms_url", help="Alias for --url (llms.txt source URL)")
    search_parser.add_argument("--docs-index-url", dest="docs_index_url", help="Alias for --url (llms.txt source URL)")

    search_parser.add_argument("--refresh", action="store_true", help="Bypass cache and re-fetch")
    search_parser.add_argument("--follow-redirects", action=argparse.BooleanOptionalAction, default=None, help="Follow 3xx redirects (up to 3 hops)")
    search_parser.add_argument("--work-dir", help="Directory for isolated artifact storage")
    search_parser.add_argument("--json", action="store_true", help="Output results as JSON to stdout")
    search_parser.add_argument("--compact", action=argparse.BooleanOptionalAction, default=None, help="Write compact evidence index (requires --json and --work-dir)")
    search_parser.add_argument("--profile", default=None, help="Deterministic query profile for source preference biasing (official-docs, github-repo, security-research)")
    search_parser.add_argument("--research", action="store_true", help="Research mode preset: auto provider, JSON output, compact index, official-docs profile, isolated work-dir, follow redirects")
    search_parser.add_argument("--session", help="Research session topic (groups multiple runs; requires --work-dir or --research)")

    eval_parser = subparsers.add_parser("eval-corpus", help="Run evaluation scenarios from a JSON corpus")
    eval_parser.add_argument("corpus_file", help="Path to evaluation corpus JSON file")
    eval_parser.add_argument("--work-dir", help="Directory for generated artifacts (default: safe temporary directory)")

    ui_parser = subparsers.add_parser("ui", help="Start the local UI testbench")
    ui_parser.add_argument("--port", type=int, default=8765, help="Port to bind to (default: 8765)")
    ui_parser.add_argument("--host", default="127.0.0.1", help="Host to bind to (default: 127.0.0.1)")
    ui_parser.add_argument("--work-dir", default=".local/krn-search-ui", help="Directory for artifacts (default: .local/krn-search-ui)")

    health_parser = subparsers.add_parser("health", help="Check krn-search runtime health")
    health_parser.add_argument("--json", action="store_true", help="Output as JSON")
    health_parser.add_argument("--research", action="store_true", help="Require SearXNG for health checks")
    health_parser.add_argument("--wait", type=float, default=0.0, help="With --research, wait up to N seconds for SearXNG readiness")
    health_parser.add_argument("--searxng-url", help="Override SearXNG URL for this health check")
    health_parser.add_argument("--work-dir", help="Check specific work directory (optional)")

    init_parser = subparsers.add_parser("init-claude", help="Bootstrap Claude Code artifacts into a target repo")
    init_parser.add_argument("--target-dir", default=".", help="Target repository directory (default: current directory)")
    init_parser.add_argument("--dry-run", action="store_true", help="Print intended actions without writing")
    init_parser.add_argument("--force", action="store_true", help="Overwrite existing managed files")
    init_parser.add_argument("--with-hook", action="store_true", help="Also copy the websearch guard hook")

    searxng_parser = subparsers.add_parser("searxng", help="Operate local SearXNG bootstrap for research mode")
    searxng_subparsers = searxng_parser.add_subparsers(dest="searxng_command")
    searxng_subparsers.add_parser("status", help="Check whether local SearXNG is queryable on localhost:9999")
    up_parser = searxng_subparsers.add_parser("up", help="Start local SearXNG bootstrap container on localhost:9999")
    up_parser.add_argument("--wait", type=float, default=30.0, help="Wait up to N seconds for readiness (default: 30)")
    searxng_subparsers.add_parser("down", help="Stop/remove only the local krn-search SearXNG container")

    # Session summary command
    session_summary_parser = subparsers.add_parser("session-summary", help="Generate session summary from run artifacts")
    session_summary_parser.add_argument("--work-dir", default=".local/krn-search-runs", help="Directory containing sessions (default: .local/krn-search-runs)")
    session_summary_parser.add_argument("--session", help="Session topic to summarize")
    session_summary_parser.add_argument("--session-id", help="Specific session ID to summarize")
    session_summary_parser.add_argument("--output", help="Output file path (default: work-dir/sessions/<session-id>/session-summary.md)")

    args = parser.parse_args(argv)

    if args.command == "fetch-url":
        return _run_fetch_url(args.url, args.refresh, args.follow_redirects)
    elif args.command == "fetch-list":
        return _run_fetch_list(args.urls_file, args.refresh, args.follow_redirects)
    elif args.command == "discover-query":
        return _run_discover_query(args)
    elif args.command == "search-query":
        return _run_search_query(args)
    elif args.command == "eval-corpus":
        return _run_eval_corpus(args.corpus_file, args.work_dir)
    elif args.command == "ui":
        return _run_ui(args.port, args.host, args.work_dir)
    elif args.command == "health":
        return _run_health(args)
    elif args.command == "init-claude":
        return _run_init_claude(args)
    elif args.command == "searxng":
        return _run_searxng(args)
    elif args.command == "session-summary":
        return _run_session_summary(args)

    parser.print_help()
    return 1


def _run_eval_corpus(corpus_file: str, work_dir: str | None = None) -> int:
    """Execute the eval-corpus command."""
    from dataclasses import asdict
    from search_tool.eval_corpus import run_corpus
    path = Path(corpus_file)
    if not path.exists():
        print(f"error: corpus file not found: {path}", file=sys.stderr)
        return 1

    work_path = Path(work_dir) if work_dir else None
    results = run_corpus(path, work_dir=work_path)

    passed = 0
    failed = 0
    errors = 0

    for r in results:
        if r.status == "PASS":
            passed += 1
        elif r.status == "FAIL":
            failed += 1
        else:
            errors += 1

    # Compact summary to stderr
    print(f"[eval-corpus] scenarios={len(results)} passed={passed} failed={failed} errors={errors}", file=sys.stderr)

    # JSON summary to stdout
    summary = {
        "schema_version": "0.1",
        "status": "pass" if failed == 0 and errors == 0 else "fail",
        "scenarios_total": len(results),
        "scenarios_passed": passed,
        "scenarios_failed": failed + errors,
        "results": [asdict(r) for r in results]
    }
    print(json.dumps(summary, indent=2))

    return 0 if failed == 0 and errors == 0 else 1


def _run_ui(port: int, host: str, work_dir: str) -> int:
    """Execute the ui command."""
    from search_tool.ui import run_ui_server
    run_ui_server(port, host, Path(work_dir))
    return 0


def _run_health(args) -> int:  # type: ignore[type-unparam]
    """Execute the health command."""
    from search_tool.health import run_health_checks
    work_path = Path(args.work_dir) if args.work_dir else None
    report = run_health_checks(
        work_dir=work_path,
        research_mode=bool(args.research),
        searxng_url_override=getattr(args, "searxng_url", None),
        searxng_wait_seconds=getattr(args, "wait", 0.0),
    )
    if args.json:
        print(report.to_json())
    else:
        print(report.to_human())
    return 0 if report.overall_status() != "fail" else 1

def _run_init_claude(args) -> int:  # type: ignore[type-unparam]
    """Execute the init-claude bootstrap command."""
    from search_tool.bootstrap import BootstrapError, init_claude, print_summary
    try:
        result = init_claude(
            target_dir=args.target_dir,
            dry_run=bool(args.dry_run),
            force=bool(args.force),
            with_hook=bool(args.with_hook),
        )
    except BootstrapError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1
    print_summary(result)
    return 0


def _run_searxng(args) -> int:  # type: ignore[type-unparam]
    """Execute local SearXNG operator commands."""
    from search_tool.searxng import (
        SearxngOperatorError,
        ensure_local_searxng,
        probe_status,
        stop_local_searxng,
    )

    if args.searxng_command == "status":
        status = probe_status()
        stream = sys.stdout if status.ready else sys.stderr
        print(status.reason, file=stream)
        return 0 if status.ready else 1

    if args.searxng_command == "up":
        try:
            print(ensure_local_searxng(wait_seconds=args.wait))
            return 0
        except SearxngOperatorError as exc:
            print(f"error: {exc}", file=sys.stderr)
            return 1

    if args.searxng_command == "down":
        try:
            print(stop_local_searxng())
            return 0
        except SearxngOperatorError as exc:
            print(f"error: {exc}", file=sys.stderr)
            return 1

    print("error: searxng subcommand required (status|up|down)", file=sys.stderr)
    return 1


def _run_session_summary(args) -> int:  # type: ignore[type-unparam]
    """Execute the session-summary command."""
    from search_tool.session_summary import generate_session_summary_on_demand
    try:
        session_id = None
        if args.session_id:
            session_id = args.session_id
        elif args.session:
            # Generate session ID from topic like R.1 does
            from search_tool.session import generate_session_id
            session_id = generate_session_id(args.session)

        # Validate that exactly one session selector is provided
        if (args.session is None) == (args.session_id is None):
            # Both or neither provided - error
            print("error: must specify exactly one of --session or --session-id", file=sys.stderr)
            return 1

        output_path = generate_session_summary_on_demand(Path(args.work_dir), session_id, args.output)
        print(f"Session summary written to: {output_path}")
        return 0
    except Exception as e:
        print(f"error: failed to generate session summary: {e}", file=sys.stderr)
        return 1


def _blocked_fetch() -> FetchResult:
    return FetchResult(status="blocked", errors=[], limitations=[])


def _failed_fetch(errors: list[str]) -> FetchResult:
    return FetchResult(status="failed", errors=errors, limitations=[])


def _run_fetch_url(url: str, refresh: bool, follow_redirects: bool = False) -> int:
    """Execute the fetch-url command. Returns exit code."""
    result = fetch_url_to_evidence(url, refresh, follow_redirects)
    print(str(result.evidence_path))
    return 0

def _run_fetch_list(urls_file: str, refresh: bool, follow_redirects: bool = False) -> int:
    """Execute the fetch-list command. Returns exit code."""
    try:
        path = Path(urls_file)
        urls = parse_urls_file(path)
    except InputError as e:
        print(f"error: {e}", file=sys.stderr)
        return 1

    if len(urls) > MAX_LIST_URLS:
        print(f"error: {len(urls)} URLs exceeds maximum of {MAX_LIST_URLS}", file=sys.stderr)
        return 1

    if not urls:
        print("error: urls file contains no valid URLs", file=sys.stderr)
        return 1

    results: list[EvidenceWriteResult] = []
    for url in urls:
        result = fetch_url_to_evidence(url, refresh, follow_redirects)
        results.append(result)

    manifest_path = write_fetch_list_manifest(results, urls_file, refresh)

    for r in results:
        qs = _quality_score(r)
        print(f"{r.original_url}\t{r.fetch_status}\t{r.cache_status}\t{qs}/3\t{r.evidence_path}")
    print(f"Manifest:\t{manifest_path}")
    return 0


def _run_discover_query(args) -> int:  # type: ignore[type-unparam]
    """Execute the discover-query command. Returns exit code."""
    if not args.query.strip():
        print("error: query must not be empty", file=sys.stderr)
        return 1

    resolve_err = _resolve_auto_provider(args)
    if resolve_err is not None:
        print(f"error: --provider auto: {resolve_err.reason}", file=sys.stderr)
        return 1

    if args.max_candidates <= 0:
        print("error: --max-candidates must be positive", file=sys.stderr)
        return 1

    if args.provider == "static":
        if not args.candidate_url:
            print("error: --candidate-url is required for static provider", file=sys.stderr)
            return 1

        metadata_count = len(args.candidate_url)
        if len(args.candidate_title) > metadata_count or len(args.candidate_snippet) > metadata_count or len(args.candidate_engine) > metadata_count:
            print("error: metadata count exceeds --candidate-url count", file=sys.stderr)
            return 1

        return _run_static_discover(args)

    if args.provider == "searxng":
        if not args.searxng_url:
            print("error: --searxng-url is required for searxng provider", file=sys.stderr)
            return 1

        if args.safesearch is not None and args.safesearch not in (0, 1, 2):
            print("error: --safesearch must be 0, 1, or 2", file=sys.stderr)
            return 1

        if args.timeout <= 0:
            print("error: --timeout must be positive", file=sys.stderr)
            return 1

        return _run_searxng_discover(args)

    if args.provider == "llms":
        effective_url, conflict_err = _resolve_llms_url(args)
        if conflict_err is not None:
            print(f"error: {conflict_err}", file=sys.stderr)
            return 1
        if not effective_url:
            print("error: --url/--llms-url/--docs-index-url is required for llms provider", file=sys.stderr)
            return 1

        return _run_llms_discover(args, llms_url=effective_url, follow_redirects=args.follow_redirects)

    return 1


def _run_static_discover(args) -> int:  # type: ignore[type-unparam]
    candidates = _build_static_candidates(args)
    provider = StaticDiscoveryProvider(name="static", candidates=candidates)
    result = provider.discover(args.query, max_candidates=args.max_candidates)
    _print_discovery_result(result)
    return 0


def _build_static_candidates(args) -> tuple[RawDiscoveryCandidate, ...]:
    items = []
    for i, url in enumerate(args.candidate_url):
        items.append(RawDiscoveryCandidate(
            url=url,
            title=args.candidate_title[i] if i < len(args.candidate_title) else None,
            snippet=args.candidate_snippet[i] if i < len(args.candidate_snippet) else None,
            source_engine=args.candidate_engine[i] if i < len(args.candidate_engine) else None,
        ))
    return tuple(items)


def _run_searxng_discover(args) -> int:  # type: ignore[type-unparam]
    provider = SearxngDiscoveryProvider(
        base_url=args.searxng_url,
        timeout_seconds=args.timeout,
        default_language=args.language,
        default_categories=tuple(args.category),
        safesearch=args.safesearch,
    )
    result = provider.discover(args.query, max_candidates=args.max_candidates)
    _print_discovery_result(result)
    return 0


def _run_llms_discover(args, llms_url: str, follow_redirects: bool = False) -> int:  # type: ignore[type-unparam]
    from search_tool.discovery_llms import LlmsTxtProvider

    provider = LlmsTxtProvider(name="llms", follow_redirects=follow_redirects)
    result = provider.discover(
        args.query,
        max_candidates=args.max_candidates,
        llms_url=llms_url,
    )
    _print_discovery_result(result)
    return 0


def _discovery_result_to_json_dict(result: DiscoveryResult) -> dict:
    fetch_urls = urls_for_fetch(result)
    candidates_total = len(result.candidates)
    selected = sum(1 for c in result.candidates if c.selected_for_fetch)
    blocked = sum(1 for c in result.candidates if c.url_policy == "blocked")
    duplicates = sum(1 for c in result.candidates if c.duplicate_of is not None)
    errors_count = len(result.errors)

    return {
        "schema_version": result.schema_version,
        "query": {
            "original": result.query_original,
            "normalized": result.query_normalized,
            "redacted": result.query_redacted,
        },
        "provider": {
            "name": result.provider_name,
        },
        "summary": {
            "candidates_total": candidates_total,
            "selected_for_fetch": selected,
            "blocked": blocked,
            "duplicates": duplicates,
            "errors": errors_count,
        },
        "urls_for_fetch": fetch_urls,
        "candidates": [
            {
                "rank": c.rank,
                "url": c.url,
                "normalized_url": c.normalized_url,
                "title": c.title,
                "snippet": c.snippet,
                "source_engine": c.source_engine,
                "url_policy": c.url_policy,
                "blocked_reason": c.blocked_reason,
                "selected_for_fetch": c.selected_for_fetch,
                "duplicate_of": c.duplicate_of,
            }
            for c in result.candidates
        ],
        "errors": [
            {"code": e.code, "message": e.message}
            for e in result.errors
        ],
        "limitations": list(result.limitations),
    }


def _print_discovery_result(result: DiscoveryResult) -> None:
    d = _discovery_result_to_json_dict(result)
    print(json.dumps(d, ensure_ascii=False, indent=2))


def _sanitize_provider_url_for_manifest(url: str) -> str:
    """Redact credentials and path/query/fragment from provider URL."""
    from urllib.parse import urlparse, urlunparse
    try:
        parsed = urlparse(url)
        if not parsed.hostname:
            return "[REDACTED]"
        # hostname is just the host (punycode if needed, lowercased)
        # port is the integer port
        netloc = parsed.hostname
        if parsed.port:
            netloc = f"{netloc}:{parsed.port}"
        # We use urlunparse with empty path/params/query/fragment
        return urlunparse((parsed.scheme, netloc, "", "", "", ""))
    except Exception:
        return "[REDACTED]"


RESEARCH_PRESET_VERSION = "0.1"
RESEARCH_DEFAULT_WORK_DIR = ".local/krn-search-runs"


def _build_research_mode_json(enabled: bool, expanded_defaults: dict | None, effective_values: dict | None) -> dict | None:
    if not enabled:
        return None
    return {
        "enabled": True,
        "preset_version": RESEARCH_PRESET_VERSION,
        "expanded_defaults": expanded_defaults or {},
        "effective_values": effective_values or {},
    }


def _print_search_error_json(
    query: str,
    stage: str,
    reason: str,
    research_mode: dict | None = None,
    limitations: list[str] | tuple[str, ...] | None = None,
    next_action: str | None = None,
) -> None:
    """Print structured JSON error to stdout for agent consumption."""
    query_hash = hashlib.sha256(query.encode()).hexdigest()
    limitations_list = list(limitations) if limitations is not None else []
    output = {
        "schema_version": "0.1",
        "status": "error",
        "query": {
            "redacted": query,
            "hash_sha256": query_hash,
        },
        "discovery": {
            "provider": None,
            "candidates_total": 0,
            "selected_for_fetch": 0,
            "blocked": 0,
            "duplicates": 0,
            "errors": 0,
        },
        "evidence_results": [],
        "failures": [{"stage": stage, "reason": reason}],
        "limitations": limitations_list,
        "recovery": {
            "next_action": next_action or f"Preflight error: {reason}",
            "websearch_allowed": False,
        },
        "profile": None,
        "research_mode": research_mode,
    }
    print(json.dumps(output, indent=2, ensure_ascii=False))


def _print_search_result_json(result: SearchRunResult, query: str, evidence_dir: Path | None = None, compact_summary_path: Path | None = None, profile=None, research_mode: dict | None = None, session_info: dict | None = None) -> None:
    """Print structured JSON result to stdout for agent consumption."""
    succeeded = sum(1 for r in result.evidence_results if r.fetch_status == "success")
    total = len(result.evidence_results)
    skipped = sum(1 for r in result.evidence_results if r.fetch_status == "skipped_duplicate")

    if total == 0:
        status = "error"
    elif succeeded + skipped == total:
        # All succeeded or intentionally skipped (no real failures).
        status = "ok"
    else:
        status = "partial_success"

    query_hash = hashlib.sha256(query.encode()).hexdigest()

    evidence_results = []
    failures = []
    for r in result.evidence_results:
        if r.fetch_status == "success" or r.fetch_status == "skipped_duplicate":
            excerpt = None
            try:
                content = Path(r.evidence_path).read_text(encoding="utf-8")
                # Extract text after frontmatter (after second ---)
                parts = content.split("---", 2)
                if len(parts) >= 3:
                    body = parts[2].strip()
                else:
                    body = content.strip()
                # Find the code block with extracted text
                in_code = False
                code_lines = []
                for line in body.split("\n"):
                    if line.startswith("```"):
                        in_code = not in_code
                        continue
                    if in_code:
                        code_lines.append(line)
                text = "\n".join(code_lines)
                text = _strip_nav_chrome(text)
                excerpt = text[:200] if text else None
            except Exception:
                excerpt = None
            sq = classify_source_quality(r.original_url, None)
            # Try to extract title from evidence pack frontmatter as fallback
            pack_title = None
            try:
                content = Path(r.evidence_path).read_text(encoding="utf-8")
                parts = content.split("---", 2)
                if len(parts) >= 3:
                    for fm_line in parts[1].splitlines():
                        if fm_line.strip().startswith("title:"):
                            val = fm_line.strip()[6:].strip().strip('"').strip("'")
                            if val and val != "null":
                                # Strip YAML-ish backslash separator artifact: "Title \ Subtitle" or "Title \\ Subtitle"
                                val = val.replace(r" \\ ", " - ")
                                val = val.replace(r" \ ", " - ")
                                pack_title = val
                            break
            except Exception:
                pass
            evidence_results.append({
                "url": r.original_url,
                "title": pack_title,
                "status": r.fetch_status,
                "quality_score": _quality_score(r),
                "evidence_path": str(r.evidence_path),
                "excerpt": excerpt,
                "cache_status": r.cache_status,
                "source_quality": {
                    "source_type": sq.source_type,
                    "authority_score": sq.authority_score,
                    "is_official": sq.is_official,
                    "is_primary_source": sq.is_primary_source,
                    "domain": sq.domain,
                    "reason": sq.reason,
                },
            })
        else:
            failures.append({
                "url": r.original_url,
                "reason": "; ".join(r.errors) if r.errors else r.fetch_status,
            })

    # Map discovery candidates to evidence results for titles and source quality
    for er in evidence_results:
        for c in result.discovery.candidates:
            if c.url == er["url"]:
                # Discovery candidate title takes precedence if available and non-empty
                if c.title and not er["title"]:
                    er["title"] = c.title
                sq = classify_source_quality(er["url"], c.title)
                er["source_quality"] = {
                    "source_type": sq.source_type,
                    "authority_score": sq.authority_score,
                    "is_official": sq.is_official,
                    "is_primary_source": sq.is_primary_source,
                    "domain": sq.domain,
                    "reason": sq.reason,
                }
                break

    if total == 0:
        next_action = "No evidence produced. Check provider configuration or provide candidate URLs."
    elif succeeded < total:
        next_action = "Some evidence produced. Increase max-candidates or provide additional URLs."
    else:
        next_action = "Evidence available. Read evidence packs for source content."

    output = {
        "schema_version": "0.1",
        "status": status,
        "query": {
            "redacted": result.discovery.query_redacted,
            "hash_sha256": query_hash,
        },
        "discovery": {
            "provider": result.discovery.provider_name,
            "candidates_total": len(result.discovery.candidates),
            "selected_for_fetch": sum(1 for c in result.discovery.candidates if c.selected_for_fetch),
            "blocked": sum(1 for c in result.discovery.candidates if c.url_policy == "blocked"),
            "duplicates": sum(1 for c in result.discovery.candidates if c.duplicate_of is not None),
            "errors": len(result.discovery.errors),
        },
        "evidence_results": evidence_results,
        "failures": failures,
        "limitations": list(dict.fromkeys(list(result.limitations) + list(result.discovery.limitations))),
        "recovery": {
            "next_action": next_action,
            "websearch_allowed": False,
        },
        "compact_summary_path": str(compact_summary_path) if compact_summary_path else None,
        "discovery_diagnostics_path": str(result.discovery_diagnostics_path) if result.discovery_diagnostics_path else None,
        "evidence_relevance": [
            {
                "url": er.url,
                "score": er.score,
                "components": {
                    "text_overlap": er.components.text_overlap,
                    "heading_match": er.components.heading_match,
                    "early_content_overlap": er.components.early_content_overlap,
                    "content_density": er.components.content_density,
                    "exact_phrase_in_text": er.components.exact_phrase_in_text,
                    "low_content_penalty": er.components.low_content_penalty,
                },
            }
            for er in result.evidence_relevance
        ],
        "profile": profile_to_json(profile),
        "research_mode": research_mode,
        "session": session_info,
    }

    # Also write search-run.json if work-dir is set
    if evidence_dir is not None:
        run_json_path = evidence_dir.parent / "search-run.json"
        try:
            run_json_path.write_text(json.dumps(output, indent=2, ensure_ascii=False), encoding="utf-8")
        except Exception:
            pass

    print(json.dumps(output, indent=2, ensure_ascii=False))



@dataclass(frozen=True)
class _AutoProviderResolutionFailure:
    reason: str
    kind: str
    searxng_url: str | None = None
    searxng_source: str | None = None


def _resolve_auto_provider(args, research_mode: bool = False) -> _AutoProviderResolutionFailure | None:
    """Resolve --provider auto.

    In research mode, auto resolution is restricted to SearXNG and never
    switches to static when candidate URLs are supplied.
    """
    if args.provider != "auto":
        return None
    if args.candidate_url:
        if research_mode:
            return _AutoProviderResolutionFailure(
                reason="--candidate-url does not activate static provider in research mode",
                kind="candidate_url_requires_static",
            )
        args.provider = "static"
        return None

    env_value = os.environ.get("SEARXNG_URL", "").strip()
    if args.searxng_url:
        searxng_url = args.searxng_url
        searxng_source = "--searxng-url"
    elif env_value:
        searxng_url = env_value
        searxng_source = "SEARXNG_URL"
    else:
        searxng_url = "http://localhost:9999"
        searxng_source = "default"

    from search_tool.health import check_searxng_reachable
    if check_searxng_reachable(searxng_url):
        args.provider = "searxng"
        if not args.searxng_url:
            args.searxng_url = searxng_url
        return None

    if research_mode:
        return _AutoProviderResolutionFailure(
            reason="research mode requires SearXNG discovery, but SearXNG is unreachable.",
            kind="searxng_unreachable",
            searxng_url=searxng_url,
            searxng_source=searxng_source,
        )

    return _AutoProviderResolutionFailure(
        reason=f"no candidate URLs provided and SearXNG unreachable (SearXNG URL: {searxng_url}). Set SEARXNG_URL environment variable or provide --candidate-url",
        kind="searxng_unreachable_non_research",
    )


def _run_search_query(args) -> int:  # type: ignore[type-unparam]
    research_mode_enabled = getattr(args, "research", False)

    expanded_defaults = {
        "provider": "auto",
        "json": True,
        "compact": True,
        "profile": "official-docs",
        "work_dir": RESEARCH_DEFAULT_WORK_DIR,
        "follow_redirects": True,
    }

    if research_mode_enabled:
        if not getattr(args, "json", False):
            args.json = True
        if getattr(args, "compact", None) is None:
            args.compact = True
        if getattr(args, "profile", None) is None:
            args.profile = "official-docs"
        if getattr(args, "work_dir", None) is None:
            args.work_dir = RESEARCH_DEFAULT_WORK_DIR
        if getattr(args, "follow_redirects", None) is None:
            args.follow_redirects = True
        if getattr(args, "provider", None) is None:
            args.provider = "auto"

    if getattr(args, "provider", None) is None:
        print("error: --provider is required (use --research for auto defaults)", file=sys.stderr)
        return 1

    effective_values = {
        "json": True if research_mode_enabled else getattr(args, "json", False),
        "compact": getattr(args, "compact", False),
        "profile": getattr(args, "profile", None),
        "work_dir": getattr(args, "work_dir", None),
        "follow_redirects": getattr(args, "follow_redirects", False),
    }
    if research_mode_enabled:
        effective_values["provider"] = getattr(args, "provider", "auto")
    else:
        effective_values["provider"] = getattr(args, "provider", None)

    research_mode_json = _build_research_mode_json(
        research_mode_enabled,
        expanded_defaults if research_mode_enabled else None,
        effective_values if research_mode_enabled else None,
    )

    json_mode = getattr(args, "json", False)
    compact_mode = getattr(args, "compact", False) or False

    if compact_mode and not json_mode:
        print("error: --compact requires --json", file=sys.stderr)
        return 1

    session_topic = getattr(args, "session", None)
    if session_topic is not None:
        if not session_topic.strip():
            print("error: --session topic must not be empty", file=sys.stderr)
            return 1
        work_dir_val = getattr(args, "work_dir", None)
        if not work_dir_val and not research_mode_enabled:
            print("error: --session requires --work-dir (use --research for default)", file=sys.stderr)
            return 1

    profile = get_query_profile(getattr(args, "profile", None))

    if getattr(args, "profile", None) is not None and profile is None:
        msg = f"unknown profile: {args.profile} (valid: official-docs, github-repo, security-research, llms-docs)"
        print(f"error: {msg}", file=sys.stderr)
        if json_mode:
            _print_search_error_json(args.query, "preflight", msg, research_mode=research_mode_json)
        return 1

    if not args.query.strip():
        print("error: query must not be empty", file=sys.stderr)
        if json_mode:
            _print_search_error_json(args.query, "preflight", "query must not be empty", research_mode=research_mode_json)
        return 1

    resolve_err = _resolve_auto_provider(args, research_mode=research_mode_enabled)
    if resolve_err is not None:
        if research_mode_enabled and args.provider == "auto":
            if resolve_err.kind == "candidate_url_requires_static":
                print(f"error: {resolve_err.reason}", file=sys.stderr)
                print("Research mode auto-discovery requires SearXNG.", file=sys.stderr)
                print("For known URLs, retry with:", file=sys.stderr)
                print('  krn-search search-query "<query>" --research --provider static --candidate-url "<url>"', file=sys.stderr)
                if json_mode:
                    _print_search_error_json(
                        args.query,
                        "provider_resolution",
                        f"{resolve_err.reason} Research mode auto-discovery requires SearXNG. Use --provider static for known URLs.",
                        research_mode=research_mode_json,
                        limitations=[
                            "Research-mode auto-discovery requires SearXNG and did not use static fallback automatically.",
                            "No public web search, native web search, or LLM-generated URL candidate fallback was used.",
                        ],
                        next_action='Run again with "krn-search search-query --research --provider static --candidate-url \\"<url>\\" for known URLs."',
                    )
            elif resolve_err.kind == "searxng_unreachable":
                print("error: research mode requires SearXNG discovery, but SearXNG is unreachable.", file=sys.stderr)
                print(f"SearXNG URL: {resolve_err.searxng_url} (source: {resolve_err.searxng_source})", file=sys.stderr)
                print("No fallback provider was used. Static provider is only an explicit known-URL override.", file=sys.stderr)
                print("", file=sys.stderr)
                print("Check SearXNG:", file=sys.stderr)
                print(f"  SEARXNG_URL={resolve_err.searxng_url} krn-search health --research", file=sys.stderr)
                print("", file=sys.stderr)
                print("Configure and retry:", file=sys.stderr)
                print(f"  export SEARXNG_URL={resolve_err.searxng_url}", file=sys.stderr)
                print("  krn-search search-query \"<query>\" --research", file=sys.stderr)
                print("", file=sys.stderr)
                print("Manual known-URL override:", file=sys.stderr)
                print("  krn-search search-query \"<query>\" --research --provider static --candidate-url \"<url>\"", file=sys.stderr)
                if json_mode:
                    _print_search_error_json(
                        args.query,
                        "provider_resolution",
                        (
                            "research mode requires SearXNG discovery, but SearXNG is unreachable "
                            f"at {resolve_err.searxng_url} (source: {resolve_err.searxng_source})."
                        ),
                        research_mode=research_mode_json,
                        limitations=[
                            "Research-mode discovery did not run because required SearXNG was unreachable.",
                            "No fallback provider was used. Static provider is only an explicit known-URL override.",
                            "No public web search, native web search, or LLM-generated URL candidate fallback was used.",
                        ],
                        next_action=(
                            f"Run `SEARXNG_URL={resolve_err.searxng_url} krn-search health --research`, "
                            "then configure SearXNG and retry `krn-search search-query \"<query>\" --research`. "
                            "For known URLs only, use `krn-search search-query \"<query>\" --research --provider static --candidate-url \"<url>\"`."
                        ),
                    )
            else:
                print(f"error: --provider auto: {resolve_err.reason}", file=sys.stderr)
                if json_mode:
                    _print_search_error_json(args.query, "provider_resolution", resolve_err.reason, research_mode=research_mode_json)
        else:
            print(f"error: --provider auto: {resolve_err.reason}", file=sys.stderr)
            if json_mode:
                _print_search_error_json(args.query, "provider_resolution", resolve_err.reason, research_mode=research_mode_json)
        return 1

    if args.max_candidates <= 0:
        print("error: --max-candidates must be positive", file=sys.stderr)
        if json_mode:
            _print_search_error_json(args.query, "preflight", "--max-candidates must be positive", research_mode=research_mode_json)
        return 1

    if args.provider == "static":
        if not args.candidate_url:
            print("error: --candidate-url is required for static provider", file=sys.stderr)
            if json_mode:
                _print_search_error_json(args.query, "preflight", "--candidate-url is required for static provider", research_mode=research_mode_json)
            return 1

        metadata_count = len(args.candidate_url)
        if len(args.candidate_title) > metadata_count or len(args.candidate_snippet) > metadata_count or len(args.candidate_engine) > metadata_count:
            print("error: metadata count exceeds --candidate-url count", file=sys.stderr)
            if json_mode:
                _print_search_error_json(args.query, "preflight", "metadata count exceeds --candidate-url count", research_mode=research_mode_json)
            return 1

        provider = StaticDiscoveryProvider(
            name="static",
            candidates=_build_static_candidates(args),
        )
    elif args.provider == "searxng":
        if not args.searxng_url:
            print("error: --searxng-url is required for searxng provider", file=sys.stderr)
            if json_mode:
                _print_search_error_json(args.query, "preflight", "--searxng-url is required for searxng provider", research_mode=research_mode_json)
            return 1

        if args.safesearch is not None and args.safesearch not in (0, 1, 2):
            print("error: --safesearch must be 0, 1, or 2", file=sys.stderr)
            if json_mode:
                _print_search_error_json(args.query, "preflight", "--safesearch must be 0, 1, or 2", research_mode=research_mode_json)
            return 1

        if args.timeout <= 0:
            print("error: --timeout must be positive", file=sys.stderr)
            if json_mode:
                _print_search_error_json(args.query, "preflight", "--timeout must be positive", research_mode=research_mode_json)
            return 1

        provider = SearxngDiscoveryProvider(
            base_url=args.searxng_url,
            timeout_seconds=args.timeout,
            default_language=args.language,
            default_categories=tuple(args.category),
            safesearch=args.safesearch,
        )
    elif args.provider == "llms":
        effective_url, conflict_err = _resolve_llms_url(args)
        if conflict_err is not None:
            msg = conflict_err
            print(f"error: {msg}", file=sys.stderr)
            if json_mode:
                _print_search_error_json(args.query, "preflight", msg, research_mode=research_mode_json)
            return 1
        if not effective_url:
            msg = "--url/--llms-url/--docs-index-url is required for llms provider"
            print(f"error: {msg}", file=sys.stderr)
            if json_mode:
                _print_search_error_json(args.query, "preflight", msg, research_mode=research_mode_json)
            return 1

        if args.safesearch is not None and args.safesearch not in (0, 1, 2):
            print("error: --safesearch must be 0, 1, or 2", file=sys.stderr)
            if json_mode:
                _print_search_error_json(args.query, "preflight", "--safesearch must be 0, 1, or 2", research_mode=research_mode_json)
            return 1

        if args.timeout <= 0:
            print("error: --timeout must be positive", file=sys.stderr)
            if json_mode:
                _print_search_error_json(args.query, "preflight", "--timeout must be positive", research_mode=research_mode_json)
            return 1

        from search_tool.discovery_llms import LlmsTxtProvider

        provider = LlmsTxtProvider(
            name="llms",
            timeout_seconds=args.timeout,
            follow_redirects=bool(args.follow_redirects),
            llms_url=effective_url,
        )
    else:
        print("error: unknown provider", file=sys.stderr)
        if json_mode:
            _print_search_error_json(args.query, "preflight", f"unknown provider: {args.provider}", research_mode=research_mode_json)
        return 1

    # Sanitize provider config for manifest
    provider_config: dict[str, object] = {"max_candidates": args.max_candidates}
    if args.provider == "searxng":
        redacted_url = _sanitize_provider_url_for_manifest(args.searxng_url)
        provider_config.update({
            "searxng_url_redacted": redacted_url,
            "language": args.language,
            "categories": args.category,
            "safesearch": args.safesearch,
            "timeout": args.timeout,
        })
    elif args.provider == "static":
        provider_config.update({
            "candidate_urls": args.candidate_url,
        })
    elif args.provider == "llms":
        resolved, _ = _resolve_llms_url(args)
        provider_config.update({
            "llms_url": resolved,
        })

    if research_mode_enabled:
        effective_values["provider"] = getattr(args, "provider", "auto")

    # Resolve work-dir paths
    evidence_dir: Path | None = None
    cache_dir: Path | None = None
    session_info: dict | None = None
    session_dir: Path | None = None
    work_dir = getattr(args, "work_dir", None)
    if work_dir:
        base = Path(work_dir)
        now = datetime.now(timezone.utc)
        ts = now.strftime("%Y%m%dT%H%M%SZ")
        hash_input = f"{args.query}|{args.provider}|{ts}"
        run_hash = hashlib.sha256(hash_input.encode()).hexdigest()[:12]
        run_id = f"{ts}-{run_hash}"

        if session_topic is not None:
            session_dir, session_meta = _create_session(base, session_topic)
            evidence_dir = session_dir / "runs" / run_id / "evidence"
            session_info = {
                "session_id": session_meta.session_id,
                "topic": session_meta.topic,
                "run_number": session_meta.runs_total + 1,
                "metadata_status": "ok",
            }
        else:
            evidence_dir = base / "runs" / run_id / "evidence"

        cache_dir = base / "cache"
        evidence_dir.mkdir(parents=True, exist_ok=True)
        cache_dir.mkdir(parents=True, exist_ok=True)

    bound_fetcher = partial(fetch_url_to_evidence, evidence_dir=evidence_dir, cache_dir=cache_dir)
    bound_manifest_writer = partial(write_fetch_list_manifest, evidence_dir=evidence_dir)
    bound_search_manifest_writer = partial(write_search_run_manifest, evidence_dir=evidence_dir)

    result = _search_query_fn(
        provider,
        args.query,
        max_candidates=args.max_candidates,
        refresh=args.refresh,
        follow_redirects=bool(args.follow_redirects),
        fetcher=bound_fetcher,
        manifest_writer=bound_manifest_writer,
        search_manifest_writer=bound_search_manifest_writer,
        provider_config=provider_config,
        evidence_dir=evidence_dir,
        cache_dir=cache_dir,
    )

    # Update session metadata (best-effort)
    if session_info is not None and session_dir is not None:
        succeeded = sum(1 for r in result.evidence_results if r.fetch_status == "success")
        skipped = sum(1 for r in result.evidence_results if r.fetch_status == "skipped_duplicate")
        total = len(result.evidence_results)
        if total == 0:
            run_status = "error"
        elif succeeded + skipped == total:
            run_status = "ok"
        else:
            run_status = "partial_success"

        best_rel = max(
            (er.score for er in result.evidence_relevance), default=0.0,
        )
        profile_name = getattr(args, "profile", None) or (profile.name if profile else None)
        query_hash = hashlib.sha256(args.query.encode()).hexdigest()

        run_record = _SessionRunRecord(
            run_id=run_id,
            query=args.query,
            query_sha256=query_hash,
            provider=args.provider,
            profile=profile_name,
            status=run_status,
            sources_total=total,
            sources_succeeded=succeeded,
            sources_failed=total - succeeded - skipped,
            best_evidence_relevance=round(best_rel, 2),
            created_at=datetime.now(timezone.utc).isoformat(),
        )
        updated = _update_session_metadata(session_dir, run_record)
        if updated is None:
            session_info["metadata_status"] = "write_failed"

    # JSON output mode
    if getattr(args, "json", False):
        compact_summary_path = None
        if compact_mode and evidence_dir is not None:
            try:
                compact_summary_path = write_compact_summary(
                    result, work_dir=evidence_dir, query=args.query, profile=profile,
                )
            except Exception:
                compact_summary_path = None
        _print_search_result_json(result, args.query, evidence_dir, compact_summary_path, profile=profile, research_mode=research_mode_json, session_info=session_info)
        return 0

    candidates_total = len(result.discovery.candidates)
    selected = sum(1 for c in result.discovery.candidates if c.selected_for_fetch)
    blocked = sum(1 for c in result.discovery.candidates if c.url_policy == "blocked")
    duplicates = sum(1 for c in result.discovery.candidates if c.duplicate_of is not None)
    errors_count = len(result.discovery.errors)

    print(
        f"[discovery] provider={result.discovery.provider_name} "
        f"candidates={candidates_total} selected={selected} "
        f"blocked={blocked} duplicates={duplicates} errors={errors_count}",
        file=sys.stderr,
    )

    evidence_count = len(result.evidence_results)
    evidence_success = sum(1 for r in result.evidence_results if r.fetch_status == "success")
    print(
        f"[fetch] urls={evidence_count} evidence={evidence_success} "
        f"manifest={result.manifest_path or 'none'} "
        f"search_manifest={result.search_manifest_path or 'none'}",
        file=sys.stderr,
    )

    for r in result.evidence_results:
        qs = _quality_score(r)
        print(f"{r.original_url}\t{r.fetch_status}\t{r.cache_status}\t{qs}/3\t{r.evidence_path}")

    if result.manifest_path is not None:
        print(f"Manifest:\t{result.manifest_path}")

    if result.search_manifest_path is not None:
        print(f"SearchManifest:\t{result.search_manifest_path}")
    else:
        print("error: failed to write search-run manifest", file=sys.stderr)
        return 1

    return 0


if __name__ == "__main__":
    sys.exit(main())
