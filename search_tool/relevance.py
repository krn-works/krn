"""Deterministic relevance scoring: textual overlap between query and source content."""

from __future__ import annotations

import re
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import urlparse

from search_tool.discovery import DiscoveryCandidate
from search_tool.source_quality import SourceQuality

STOP_WORDS = frozenset({
    "a", "an", "the", "and", "or", "but", "in", "on", "at", "to", "for",
    "of", "with", "by", "from", "is", "are", "was", "were", "be", "been",
    "being", "have", "has", "had", "do", "does", "did", "will", "would",
    "could", "should", "may", "might", "can", "shall", "not", "no",
    "this", "that", "these", "those", "it", "its",
})

_GENERIC_TITLE_RE = re.compile(r"^(top \d+|best \d+|\d+ (best|top|free))", re.IGNORECASE)
_GENERIC_PATH_RE = re.compile(r"(listing|category|tag|page|archive|search)", re.IGNORECASE)
_TOKEN_RE = re.compile(r"[^\W_]+", re.UNICODE)


@dataclass(frozen=True)
class QueryTokens:
    raw_tokens: tuple[str, ...]
    important_tokens: tuple[str, ...]
    normalized_query: str


@dataclass(frozen=True)
class CandidateComponents:
    title_overlap: float
    snippet_overlap: float
    url_path_overlap: float
    exact_phrase_in_title: bool
    exact_phrase_in_snippet: bool
    source_quality_modifier: float
    generic_page_penalty: float


@dataclass(frozen=True)
class CandidateRelevance:
    score: float
    components: CandidateComponents


@dataclass(frozen=True)
class EvidenceComponents:
    text_overlap: float
    heading_match: float
    early_content_overlap: float
    content_density: float
    exact_phrase_in_text: bool
    low_content_penalty: float


@dataclass(frozen=True)
class EvidenceRelevance:
    score: float
    components: EvidenceComponents


def tokenize_query(query: str) -> QueryTokens:
    normalized = query.strip().lower()
    normalized = " ".join(normalized.split())
    normalized = normalized.replace("-", " ")
    raw_tokens = tuple(normalized.split())
    important_tokens = tuple(t for t in raw_tokens if t not in STOP_WORDS)
    normalized_query = " ".join(raw_tokens)
    return QueryTokens(
        raw_tokens=raw_tokens,
        important_tokens=important_tokens,
        normalized_query=normalized_query,
    )


def _text_tokens(text: str) -> frozenset[str]:
    normalized = text.lower().replace("-", " ")
    return frozenset(_TOKEN_RE.findall(normalized))


def _token_overlap(tokens: tuple[str, ...], text: str) -> float:
    if not tokens:
        return 0.0
    haystack = _text_tokens(text)
    found = sum(1 for t in tokens if t in haystack)
    return found / len(tokens)


def _source_quality_modifier(sq: SourceQuality) -> float:
    if sq.source_type == "seo":
        return -0.20
    if sq.source_type == "forum" and sq.authority_score <= 1:
        return -0.10
    if sq.is_official:
        return 0.10
    return 0.0


def _generic_page_penalty(
    title: str | None,
    snippet: str | None,
    url: str,
) -> float:
    penalties = []
    if title is not None and _GENERIC_TITLE_RE.search(title):
        penalties.append(0.15)
    try:
        path = urlparse(url).path.lower().strip("/")
        segments = [s for s in path.split("/") if s]
        if any(_GENERIC_PATH_RE.search(s) for s in segments):
            penalties.append(0.15)
    except Exception:
        pass
    if not snippet:
        penalties.append(0.10)
    return -max(penalties) if penalties else 0.0


def score_candidate_relevance(
    query: QueryTokens,
    candidate: DiscoveryCandidate,
    source_quality: SourceQuality,
) -> CandidateRelevance:
    if not query.raw_tokens:
        return CandidateRelevance(
            score=0.0,
            components=CandidateComponents(
                title_overlap=0.0,
                snippet_overlap=0.0,
                url_path_overlap=0.0,
                exact_phrase_in_title=False,
                exact_phrase_in_snippet=False,
                source_quality_modifier=0.0,
                generic_page_penalty=0.0,
            ),
        )

    scoring_tokens = query.important_tokens if query.important_tokens else query.raw_tokens

    title_overlap = _token_overlap(scoring_tokens, candidate.title or "")
    snippet_overlap = _token_overlap(scoring_tokens, candidate.snippet or "")

    try:
        path = urlparse(candidate.url).path.lower()
        url_text = path.replace("/", " ").replace("-", " ")
        url_path_overlap = _token_overlap(query.raw_tokens, url_text)
    except Exception:
        url_path_overlap = 0.0

    exact_in_title = (
        candidate.title is not None
        and query.normalized_query in candidate.title.lower()
    )
    exact_in_snippet = (
        candidate.snippet is not None
        and query.normalized_query in candidate.snippet.lower()
    )
    exact_phrase_bonus = 1.0 if (exact_in_title or exact_in_snippet) else 0.0

    base_score = (
        0.40 * title_overlap
        + 0.25 * snippet_overlap
        + 0.15 * url_path_overlap
        + 0.20 * exact_phrase_bonus
    )

    sq_mod = _source_quality_modifier(source_quality)
    gen_pen = _generic_page_penalty(candidate.title, candidate.snippet, candidate.url)

    score = max(0.0, min(1.0, base_score + sq_mod + gen_pen))

    return CandidateRelevance(
        score=round(score, 4),
        components=CandidateComponents(
            title_overlap=round(title_overlap, 4),
            snippet_overlap=round(snippet_overlap, 4),
            url_path_overlap=round(url_path_overlap, 4),
            exact_phrase_in_title=exact_in_title,
            exact_phrase_in_snippet=exact_in_snippet,
            source_quality_modifier=sq_mod,
            generic_page_penalty=round(gen_pen, 4),
        ),
    )


