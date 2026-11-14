"""Generate session summaries from multiple search runs."""

from __future__ import annotations

import hashlib
import json
from collections import defaultdict
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Dict, List

from search_tool.session import load_session_metadata, SessionMetadata


SESSION_SNIPPET_CHARS = 1000

_NAV_CHROME_LINES = frozenset({
    "Skip to main content",
    "Skip to content",
    "Skip to navigation",
    "Search...",
    "Search",
    "Navigation",
    "Menu",
    "On this page",
    "Table of contents",
    "Previous",
    "Next",
    "Up",
    "Parent",
    "Home",
    "Sign in",
    "Login",
    "Register",
    "Sign up",
})


@dataclass
class SessionSummary:
    """Summary of a session containing multiple runs."""
    session_id: str
    generated_at: datetime
    runs_count: int
    total_urls_fetched: int
    unique_sources: int
    total_evidence_packs: int
    total_limitations: int
    runs: List[Dict]
    cross_run_sources: Dict[str, List[str]]
    source_relevance: Dict[str, float]
    source_snippets: Dict[str, str]
    run_history: List[Dict]
    cross_run_overlap: Dict[str, int]
    limitations: List[str]
    session_metadata: SessionMetadata | None


def _strip_nav_chrome(text: str) -> str:
    """Strip common nav-only lines from the beginning of extracted text."""
    lines = text.splitlines()
    start = 0
    while start < len(lines):
        stripped = lines[start].strip()
        if stripped in _NAV_CHROME_LINES:
            start += 1
            continue
        if stripped == "" and start > 0 and lines[start - 1].strip() in _NAV_CHROME_LINES:
            start += 1
            continue
        break
    return "\n".join(lines[start:])


def _cap_snippet(text: str) -> str:
    """Length-cap a mechanical snippet without rewriting it."""
    return text[:SESSION_SNIPPET_CHARS]


def _extract_evidence_pack_text(evidence_path: Path) -> str:
    """Extract fenced source text from an existing evidence pack."""
    content = evidence_path.read_text(encoding="utf-8")

    parts = content.split("---", 2)
    if len(parts) >= 3:
        body = parts[2].strip()
    else:
        body = content.strip()

    in_code = False
    code_lines: list[str] = []
    for line in body.split("\n"):
        if line.startswith("```"):
            in_code = not in_code
            continue
        if in_code:
            code_lines.append(line)

    text = _strip_nav_chrome("\n".join(code_lines))
    return _cap_snippet(text)


def _resolve_evidence_path(run_dir: Path, evidence_path_value: object) -> Path | None:
    """Resolve an evidence path recorded in an existing run artifact."""
    if not isinstance(evidence_path_value, str) or not evidence_path_value.strip():
        return None

    path = Path(evidence_path_value)
    if path.is_absolute():
        return None

    try:
        run_root = run_dir.resolve(strict=True)
    except Exception:
        return None

    candidates = [
        run_dir / path,
        run_dir / "evidence" / path,
        run_dir / "evidence" / path.name,
    ]

    for candidate in candidates:
        resolved = candidate.resolve(strict=False)
        if not resolved.is_relative_to(run_root):
            continue
        if resolved.exists():
            return resolved
    return None


def _extract_source_snippet(run_dir: Path, evidence: Dict) -> tuple[str, str | None]:
    """Extract a deterministic source snippet from existing artifact fields."""
    for field in ("snippet", "excerpt", "content"):
        value = evidence.get(field)
        if isinstance(value, str) and value:
            return _cap_snippet(value), None

    path = _resolve_evidence_path(run_dir, evidence.get("evidence_path"))
    if path is None:
        return "", None

    try:
        return _extract_evidence_pack_text(path), None
    except Exception as exc:
        return "", f"Snippet unavailable for {evidence.get('url', '[unknown URL]')}: {exc}"


def _md_table_safe(text: str) -> str:
    """Escape text for safe use inside a Markdown table cell."""
    one_line = " ".join(text.replace("\r", "\n").splitlines())
    return (
        one_line.replace("\\", "\\\\")
        .replace("|", "\\|")
        .replace("<", "\\<")
        .replace(">", "\\>")
    )


