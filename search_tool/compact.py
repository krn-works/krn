"""Compact evidence index: deterministic mechanical summary of search results."""

from __future__ import annotations

import hashlib
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path

from search_tool.search import SearchRunResult, _quality_score
from search_tool.source_quality import classify_source_quality
from search_tool.profiles import Profile, profile_sort_key


SNIPPET_CHARS = 1000

# Common nav-only lines that should be skipped at the start of snippets
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


def _strip_nav_chrome(text: str) -> str:
    """Strip common nav-only lines from the beginning of extracted text.

    Mechanical cleanup only. No synthesis. Stops at first non-nav line.
    Also strips trailing empty lines after nav chrome.
    """
    lines = text.splitlines()
    start = 0
    while start < len(lines):
        stripped = lines[start].strip()
        if stripped in _NAV_CHROME_LINES:
            start += 1
            continue
        # Repeated empty lines after nav chrome are also noise
        if stripped == "" and start > 0 and lines[start - 1].strip() in _NAV_CHROME_LINES:
            start += 1
            continue
        break
    return "\n".join(lines[start:])


@dataclass(frozen=True)
class SourceEntry:
    title: str | None
    url: str
    source_type: str
    authority_score: int
    is_official: bool
    status: str
    quality_score: int
    relevance_score: float
    evidence_path: Path | None
    original_rank: int
    snippet: str | None


def _extract_evidence_text(evidence_path: Path) -> str:
    """Extract raw text content from an evidence pack file.

    Parses YAML frontmatter (skips it), then extracts text from code fences.
    Returns first SNIPPET_CHARS characters.
    """
    try:
        content = evidence_path.read_text(encoding="utf-8")
    except Exception:
        return ""

    # Skip YAML frontmatter
    parts = content.split("---", 2)
    if len(parts) >= 3:
        body = parts[2].strip()
    else:
        body = content.strip()

    # Extract text from code fences
    in_code = False
    code_lines: list[str] = []
    for line in body.split("\n"):
        if line.startswith("```"):
            in_code = not in_code
            continue
        if in_code:
            code_lines.append(line)

    text = "\n".join(code_lines)
    text = _strip_nav_chrome(text)
    return text[:SNIPPET_CHARS]


def _build_source_entries(result: SearchRunResult, profile: Profile | None = None) -> list[SourceEntry]:
    """Build source entries from search results with mechanical ordering.

    Without profile: authority_score desc, quality_score desc, original_rank asc.
    With profile:    profile_preference_match desc, authority_score desc, quality_score desc, rank asc.
    This is a mechanical ordering heuristic, not an AI judgment.
    """
    entries: list[SourceEntry] = []

    # Build a candidate lookup for title/rank
    candidate_map: dict[str, tuple[str | None, int]] = {}
    for c in result.discovery.candidates:
        candidate_map[c.url] = (c.title, c.rank)

    # Build relevance lookup by URL
    relevance_map: dict[str, float] = {}
    for er in result.evidence_relevance:
        relevance_map[er.url] = er.score

    for r in result.evidence_results:
        title, rank = candidate_map.get(r.original_url, (None, 999))
        sq = classify_source_quality(r.original_url, title)
        qs = _quality_score(r)
        relevance_url = r.final_url or r.normalized_url
        rel_score = relevance_map.get(relevance_url, 0.0)

        snippet = None
        evidence_path = None
        if r.fetch_status == "success":
            try:
                evidence_path = r.evidence_path
                snippet = _extract_evidence_text(r.evidence_path)
            except Exception:
                snippet = None

        entries.append(SourceEntry(
            title=title,
            url=r.original_url,
            source_type=sq.source_type,
            authority_score=sq.authority_score,
            is_official=sq.is_official,
            status=r.fetch_status,
            quality_score=qs,
            relevance_score=rel_score,
            evidence_path=evidence_path,
            original_rank=rank,
            snippet=snippet,
        ))

    # Deterministic mechanical ordering: profile preference, authority desc, quality desc, rank asc
    entries.sort(key=lambda e: profile_sort_key(
        profile, e.source_type, e.authority_score, e.quality_score, e.original_rank,
    ))
    return entries


def _md_table_safe(text: str) -> str:
    """Escape text for safe use inside a Markdown table cell."""
    return (
        text.replace("\\", "\\\\")
        .replace("|", "\\|")
        .replace("<", "\\<")
        .replace(">", "\\>")
    )


