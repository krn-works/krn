# Deterministic Relevance Scoring

## Scope

Design for a deterministic, non-LLM relevance signal in krn-search. Scores estimate whether discovered/fetched content is textually related to the query. This is a mechanical heuristic, not semantic understanding.

## What relevance means here

**Textual overlap between query terms and source content.** A relevance score answers: "Does this source contain words from the query?" It is a keyword proximity signal.

Relevance complements existing signals:
- **Source quality** (`source_quality.py`): "Is this source authoritative?" (URL/domain heuristics)
- **Quality score** (`_quality_score()`): "Did fetch/extraction succeed?" (technical outcome)
- **Relevance** (new): "Does the content mention query terms?" (textual overlap)

The three signals are independent. A high-quality official source can be irrelevant. A relevant source can be low-quality.

## What relevance does NOT mean

- Semantic understanding of the query intent
- Answer extraction or claim verification
- Content usefulness for a research question
- Topic modeling or concept matching
- Replacement for human judgment about source value
- A reason to auto-filter or auto-rank sources

## Query tokenization

```
Input:  query string
Steps:
  1. Lowercase
  2. Strip leading/trailing whitespace, collapse internal whitespace
  3. Split on whitespace → raw_tokens
  4. Filter stop words → important_tokens (for weighted scoring)
  5. Join all raw_tokens → normalized_query_string (for exact phrase matching)
Output: QueryTokens(raw_tokens, important_tokens, normalized_query)
```

### Stop word list (English only, deterministic)

A fixed set of ~40 English stop words. No stemming, no lemmatization, no Polish-specific processing.

```python
STOP_WORDS = frozenset({
    "a", "an", "the", "and", "or", "but", "in", "on", "at", "to", "for",
    "of", "with", "by", "from", "is", "are", "was", "were", "be", "been",
    "being", "have", "has", "had", "do", "does", "did", "will", "would",
    "could", "should", "may", "might", "can", "shall", "not", "no",
    "this", "that", "these", "those", "it", "its",
})
```

### Tokenization constraints

- Diacritics preserved as-is: "zażółć" stays "zażółć". Polish queries match Polish content exactly.
- Hyphens treated as separators: "well-known" → ["well", "known"].
- No Unicode normalization beyond lowercasing.
- Single-character tokens are kept (Polish prepositions: "w", "z", "o").

### Token types

| Type | Definition | Weight multiplier | Example |
|------|-----------|-------------------|---------|
| `raw_token` | Any whitespace-split token after lowercasing | 1.0x | "building", "ai", "agents" |
| `important_token` | Raw token not in STOP_WORDS | 1.5x | "building", "ai", "agents" |
| `exact_phrase` | Full normalized query string | 3.0x (bonus if found) | "building ai agents" |

## Candidate relevance (pre-fetch)

Computed for each `DiscoveryCandidate` after discovery, before fetch. Uses only data available from the discovery provider: `url`, `title`, `snippet`.

### Score components

```python
@dataclass(frozen=True)
class CandidateRelevance:
    score: float                    # 0.0 – 1.0
    components: CandidateComponents

@dataclass(frozen=True)
class CandidateComponents:
    title_overlap: float            # 0.0 – 1.0, important_tokens found in title / total important_tokens
    snippet_overlap: float          # 0.0 – 1.0, important_tokens found in snippet / total important_tokens
    url_path_overlap: float         # 0.0 – 1.0, raw_tokens found in URL path segments / total raw_tokens
    exact_phrase_in_title: bool     # normalized_query substring of title
    exact_phrase_in_snippet: bool   # normalized_query substring of snippet
    source_quality_modifier: float  # -0.2 to +0.1, interaction with source_quality classification
    generic_page_penalty: float     # 0.0 or -0.15, penalty for SEO/listing/forum indicators
```

### Scoring formula

```
base_score = (
    0.40 * title_overlap +
    0.25 * snippet_overlap +
    0.15 * url_path_overlap +
    0.20 * exact_phrase_bonus   # 1.0 if any exact_phrase match, else 0.0
)

score = clamp(base_score + source_quality_modifier + generic_page_penalty, 0.0, 1.0)
```