def _count_run_fetch_fields(manifest_data: Dict) -> Dict[str, int]:
    """Count run fetch fields, falling back to evidence_results when needed."""
    fetch = manifest_data.get("fetch", {})
    evidence_results = manifest_data.get("evidence_results", [])

    counters = {
        "requested_urls": int(fetch.get("requested_urls", 0) or 0),
        "succeeded": int(fetch.get("succeeded", 0) or 0),
        "blocked": int(fetch.get("blocked", 0) or 0),
        "failed": int(fetch.get("failed", 0) or 0),
        "skipped_duplicates": int(fetch.get("skipped_duplicates", 0) or 0),
    }

    if evidence_results and (
        counters["requested_urls"] == 0
        or counters["succeeded"] == 0
        or (
            counters["blocked"] == 0
            and counters["failed"] == 0
            and any(
                evidence.get("status") not in ("success", "truncated", "skipped_duplicate")
                for evidence in evidence_results
            )
        )
    ):
        status_counts = defaultdict(int)
        for evidence in evidence_results:
            status = evidence.get("status")
            if isinstance(status, str):
                status_counts[status] += 1

        counters["requested_urls"] = len(evidence_results)
        counters["succeeded"] = status_counts["success"] + status_counts["truncated"]
        counters["blocked"] = status_counts["blocked"] + status_counts["policy_blocked"]
        counters["failed"] = (
            status_counts["failed"]
            + status_counts["error"]
            + status_counts["timeout"]
        )

    return counters