def write_compact_summary(
    result: SearchRunResult,
    *,
    work_dir: Path,
    query: str,
    profile: Profile | None = None,
) -> Path:
    """Write a compact evidence index summary to work_dir.

    Returns the path to the written summary file.
    """
    now = datetime.now(timezone.utc)
    ts = now.strftime("%Y%m%dT%H%M%SZ")
    hash_input = f"{result.discovery.query_redacted}|{result.discovery.provider_name}|{ts}"
    run_hash = hashlib.sha256(hash_input.encode()).hexdigest()[:12]

    work_dir.mkdir(parents=True, exist_ok=True)
    summary_path = work_dir / f"search-summary-{ts}-{run_hash}.md"

    entries = _build_source_entries(result, profile=profile)

    # Count outcomes
    succeeded = sum(1 for e in entries if e.status == "success")
    failed = sum(1 for e in entries if e.status in ("failed", "blocked"))

    query_hash = hashlib.sha256(query.encode()).hexdigest()

    lines: list[str] = []
    lines.append("# Compact Evidence Index")
    lines.append("")
    lines.append("## Query Metadata")
    lines.append("")
    lines.append(f"- **Query (redacted):** `{result.discovery.query_redacted}`")
    lines.append(f"- **Query SHA-256:** `{query_hash}`")
    lines.append(f"- **Provider:** {result.discovery.provider_name}")
    lines.append(f"- **Generated at:** {now.isoformat()}")
    lines.append(f"- **Sources total:** {len(entries)}")
    lines.append(f"- **Succeeded:** {succeeded}")
    lines.append(f"- **Failed/blocked:** {failed}")
    if profile is not None:
        lines.append(f"- **Profile:** {profile.name} ({profile.selection_policy})")
        lines.append(f"- **Profile reason:** {profile.reason}")
    lines.append("")

    # Source table
    lines.append("## Source Table")
    lines.append("")
    if profile is not None:
        lines.append(f"> Reading order: profile_preference_match desc ({profile.name}), authority_score desc, quality_score desc, original_rank asc (deterministic profile ordering, not AI ranking)")
    else:
        lines.append("> Reading order: authority_score desc, quality_score desc, original_rank asc (mechanical ordering, not AI judgment)")
    lines.append("")
    lines.append("| # | Title | URL | Type | Auth | Official | Status | Quality | Relevance | Evidence |")
    lines.append("|---|-------|-----|------|------|----------|--------|---------|------------|----------|")

    for i, e in enumerate(entries, 1):
        safe_title = _md_table_safe(e.title or "[no title]")
        safe_url = _md_table_safe(e.url)
        evidence_str = str(e.evidence_path) if e.evidence_path else "-"
        relevance_pct = f"{round(e.relevance_score * 100)}%"
        lines.append(
            f"| {i} | {safe_title} | {safe_url} | {e.source_type} | "
            f"{e.authority_score}/3 | {e.is_official} | {e.status} | "
            f"{e.quality_score}/3 | {relevance_pct} | {evidence_str} |"
        )

    lines.append("")

    # Mechanical snippets (successful sources only)
    successful_entries = [e for e in entries if e.status == "success" and e.snippet is not None]
    if successful_entries:
        lines.append("## Source Snippets")
        lines.append("")
        lines.append(f"> First {SNIPPET_CHARS} characters per source. No synthesis, no AI summarization.")
        lines.append("")

        for i, e in enumerate(successful_entries, 1):
            safe_title = _md_table_safe(e.title or e.url)
            lines.append(f"### {i}. {safe_title}")
            lines.append("")
            lines.append(f"- **URL:** {e.url}")
            lines.append(f"- **Authority:** {e.authority_score}/3 | **Quality:** {e.quality_score}/3 | **Type:** {e.source_type}")
            lines.append("")
            lines.append("```")
            lines.append(e.snippet if e.snippet else "[no content extracted]")
            lines.append("```")
            lines.append("")

    # Failures and limitations
    failed_entries = [e for e in entries if e.status in ("failed", "blocked")]
    if failed_entries:
        lines.append("## Failures")
        lines.append("")
        for e in failed_entries:
            lines.append(f"- {e.url}: {e.status}")
        lines.append("")

    all_limitations = list(result.limitations)
    if all_limitations:
        lines.append("## Limitations")
        lines.append("")
        for lim in all_limitations:
            lines.append(f"- {lim}")
        lines.append("")

    content = "\n".join(lines)
    summary_path.write_text(content, encoding="utf-8")
    return summary_path
