# MVP-1Q.4 — Relevance Dogfood/Calibration

**Status:** Complete. Evaluation only, no code changes needed.

## Summary

6 dogfood scenarios run through the full relevance scoring pipeline. Candidate relevance, evidence relevance, and compact visibility recorded for each. Manual usefulness assessment compared against scores to identify false-high and false-low cases.

## Test matrix

| # | Query | Type | Sources |
|---|-------|------|---------|
| 1 | `python asyncio tutorial` | English technical | Python official docs, RealPython tutorial |
| 2 | `best python web framework` | SEO-prone | RealPython listing, Django official docs |
| 3 | `anthropic claude API getting started` | Specific API docs | Anthropic docs (SPA), Anthropic blog |
| 4 | `rust ownership memory management` | Mismatch | Python docs (irrelevant), Rust docs (relevant) |
| 5 | `instalacja python linux` | Polish content | Python PL docs, RealPython install guide |
| 6 | `HTTP client python requests library` | Exact match | Requests docs, urllib docs |

Provider: static with `--candidate-url`, `--candidate-title`, `--candidate-snippet`. Flags: `--json --compact --follow-redirects`.

## Results

### Scenario 1: `python asyncio tutorial`

| Source | Candidate | Evidence | Compact | Manual |
|--------|-----------|----------|---------|--------|
| docs.python.org/3/library/asyncio.html | 28% | 47% | 47% | HIGH — official asyncio reference |
| realpython.com/async-io-python | 43% | 57% | 57% | MEDIUM-HIGH — tutorial walkthrough |

**Findings:** Official docs undersold relative to blog content. Root cause: official title "asyncio — Asynchronous I/O" lacks "tutorial" and "python". Snippet mentions "coroutines" not "tutorial". RealPython has "tutorial" and "async" in snippet, plus full text overlap. **False-low for official docs.**

### Scenario 2: `best python web framework`

| Source | Candidate | Evidence | Compact | Manual |
|--------|-----------|----------|---------|--------|
| realpython.com/best-python-web-frameworks/ | 55% | N/A (404) | 0% | Would be SEO listing |
| docs.djangoproject.com/ | 49% | 31% | 31% | MEDIUM — Django landing page |

**Findings:** SEO listing penalized from ~70% to 55% via generic_page_penalty (-0.15). Penalty works but may be insufficient — listing still outscores Django official docs at candidate stage. Django evidence relevance is genuinely low (31%) because the landing page is a docs index, not framework content. **Generic penalty working but weak for exact-phrase listings.**

### Scenario 3: `anthropic claude API getting started`

| Source | Candidate | Evidence | Compact | Manual |
|--------|-----------|----------|---------|--------|
| docs.anthropic.com/.../getting-started-with-claude | 63% | 0% | 0% | Would be HIGH — SPA rendered empty |
| www.anthropic.com/blog | 23% | 32% | 32% | LOW — news/blog, not API docs |

**Findings:** SPA correctly scored 0% evidence relevance ("Loading..." content triggers low_content_penalty). Candidate score (63%) appropriately high — title/snippet/URL all match. Blog correctly low (23% candidate, 32% evidence). **SPA limitation correctly surfaced. No scoring bug.**

### Scenario 4: `rust ownership memory management`

| Source | Candidate | Evidence | Compact | Manual |
|--------|-----------|----------|---------|--------|
| docs.python.org/3/tutorial/ | 10% | 10% | 10% | VERY LOW — wrong topic entirely |
| doc.rust-lang.org/.../understanding-ownership | 43% | 51% | 51% | HIGH — directly about Rust ownership |

**Findings:** Correct discrimination. Python docs scored 10% (base 0.0 + official modifier 0.1). Rust docs scored 51%. **Minor false-high: irrelevant official docs get +0.1 modifier even at 0% base score.** The 10% score is still very low, so practical impact is limited.

### Scenario 5: `instalacja python linux`

| Source | Candidate | Evidence | Compact | Manual |
|--------|-----------|----------|---------|--------|
| docs.python.org/pl/3/using/unix.html | 40% | 65% | 65% | HIGH — Polish Python docs, Unix/Linux section |
| realpython.com/installing-python | 27% | 47% | 47% | MEDIUM — English installation guide |

**Findings:** Correct ordering. Polish docs score higher (65% vs 47%) because extracted content contains "instalacja", "python", "linux". Candidate score moderate (40%) because English title "Using Python on Unix" lacks "instalacja" — only snippet has Polish term. **Polish content scores correctly. Diacritics preserved.**

### Scenario 6: `HTTP client python requests library`

| Source | Candidate | Evidence | Compact | Manual |
|--------|-----------|----------|---------|--------|
| docs.python-requests.org/en/latest/ | 46% | 60% | 60% | HIGH — official requests docs |
| docs.python.org/3/library/urllib.request.html | 21% | 66% | 66% | MEDIUM — urllib, not requests library |

**Findings:** urllib outscores requests docs on evidence relevance (66% vs 60%). Root cause: both candidate and evidence relevance use `_token_overlap()` with `_text_tokens()` whole-token membership — there is no substring matching issue. Whole-token matching correctly treats `requests` and `request` as different tokens. The problem is **weak package/entity weighting**: the query contains the package name `requests`, but the score can still be dominated by other overlapping generic tokens (`HTTP`, `client`, `python`, `library`). The current scoring does not give special weight to exact package/entity names, so urllib documentation — which is rich in those generic tokens — outscores the actual `requests` package docs. **Most significant false-high.**