def _extract_text_and_headings(evidence_path: Path) -> tuple[str, str]:
    try:
        content = evidence_path.read_text(encoding="utf-8")
    except Exception:
        return "", ""

    parts = content.split("---", 2)
    if len(parts) >= 3:
        body = parts[2].strip()
    else:
        body = content.strip()

    in_code = False
    code_lines: list[str] = []
    headings: list[str] = []
    for line in body.split("\n"):
        if line.startswith("```"):
            in_code = not in_code
            continue
        if in_code:
            code_lines.append(line)
            stripped = line.strip()
            if stripped.startswith("#"):
                heading_text = stripped.lstrip("#").strip()
                if heading_text:
                    headings.append(heading_text)

    full_text = "\n".join(code_lines)
    heading_text = " ".join(headings)
    return full_text, heading_text


def _compute_content_density(text: str) -> float:
    from search_tool.compact import _NAV_CHROME_LINES

    lines = [l for l in text.splitlines() if l.strip()]
    if not lines:
        return 0.0
    unique: list[str] = []
    prev: str | None = None
    for l in lines:
        stripped = l.strip()
        if stripped != prev:
            unique.append(stripped)
            prev = stripped
    nav_count = sum(1 for l in unique if l in _NAV_CHROME_LINES)
    density = (len(unique) - nav_count) / max(len(lines), 1)
    return max(0.0, min(1.0, density))


def score_evidence_relevance(
    query: QueryTokens,
    evidence_path: Path,
    *,
    fetch_status: str = "success",
    extraction_status: str = "success",
) -> EvidenceRelevance:
    zero_components = EvidenceComponents(
        text_overlap=0.0,
        heading_match=0.0,
        early_content_overlap=0.0,
        content_density=0.0,
        exact_phrase_in_text=False,
        low_content_penalty=0.0,
    )

    if not query.raw_tokens:
        return EvidenceRelevance(score=0.0, components=zero_components)

    if fetch_status != "success" or extraction_status not in ("success", "truncated"):
        return EvidenceRelevance(score=0.0, components=zero_components)

    full_text, heading_text = _extract_text_and_headings(evidence_path)

    if not full_text.strip():
        return EvidenceRelevance(
            score=0.0,
            components=EvidenceComponents(
                text_overlap=0.0,
                heading_match=0.0,
                early_content_overlap=0.0,
                content_density=0.0,
                exact_phrase_in_text=False,
                low_content_penalty=-0.20,
            ),
        )

    scoring_tokens = query.important_tokens if query.important_tokens else query.raw_tokens

    text_overlap = _token_overlap(scoring_tokens, full_text)
    heading_match = _token_overlap(scoring_tokens, heading_text)

    early_text = full_text[:2000] if len(full_text) > 2000 else full_text
    early_content_overlap = (
        _token_overlap(scoring_tokens, early_text)
        if len(full_text) > 2000
        else text_overlap
    )

    density = _compute_content_density(full_text)

    exact_in_text = query.normalized_query in full_text.lower()
    exact_phrase_bonus = 1.0 if exact_in_text else 0.0

    penalties = []
    if len(full_text) < 200:
        penalties.append(0.20)
    if density < 0.3:
        penalties.append(0.20)
    low_content_penalty = -max(penalties) if penalties else 0.0

    base_score = (
        0.30 * text_overlap
        + 0.15 * heading_match
        + 0.25 * early_content_overlap
        + 0.10 * density
        + 0.20 * exact_phrase_bonus
    )

    score = max(0.0, min(1.0, base_score + low_content_penalty))

    return EvidenceRelevance(
        score=round(score, 4),
        components=EvidenceComponents(
            text_overlap=round(text_overlap, 4),
            heading_match=round(heading_match, 4),
            early_content_overlap=round(early_content_overlap, 4),
            content_density=round(density, 4),
            exact_phrase_in_text=exact_in_text,
            low_content_penalty=round(low_content_penalty, 4),
        ),
    )
