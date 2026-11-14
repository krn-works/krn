"""Extract: turn raw HTTP response body into readable plain text."""

from __future__ import annotations

from dataclasses import dataclass, field

from bs4 import BeautifulSoup, Tag

MAX_EXTRACTED_CHARS = 500_000

REMOVE_TAGS = {"script", "style", "noscript", "svg", "canvas", "iframe", "header", "footer", "nav"}

PREFERRED_CONTENT_SELECTORS = (
    '[data-testid="readme"]',
    "#readme",
    "article.markdown-body",
    "article[itemprop='text']",
    "article",
    "main",
    "[role='main']",
)

NOISE_EXACT_LINES = frozenset({
    "Skip to content",
    "Skip to main content",
    "Dismiss alert",
    "Notifications",
    "Fork",
    "Star",
    "Branches",
    "Tags",
    "Go to file",
    "Latest commit",
    "History",
    "Commits",
    "Repository files navigation",
    "Folders and files",
    "View all files",
    "Open more actions menu",
    "You signed in with another tab or window.",
    "Reload",
    "to refresh your session.",
    "You signed out in another tab or window.",
    "You switched accounts on another tab or window.",
    "Uh oh!",
    "There was an error while loading.",
    "Please reload this page",
    "You can’t perform that action at this time.",
})

STITCH_PUNCTUATION_LINES = frozenset({":", ",", ";"})

UNSUPPORTED_CONTENT_TYPES = {
    "application/pdf",
    "application/octet-stream",
    "image/",
    "audio/",
    "video/",
    "application/zip",
    "application/x-gzip",
    "application/x-tar",
    "font/",
    "application/font",
    "application/vnd.ms-fontobject",
    "application/x-font",
}


@dataclass
class ExtractionResult:
    status: str  # "success", "failed", "skipped", "truncated"
    method: str  # "beautifulsoup4-html-text", "plain-text", "none"
    title: str | None = None
    text: str = ""
    text_chars: int = 0
    truncated: bool = False
    errors: list[str] = field(default_factory=list)
    limitations: list[str] = field(default_factory=list)


def extract(
    body: bytes | None,
    content_type: str | None,
) -> ExtractionResult:
    """Extract readable text from a fetched response body."""
    if body is None:
        return ExtractionResult(status="skipped", method="none")

    # Check for unsupported content types
    if content_type and _is_unsupported(content_type):
        return ExtractionResult(
            status="skipped",
            method="none",
            limitations=[f"Unsupported content type: {content_type}"],
        )

    # Determine if text or HTML
    ct_lower = (content_type or "").lower()

    if "text/html" in ct_lower or "application/xhtml" in ct_lower:
        return _extract_html(body)
    elif "text/plain" in ct_lower or "text/" in ct_lower:
        return _extract_plain(body)
    else:
        # Try HTML if no content type or ambiguous
        if content_type is None:
            return _extract_html(body)
        return ExtractionResult(
            status="skipped",
            method="none",
            limitations=[f"Unrecognized content type: {content_type}"],
        )


def _extract_html(body: bytes) -> ExtractionResult:
    """Extract text from HTML using BeautifulSoup."""
    try:
        raw = body.decode("utf-8", errors="replace")
    except Exception:
        raw = body.decode("latin-1", errors="replace")

    try:
        soup = BeautifulSoup(raw, "html.parser")
    except Exception:
        return ExtractionResult(
            status="failed",
            method="beautifulsoup4-html-text",
            errors=["BeautifulSoup parse error"],
        )

    # Remove unwanted tags
    for tag_name in REMOVE_TAGS:
        for tag in soup.find_all(tag_name):
            tag.decompose()

    # Extract title
    title = None
    title_tag = soup.find("title")
    if isinstance(title_tag, Tag) and title_tag.string:
        title = title_tag.string.strip()

    text = _extract_best_html_text(soup)

    # Normalize, stitch fragmented punctuation lines common in HTML dumps, then normalize again.
    text = _normalize_whitespace(_stitch_fragmented_lines(_normalize_whitespace(text)))

    # Truncate
    truncated = False
    if len(text) > MAX_EXTRACTED_CHARS:
        text = text[:MAX_EXTRACTED_CHARS]
        truncated = True

    return ExtractionResult(
        status="truncated" if truncated else "success",
        method="beautifulsoup4-html-text",
        title=title,
        text=text,
        text_chars=len(text),
        truncated=truncated,
    )