### Source quality modifier

Interacts with `classify_source_quality()` output:

| Condition | Modifier |
|-----------|----------|
| `source_type == "seo"` | -0.20 |
| `source_type == "forum"` and `authority_score <= 1` | -0.10 |
| `is_official == True` | +0.10 |
| Otherwise | 0.0 |

### Generic page penalty

Applied when title or URL path matches generic listing patterns:

| Pattern | Penalty |
|---------|---------|
| Title matches `/^(top \d+|best \d+|\d+ (best|top|free))/i` | -0.15 |
| URL path segment matches `/(listing|category|tag|page|archive|search)/i` | -0.15 |
| Snippet is None or empty | -0.10 |

Penalties are not cumulative. The largest penalty applies.

### Edge cases

- Empty title/snippet: corresponding overlap is 0.0.
- Empty query (should not happen at this point): score is 0.0.
- All important_tokens are stop words: fall back to raw_tokens for overlap calculation.
- URL with no path segments: url_path_overlap is 0.0.

## Evidence relevance (post-fetch)

Computed for each `EvidenceWriteResult` after extraction. Uses the extracted text from the evidence pack.

### Score components

```python
@dataclass(frozen=True)
class EvidenceRelevance:
    score: float                    # 0.0 – 1.0
    components: EvidenceComponents

@dataclass(frozen=True)
class EvidenceComponents:
    text_overlap: float             # 0.0 – 1.0, important_tokens found in full text / total important_tokens
    heading_match: float            # 0.0 – 1.0, important_tokens found in markdown headings / total important_tokens
    early_content_overlap: float    # 0.0 – 1.0, important_tokens in first 2000 chars / total important_tokens
    content_density: float          # 0.0 – 1.0, ratio of non-nav-unique-lines to total lines
    exact_phrase_in_text: bool      # normalized_query substring of full text
    low_content_penalty: float      # 0.0 or -0.20, penalty for very short or nav-only content
```

### Scoring formula

```
base_score = (
    0.30 * text_overlap +
    0.15 * heading_match +
    0.25 * early_content_overlap +
    0.10 * content_density +
    0.20 * exact_phrase_bonus   # 1.0 if match, else 0.0
)

score = clamp(base_score + low_content_penalty, 0.0, 1.0)
```

### Content density

```
total_lines = non-empty lines in extracted text
unique_lines = total_lines after deduplicating consecutive identical stripped lines
nav_chrome_lines = lines matching _NAV_CHROME_LINES set (from compact.py)

density = (unique_lines - nav_chrome_lines_count) / max(total_lines, 1)
```

### Low content penalty

| Condition | Penalty |
|-----------|---------|
| Extracted text < 200 chars | -0.20 |
| Content density < 0.3 (after nav chrome removal) | -0.20 |
| Extraction failed or skipped | score is 0.0, no penalty applied |

### Heading extraction

Parse the evidence pack markdown body for lines starting with `#`, `##`, `###`. Collect heading text (without the `#` prefix). Match important_tokens against concatenated heading text.

### Edge cases

- `fetch_status != "success"`: score is 0.0, no components computed.
- `extraction_status != "success"`: score is 0.0, no components computed.
- Empty extracted text: all overlaps are 0.0, low_content_penalty applies.
- Text shorter than 2000 chars: early_content_overlap = text_overlap (same window).

## Output schema

### Candidate relevance in discovery-diagnostics.json

Added to each entry in `selected_candidates` array:

```json
{
  "rank": 1,
  "url": "https://example.com/docs/building-agents",
  "title": "Building AI Agents",
  "snippet": "Guide to building effective AI agents...",
  "source_engine": "searxng",
  "source_quality": { ... },
  "candidate_relevance": {
    "score": 0.85,
    "components": {
      "title_overlap": 1.0,
      "snippet_overlap": 0.67,
      "url_path_overlap": 0.5,
      "exact_phrase_in_title": false,
      "exact_phrase_in_snippet": true,
      "source_quality_modifier": 0.1,
      "generic_page_penalty": 0.0
    }
  }
}
```

### Evidence relevance in search-run manifest