## Calibration issues

### False-low cases

| Issue | Scenario | Impact | Severity |
|-------|----------|--------|----------|
| Official docs undersold vs blog/tutorial | 1 (asyncio) | Most authoritative source scores below blog | Medium |

The scoring measures textual overlap, not authority. This is by design — source quality and relevance are independent signals. The caller should weigh both. Not a scoring bug, but the interpretation guide should note this interaction.

### False-high cases

| Issue | Scenario | Impact | Severity |
|-------|----------|--------|----------|
| urllib scores above requests for "requests library" | 6 | Wrong library ranked higher | Medium |
| Irrelevant official docs get +0.1 at 0% base | 4 | 10% score for completely irrelevant source | Low |
| SEO listing outscores official docs at candidate stage | 2 | Listing penalty may be too weak | Low-Medium |

### Score range compression

Evidence relevance scores for genuinely useful content cluster in **30-65%** range. The interpretation guide's "strong overlap" (0.6-0.8) and "very strong overlap" (0.8-1.0) bands are rarely achievable with current weights because:

- `heading_match` is often 0.0 (headings use different vocabulary from queries)
- `exact_phrase_in_text` rarely triggers for multi-word queries
- `text_overlap` caps at 1.0 when all important tokens are found, but the weighted formula (0.30*1.0 + 0.15*0 + 0.25*0.8 + 0.10*1.0 + 0.20*0 = 0.65) produces a ceiling

## Calibration recommendations

### 1. Official modifier floor (Low priority)

Consider: only apply `source_quality_modifier` +0.1 when `base_score > 0.05`. Prevents irrelevant official docs from getting a free boost. Current impact is minimal (10% is still very low), so this is a tuning refinement, not a blocker.

### 2. Score interpretation guide update (Recommended)

Update the interpretation guide bands to match observed score ranges:

| Current band | Observed range | Suggested revision |
|-------------|----------------|--------------------|
| 0.0 | No overlap | Keep as-is |
| 0.1-0.3 | Minimal | 0.1-0.25: Minimal |
| 0.3-0.6 | Moderate | 0.25-0.50: Moderate |
| 0.6-0.8 | Strong | 0.50-0.65: Strong |
| 0.8-1.0 | Very strong | 0.65+: Very strong |

### 3. Package/entity-name disambiguation (Medium priority)

Both candidate and evidence relevance use `_token_overlap()` with `_text_tokens()` whole-token membership — the same matching strategy at both stages. There is no substring matching. Whole-token matching correctly prevents `requests` from matching `request`. The issue is that the scoring lacks **package/entity awareness**: the package token `requests` is not given special importance, so other overlapping generic tokens (`HTTP`, `client`, `python`, `library`) can dominate the score even when the package name is the most discriminative query term. A future improvement could add entity-weight boosting for known package names, but this requires a known-entities dictionary or heuristics beyond current scope.

### 4. Generic page penalty strength (Low-Medium priority)

Current penalty (-0.15) may be insufficient for listings with exact phrase matches in titles. The penalty is not cumulative (largest applies). Consider increasing to -0.20 or applying an additional exact-phrase-in-listing penalty.

### 5. Heading match investigation (Informational)

`heading_match` was 0.0 in 5 of 6 scenarios. Headings in extracted evidence often use structural vocabulary ("Installation", "Tutorial", "Getting Started") that doesn't overlap with query terms. The 0.15 weight is effectively wasted in most cases. Consider reducing heading weight and redistributing to `early_content_overlap` or `text_overlap`.

## Correct behaviors confirmed

1. **SEO listing penalty**: Generic page penalty applied correctly (scenario 2)
2. **Complete mismatch**: Python docs for Rust query = 10%, Rust docs = 51% (scenario 4)
3. **Polish content**: Diacritics preserved, Polish query matches Polish content (scenario 5)
4. **SPA/empty content**: Correctly scores 0% with low_content_penalty (scenario 3)
5. **Deterministic**: Same inputs produce same scores across runs
6. **Compact visibility**: Relevance column displays correctly in all scenarios
7. **Score independence**: Relevance and quality signals don't interfere

## Non-findings (things that work as expected)

- Evidence packs don't contain relevance scores (correct — scores are query-run metadata)
- Failed fetch gets 0% evidence relevance (correct)
- Compact summary ordering is by authority/quality, not relevance (correct — no reranking)
- Redirect following resolves final URLs for evidence relevance lookup

## Review packet

- **Task:** MVP-1Q.4 relevance dogfood/calibration
- **Scope:** Evaluation only, no code changes
- **Scenarios:** 6 real queries, 12 source evaluations
- **Issues found:** 5 calibration observations (2 medium, 2 low-medium, 1 low priority)
- **Blockers found:** None
- **Code changes:** None
- **Test results:** 993/993 (unchanged), 11/11 eval-corpus (unchanged)
- **Remaining concerns:** Package/entity-name disambiguation (recommendation 3) is the most impactful potential improvement

## Next

- Document findings in DECISION_CANDIDATES.md for weight tuning recommendations
- MVP-1Q.4 is complete — no code changes warranted
- Weight tuning (if pursued) would be a separate task