def _extract_plain(body: bytes) -> ExtractionResult:
    """Extract text from text/plain content."""
    try:
        text = body.decode("utf-8", errors="replace")
    except Exception:
        text = body.decode("latin-1", errors="replace")

    # Normalize line endings
    text = text.replace("\r\n", "\n").replace("\r", "\n")

    # Truncate
    truncated = False
    if len(text) > MAX_EXTRACTED_CHARS:
        text = text[:MAX_EXTRACTED_CHARS]
        truncated = True

    return ExtractionResult(
        status="truncated" if truncated else "success",
        method="plain-text",
        text=text,
        text_chars=len(text),
        truncated=truncated,
    )


def _normalize_whitespace(text: str) -> str:
    """Collapse multiple blank lines, strip trailing whitespace."""
    lines = text.splitlines()
    cleaned: list[str] = []
    prev_blank = False
    for line in lines:
        stripped = line.strip()
        if stripped == "":
            if not prev_blank:
                cleaned.append("")
            prev_blank = True
        else:
            cleaned.append(stripped)
            prev_blank = False
    result = "\n".join(cleaned).strip()
    return result


def _extract_best_html_text(soup: BeautifulSoup) -> str:
    """Extract text from the most content-like region first, then fall back."""
    for selector in PREFERRED_CONTENT_SELECTORS:
        tag = soup.select_one(selector)
        if isinstance(tag, Tag):
            text = _strip_noise_lines(_normalize_whitespace(tag.get_text(separator="\n")))
            if _is_useful_content_text(text):
                return text

    body_tag = soup.find("body")
    if body_tag:
        return _strip_noise_lines(body_tag.get_text(separator="\n"))
    return _strip_noise_lines(soup.get_text(separator="\n"))


def _is_useful_content_text(text: str) -> bool:
    """Reject tiny chrome-only regions and accept content-like text blocks."""
    if len(text) < 80:
        return False
    non_noise_lines = [line for line in text.splitlines() if not _is_noise_line(line)]
    return len(non_noise_lines) >= 3


def _is_noise_line(line: str) -> bool:
    stripped = line.strip()
    return stripped in NOISE_EXACT_LINES


def _strip_noise_lines(text: str) -> str:
    """Remove standalone navigation/chrome/error lines from extracted HTML text."""
    lines = text.splitlines()
    filtered = [line for line in lines if not _is_noise_line(line)]
    return _normalize_whitespace("\n".join(filtered))


def _stitch_fragmented_lines(text: str) -> str:
    """Merge standalone punctuation lines back into surrounding content lines."""
    lines = text.splitlines()
    stitched: list[str] = []
    pending_punctuation = ""

    for i, line in enumerate(lines):
        stripped = line.strip()
        prev_stripped = lines[i - 1].strip() if i > 0 else ""
        next_stripped = lines[i + 1].strip() if i + 1 < len(lines) else ""

        if stripped == "" and (_starts_with_stitch_punctuation(prev_stripped) or _starts_with_stitch_punctuation(next_stripped)):
            continue

        if stripped in STITCH_PUNCTUATION_LINES and stitched:
            pending_punctuation += stripped
            continue

        if stitched and _starts_with_stitch_punctuation(stripped):
            stitched[-1] = stitched[-1].rstrip() + stripped[:1] + " " + stripped[2:]
            continue

        if pending_punctuation and stripped and stitched:
            stitched[-1] = stitched[-1].rstrip() + pending_punctuation + " " + stripped
            pending_punctuation = ""
            continue

        if pending_punctuation and not stripped and stitched:
            stitched[-1] = stitched[-1].rstrip() + pending_punctuation
            pending_punctuation = ""

        stitched.append(line)

    if pending_punctuation and stitched:
        stitched[-1] = stitched[-1].rstrip() + pending_punctuation

    return "\n".join(stitched)


def _starts_with_stitch_punctuation(text: str) -> bool:
    """Return True for standalone punctuation lines or lines like ': content'."""
    return any(text == punct or text.startswith(f"{punct} ") for punct in STITCH_PUNCTUATION_LINES)


def _is_unsupported(content_type: str) -> bool:
    """Check if content type is explicitly unsupported."""
    ct_lower = content_type.lower().split(";")[0].strip()
    for blocked in UNSUPPORTED_CONTENT_TYPES:
        if ct_lower.startswith(blocked) or ct_lower == blocked:
            return True
    return False