Added as a section in the YAML frontmatter under `evidence_relevance`:

```yaml
evidence_relevance:
  - url: "https://example.com/docs/building-agents"
    score: 0.72
    components:
      text_overlap: 0.67
      heading_match: 1.0
      early_content_overlap: 0.83
      content_density: 0.71
      exact_phrase_in_text: true
      low_content_penalty: 0.0
```

### Evidence relevance in SearchRunResult (Python)

Added field to `SearchRunResult`:

```python
@dataclass(frozen=True)
class SearchRunResult:
    discovery: DiscoveryResult
    evidence_results: tuple[EvidenceWriteResult, ...]
    manifest_path: Path | None
    search_manifest_path: Path | None
    limitations: tuple[str, ...]
    discovery_diagnostics_path: Path | None = None
    evidence_relevance: tuple[EvidenceRelevanceEntry, ...] = ()  # new

@dataclass(frozen=True)
class EvidenceRelevanceEntry:
    url: str
    score: float
    components: EvidenceComponents
```

### Compact summary

Added as a `Relevance` column in the source table:

```
| # | Title | URL | Type | Auth | Official | Status | Quality | Relevance | Evidence |
```

Relevance displayed as percentage: `72%`.

## Where scores should appear

| Artifact | Candidate relevance | Evidence relevance |
|----------|--------------------|--------------------|
| discovery-diagnostics.json | Yes (in selected_candidates) | No |
| search-run manifest (YAML frontmatter) | No | Yes (per evidence result) |
| compact summary | No | Yes (Relevance column) |
| CLI JSON output | Yes (from diagnostics) | Yes (from SearchRunResult) |
| Evidence pack frontmatter | No | No — not justified. Scores are about the query-content relationship, not about the evidence pack itself. Evidence packs are query-independent artifacts. |

## Behavior impact

### MVP-1Q scope: metadata-only

- Scores are computed and recorded.
- Scores are visible in diagnostics, manifests, and summaries.
- **No auto-reranking** of sources based on relevance.
- **No auto-filtering** of low-relevance sources.
- **No behavior changes** to discovery, fetch, or extraction.
- The caller (Claude Code agent, human reader) uses scores as informational signals.

### Later stages (explicitly out of scope for MVP-1Q)

- Relevance-based source ordering in compact summary
- Relevance-based filtering (drop sources below threshold)
- Relevance-aware discovery strategy (request more candidates if all are low)
- Relevance-based search-run quality assessment

## New module

All relevance scoring code goes in a new module: `search_tool/relevance.py`.

Responsibilities:
- `tokenize_query(query: str) -> QueryTokens`
- `score_candidate_relevance(query: QueryTokens, candidate: DiscoveryCandidate, source_quality: SourceQuality) -> CandidateRelevance`
- `score_evidence_relevance(query: QueryTokens, evidence_path: Path) -> EvidenceRelevance`

No changes to existing modules' logic. Existing modules call into `relevance.py` only to record scores.

## Tests and evals

### Deterministic unit tests

All tests use synthetic fixtures. No network. No real HTTP.

**Test categories:**

1. **Query tokenization** (in `tests/test_relevance.py`)
   - Simple English query
   - Query with stop words only → falls back to raw tokens
   - Query with hyphens
   - Polish query (diacritics preserved)
   - Empty/whitespace query
   - Single-token query
   - Mixed case

2. **Candidate relevance** (in `tests/test_relevance.py`)
   - All terms in title → high score
   - No title → title_overlap is 0.0
   - Exact phrase match in title → bonus applied
   - Generic listing title → penalty applied
   - SEO source type → modifier applied
   - Official docs source type → positive modifier
   - Empty snippet → snippet_overlap is 0.0
   - All stop words → raw tokens used

3. **Evidence relevance** (in `tests/test_relevance.py`)
   - Terms in extracted text → text_overlap > 0
   - Terms in headings → heading_match > 0
   - Terms in first 2000 chars only → early_content_overlap high, text_overlap moderate
   - Nav-only content → low_content_penalty applied
   - Very short content (< 200 chars) → penalty applied
   - Failed extraction → score is 0.0
   - Empty text → penalty applied