def generate_session_summary(work_dir: Path, session_id: str | None = None) -> SessionSummary:
    """Generate a summary of all runs in a specific session directory."""

    # Find the session directory
    sessions_dir = work_dir / "sessions"
    if not sessions_dir.exists():
        raise ValueError(f"No sessions directory found at {work_dir}/sessions")

    # If no session_id specified, find the only session or error
    if session_id is None:
        session_dirs = [d for d in sessions_dir.iterdir() if d.is_dir()]
        if len(session_dirs) == 0:
            raise ValueError("No sessions found in work directory")
        elif len(session_dirs) == 1:
            session_path = session_dirs[0]
        else:
            raise ValueError(f"Multiple sessions found. Please specify --session <topic> or --session-id <id>. Sessions: {', '.join(d.name for d in session_dirs)}")
    else:
        session_path = sessions_dir / session_id

    if not session_path.exists():
        raise ValueError(f"Session {session_id} not found")

    # Load session metadata
    session_metadata = load_session_metadata(session_path)

    # Find all run directories within this session
    runs = []
    run_dirs = []

    runs_in_session = session_path / "runs"
    if runs_in_session.exists():
        for item in runs_in_session.iterdir():
            if item.is_dir() and item.name != ".gitkeep":
                run_dirs.append(item)

    # Sort by timestamp to get chronological order
    run_dirs.sort()

    # Collect information from each run
    all_sources = set()
    run_history = []
    total_urls_fetched = 0
    total_evidence_packs = 0
    total_limitations = 0
    limitations = []

    # If session.yaml is missing or corrupt, record limitation but continue processing
    if session_metadata is None:
        limitations.append("Session metadata file (session.yaml) missing or corrupt")

    # Track evidence relevance scores for each source across runs
    source_relevance_scores: Dict[str, List[float]] = defaultdict(list)
    # Track snippets separately from relevance. Snippet selection is mechanical:
    # prefer non-empty snippets from the run with the best relevance score.
    source_snippet_candidates: Dict[str, tuple[float, str]] = {}

    for run_dir in run_dirs:
        try:
            # Look for search manifest
            search_manifest_path = run_dir / "search-run.json"
            if search_manifest_path.exists():
                with open(search_manifest_path, 'r') as f:
                    manifest_data = json.load(f)
                fetch_counts = _count_run_fetch_fields(manifest_data)

                # Extract basic info from manifest
                run_info = {
                    'run_id': run_dir.name,
                    'timestamp': run_dir.name.split('-')[0] if '-' in run_dir.name else run_dir.name,
                    'query': manifest_data.get('query', {}).get('redacted', ''),
                    'provider': manifest_data.get('discovery', {}).get('provider', ''),
                    'urls_requested': fetch_counts['requested_urls'],
                    'urls_succeeded': fetch_counts['succeeded'],
                    'urls_blocked': fetch_counts['blocked'],
                    'urls_failed': fetch_counts['failed'],
                    'urls_skipped': fetch_counts['skipped_duplicates'],
                    'total_limitations': len(manifest_data.get('limitations', [])),
                }

                # Build evidence relevance mapping for this run
                # This is the key fix: read evidence_relevance from the manifest, not source_quality
                evidence_relevance_by_url = {}
                for er_entry in manifest_data.get('evidence_relevance', []):
                    url = er_entry.get('url')
                    score = float(er_entry.get('score', 0.0))
                    if url:
                        evidence_relevance_by_url[url] = score

                # Collect source URLs for this run and track relevance scores
                sources_in_run = []
                for evidence in manifest_data.get('evidence_results', []):
                    if evidence.get('status') in ('success', 'truncated'):
                        url = evidence['url']
                        sources_in_run.append(url)

                        # Track relevance scores for this source across runs
                        # D4: Best relevance per source across runs (not average or most recent)
                        # Read from the top-level evidence_relevance field, not source_quality
                        relevance_score = evidence_relevance_by_url.get(url, 0.0)
                        # Always track the score even if it's zero - we want to know about all sources
                        source_relevance_scores[url].append(relevance_score)
                        snippet, snippet_limitation = _extract_source_snippet(run_dir, evidence)
                        if snippet_limitation:
                            limitations.append(snippet_limitation)
                        if url not in source_snippet_candidates:
                            source_snippet_candidates[url] = (relevance_score, snippet)
                        elif snippet and (
                            not source_snippet_candidates[url][1]
                            or relevance_score > source_snippet_candidates[url][0]
                        ):
                            source_snippet_candidates[url] = (relevance_score, snippet)

                run_info['sources'] = sources_in_run
                run_info['source_count'] = len(sources_in_run)

                runs.append(manifest_data)
                run_history.append(run_info)

                total_urls_fetched += run_info['urls_requested']
                total_evidence_packs += run_info['urls_succeeded']
                total_limitations += run_info['total_limitations']

                # Add sources to global set
                all_sources.update(sources_in_run)

            else:
                # Missing search-run.json - record limitation but continue processing
                limitations.append(f"Run {run_dir.name} missing search-run.json")

        except Exception as e:
            # Skip problematic runs but record limitation and continue processing
            limitations.append(f"Run {run_dir.name} processing failed: {str(e)}")
            continue

    # Generate cross-run unique source table
    cross_run_sources = defaultdict(list)

    # For each source, list which runs it appeared in
    for run_dir in run_dirs:
        try:
            search_manifest_path = run_dir / "search-run.json"
            if search_manifest_path.exists():
                with open(search_manifest_path, 'r') as f:
                    manifest_data = json.load(f)

                # Get sources from this run
                sources_in_run = []
                for evidence in manifest_data.get('evidence_results', []):
                    if evidence.get('status') in ('success', 'truncated'):
                        sources_in_run.append(evidence['url'])

                # Add to cross-run mapping
                for source_url in sources_in_run:
                    cross_run_sources[source_url].append(run_dir.name)

        except Exception:
            continue

    # Calculate per-source best relevance (max across all runs, not frequency)
    source_relevance = {}
    for url, scores in source_relevance_scores.items():
        if scores:
            # D4: Best relevance per source across runs (not average or most recent)
            # The highest score indicates better query-source term overlap
            source_relevance[url] = max(scores)
        else:
            # Default to 0.0 for sources without relevance data
            source_relevance[url] = 0.0

    source_snippets = {
        url: source_snippet_candidates.get(url, (0.0, ""))[1]
        for url in sorted(all_sources)
    }

    # Generate run history table data
    run_history_table = []
    for run_info in run_history:
        run_history_table.append({
            'run_id': run_info['run_id'],
            'timestamp': run_info['timestamp'],
            'query': run_info['query'][:50] + '...' if len(run_info['query']) > 50 else run_info['query'],
            'provider': run_info['provider'],
            'urls_requested': run_info['urls_requested'],
            'urls_succeeded': run_info['urls_succeeded'],
            'urls_blocked': run_info['urls_blocked'],
            'urls_failed': run_info['urls_failed'],
            'urls_skipped': run_info['urls_skipped'],
            'total_limitations': run_info['total_limitations'],
        })

    # Generate cross-run overlap report
    cross_run_overlap = {}
    if len(run_dirs) > 1:
        # Count how many runs each source appears in
        for url, run_list in cross_run_sources.items():
            count = len(set(run_list))
            cross_run_overlap[url] = count

    # Create session ID from the one passed in or from first run
    if session_id is not None:
        session_identifier = session_id
    else:
        session_identifier = "session-" + hashlib.sha256(str(sorted([r.name for r in run_dirs])).encode()).hexdigest()[:12]

    return SessionSummary(
        session_id=session_identifier,
        generated_at=datetime.now(),
        runs_count=len(run_dirs),
        total_urls_fetched=total_urls_fetched,
        unique_sources=len(all_sources),
        total_evidence_packs=total_evidence_packs,
        total_limitations=total_limitations,
        runs=runs,
        cross_run_sources=dict(cross_run_sources),
        source_relevance=source_relevance,
        source_snippets=source_snippets,
        run_history=run_history_table,
        cross_run_overlap=cross_run_overlap,
        limitations=limitations,
        session_metadata=session_metadata
    )