4. **Integration** (in `tests/test_relevance.py`)
   - Score candidate → appears in discovery-diagnostics.json
   - Score evidence → appears in search-run manifest
   - Score evidence → appears in compact summary

### Synthetic fixtures

Create `tests/fixtures/relevance/` with:
- `evidence_high_relevance.md` — evidence pack with good query term coverage
- `evidence_low_relevance.md` — evidence pack with nav-only content
- `evidence_medium_relevance.md` — evidence pack with partial term coverage

### Dogfood cases (MVP-1Q.4)

Run with real krn-search queries and manually assess:
1. Does the relevance score match my intuition about source usefulness?
2. Are SEO pages correctly penalized?
3. Are official docs with matching terms correctly boosted?
4. Does Polish content score correctly?

### CI

All unit tests run in CI. No network required. Deterministic.

## Risks and mitigations

| Risk | Likelihood | Mitigation |
|------|-----------|------------|
| Keyword scoring overfits to exact matches | High | Document as accepted limitation. Exact match is the defined scope. |
| Polish/English tokenization issues | Medium | No stemming. Diacritics preserved. Exact matching is predictable. |
| False confidence from high scores on irrelevant content | Medium | Explicit "not usefulness" disclaimer in all score output. Scores are textual overlap, not answer quality. |
| SEO pages match terms too well | High | Generic page penalty + source quality modifier. Not perfect but reduces false positives. |
| Source authority vs textual relevance conflict | Medium | Keep signals independent. Don't combine into one score. Let the caller weigh them. |
| Weight tuning required | High | Start with documented weights. Adjust in MVP-1Q.4 dogfood phase. No weight is final. |
| Content extraction quality affects relevance | Low | Already an accepted limitation of the extraction pipeline. |

## Staged implementation

### MVP-1Q.1 — Candidate relevance metadata

- Create `search_tool/relevance.py` with `tokenize_query()`, `score_candidate_relevance()`
- Integrate into `write_discovery_diagnostics()` — add `candidate_relevance` to selected_candidates
- Tests: tokenization, candidate scoring, diagnostics output
- No behavior changes to discovery or fetch

### MVP-1Q.2 — Evidence relevance metadata

- Add `score_evidence_relevance()` to `search_tool/relevance.py`
- Integrate into `search_query()` — compute after evidence is written
- Add `evidence_relevance` to `SearchRunResult`
- Add to search-run manifest YAML
- Add to CLI JSON output
- Tests: evidence scoring, manifest output, result structure
- No behavior changes to fetch or extraction

### MVP-1Q.3 — Compact summary visibility

- Add relevance column to compact summary
- Add relevance section with score components
- Tests: compact output format
- No ordering changes

### MVP-1Q.4 — Dogfood + threshold exploration

- Run real queries through the scoring pipeline
- Record scores alongside manual usefulness assessment
- Document weight tuning recommendations
- Identify threshold candidates for future filtering
- No behavior changes

### Later (explicitly post-MVP-1Q)

- Relevance-based source ordering
- Relevance-based filtering
- Relevance-aware discovery strategies
- Weight tuning based on dogfood findings
- Any behavior that changes what sources are fetched or how they are presented

## Score interpretation guide

For callers (Claude Code agents, humans) consuming relevance scores:

| Score range | Interpretation |
|-------------|---------------|
| 0.0 | No textual overlap detected. Source may still be useful if query terms are synonyms or related concepts not captured by keyword matching. |
| 0.1 – 0.3 | Minimal overlap. Some query terms appear but content is likely tangential. |
| 0.3 – 0.6 | Moderate overlap. Several query terms appear. Content may be partially relevant. |
| 0.6 – 0.8 | Strong overlap. Most query terms appear in the source. Content likely addresses the query topic. |
| 0.8 – 1.0 | Very strong overlap. Nearly all query terms appear, possibly with exact phrase matches. Content is textually closely related to the query. |

**Critical caveat:** A high relevance score does NOT mean the source answers the query. It means the source contains the query's words. Conversely, a low score does NOT mean the source is useless — it may address the topic using different vocabulary.