def write_session_summary(summary: SessionSummary, output_path: Path) -> None:
    """Write session summary to a markdown file."""

    lines = []
    lines.append("# Session Summary")
    lines.append("")
    lines.append(f"**Session ID:** {summary.session_id}")
    lines.append(f"**Generated At:** {summary.generated_at.isoformat()}")
    lines.append("")

    # Session metadata
    if summary.session_metadata is not None:
        lines.append("## Session Metadata")
        lines.append("")
        lines.append(f"- **Topic:** {summary.session_metadata.topic}")
        lines.append(f"- **Created At:** {summary.session_metadata.created_at}")
        lines.append(f"- **Status:** {summary.session_metadata.status}")
        lines.append(f"- **Runs Total:** {summary.session_metadata.runs_total}")
        lines.append("")

    # Session statistics
    lines.append("## Session Statistics")
    lines.append("")
    lines.append(f"- **Total Runs:** {summary.runs_count}")
    lines.append(f"- **Total URLs Fetched:** {summary.total_urls_fetched}")
    lines.append(f"- **Unique Sources:** {summary.unique_sources}")
    lines.append(f"- **Total Evidence Packs:** {summary.total_evidence_packs}")
    lines.append(f"- **Total Limitations:** {summary.total_limitations}")
    lines.append("")

    # Run history table
    if summary.run_history:
        lines.append("## Run History")
        lines.append("")
        lines.append("| Run ID | Timestamp | Query | Provider | URLs Requested | URLs Succeeded | URLs Blocked | URLs Failed | URLs Skipped | Limitations |")
        lines.append("|--------|-----------|-------|----------|----------------|--------------|------------|-------------|--------------|-------------|")

        for run in summary.run_history:
            lines.append(f"| {run['run_id']} | {run['timestamp']} | {run['query']} | {run['provider']} | {run['urls_requested']} | {run['urls_succeeded']} | {run['urls_blocked']} | {run['urls_failed']} | {run['urls_skipped']} | {run['total_limitations']} |")
        lines.append("")

    # Cross-run unique sources
    if summary.cross_run_sources:
        lines.append("## Cross-Run Unique Sources")
        lines.append("")
        lines.append("| Source URL | Appears in Runs |")
        lines.append("|------------|-----------------|")

        # Sort by number of appearances (descending)
        sorted_sources = sorted(summary.cross_run_sources.items(), key=lambda x: len(x[1]), reverse=True)

        for url, runs in sorted_sources:
            run_list = ', '.join(runs[:3])  # Show first 3 runs
            if len(runs) > 3:
                run_list += f" (and {len(runs)-3} more)"
            lines.append(f"| {url[:100]} | {run_list} |")
        lines.append("")

    # Source relevance table
    if summary.source_relevance:
        lines.append("## Source Relevance")
        lines.append("")
        lines.append("| Source URL | Relevance Score |")
        lines.append("|------------|-----------------|")

        # Sort by relevance score (descending)
        sorted_relevance = sorted(summary.source_relevance.items(), key=lambda x: x[1], reverse=True)

        for url, score in sorted_relevance:
            lines.append(f"| {url[:100]} | {score:.2f} |")
        lines.append("")

    # Source snippets table
    if summary.source_snippets:
        lines.append("## Source Snippets")
        lines.append("")
        lines.append(f"> First {SESSION_SNIPPET_CHARS} characters per source. Mechanical extraction only; no synthesis.")
        lines.append("")
        lines.append("| Source URL | Snippet |")
        lines.append("|------------|---------|")

        sorted_snippets = sorted(
            summary.source_snippets.items(),
            key=lambda x: (-summary.source_relevance.get(x[0], 0.0), x[0]),
        )

        for url, snippet in sorted_snippets:
            safe_url = _md_table_safe(url)
            safe_snippet = _md_table_safe(snippet)
            lines.append(f"| {safe_url} | {safe_snippet} |")
        lines.append("")

    # Cross-run overlap report
    if summary.cross_run_overlap:
        lines.append("## Cross-Run Overlap Report")
        lines.append("")
        lines.append("| Source URL | Appears in N Runs |")
        lines.append("|------------|-------------------|")

        # Sort by number of runs (descending)
        sorted_overlap = sorted(summary.cross_run_overlap.items(), key=lambda x: x[1], reverse=True)

        for url, count in sorted_overlap:
            lines.append(f"| {url[:100]} | {count} |")
        lines.append("")

    # Limitations
    if summary.limitations:
        lines.append("## Limitations")
        lines.append("")
        for lim in summary.limitations:
            lines.append(f"- {lim}")
        lines.append("")

    # Write to file
    output_path.write_text('\n'.join(lines), encoding='utf-8')


def generate_session_summary_on_demand(work_dir: Path, session_id: str | None = None, output_path: Path | None = None) -> Path:
    """Generate session summary on demand and return path to the output file."""
    summary = generate_session_summary(work_dir, session_id)
    # Use provided output path or default to session directory
    if output_path is not None:
        final_output_path = Path(output_path)
    else:
        # Default output path is in the session directory
        final_output_path = work_dir / "sessions" / summary.session_id / "session-summary.md"
    final_output_path.parent.mkdir(parents=True, exist_ok=True)
    write_session_summary(summary, final_output_path)
    return final_output_path
