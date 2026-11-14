# MVP-1M.2a — Canonical Candidate Dedup Dogfood

**Date:** 2026-05-18
**Baseline:** 41a48c1722a7cdfd45758045f9855274b3c7286f (feat: add canonical candidate dedup)
**Status:** ACCEPT_CANONICAL_DEDUP

## Baseline Gate

- 845/845 tests pass (45 canonical + 800 existing)
- 11/11 eval-corpus pass
- Compile: OK
- Whitespace: OK
- Working tree clean

## Static Synthetic Dogfood

10 cases via `static_provider()` with direct `RawDiscoveryCandidate` inputs.

| # | Case | Input URLs | Expected | Got | Limitation | Verdict |
|---|------|-----------|----------|-----|-----------|---------|
| A | Tracking params collapse | `?utm_source=x`, `?utm_campaign=y`, bare | 1 | 1 | `Collapsed 2` | PASS |
| B | Meaningful params preserved | `?ref=a`, `?ref=b`, `?source=x` | 3 | 3 | none | PASS |
| C | Fragment/trailing slash collapse | `#intro`, `/`, bare | 1 | 1 | `Collapsed 2` | PASS |
| D | Path case preserved | `/Docs/Page`, `/docs/page` | 2 | 2 | none | PASS |
| E | Tracking+meaningful same value | `?utm_source=foo&ref=a`, `?ref=a` | 1 | 1 | `Collapsed 1` | PASS |
| F | Tracking+meaningful diff value | `?utm_source=foo&ref=a`, `?ref=b` | 2 | 2 | none | PASS |
| G | Default port (443) | `:443`, bare | 1 | 1 | `Collapsed 1` | PASS |
| H | Non-default port (8443) | `:8443`, bare | 2 | 2 | none | PASS |
| I | Duplicate slashes | `//docs///page`, `/docs/page` | 1 | 1 | `Collapsed 1` | PASS |
| J | ref vs source vs via distinct | `?ref=a`, `?source=b`, `?via=c` | 3 | 3 | none | PASS |

**Limitations message format:** `"Collapsed N duplicate candidate URLs by canonical dedup."` — clear, accurate, concise.

## LLMS Real Dogfood

### Claude Code (hooks skills commands)

- **LLMS URL:** `https://code.claude.com/docs/llms.txt`
- **Candidates discovered:** 10
- **Selected for fetch:** 10
- **Collapsed duplicates:** 0
- **Evidence sources:** 10 successful
- **Quality:** All `official_docs` (authority 3)
- **Evidence content:** Real markdown (72KB commands.md), not nav chrome
- **Domains:** code.claude.com

### Pydantic (validation models)

- **LLMS URL:** `https://docs.pydantic.dev/latest/llms.txt`
- **Candidates discovered:** 10
- **Selected for fetch:** 10
- **Collapsed duplicates:** 0
- **Evidence sources:** 10 successful
- **Quality:** All `official_docs` (authority 3)
- **Evidence content:** Real markdown (64KB models.md), not nav chrome
- **Domains:** pydantic.dev

### Comparison to MVP-1L.4

L.4 benchmarks (2/4 real-world sources produced useful evidence). These two cases are consistent with L.4: both produce high-quality official_docs evidence with substantial content. No canonical dedup collapsed any useful distinct URLs — both source files are well-organized with unique URLs (no duplicates to collapse).

## Collapse/Preserve Summary

**Collapsed correctly (tracking params):** utm_*, fbclid, gclid, msclkid, mc_cid, mc_eid, igshid removed. Duplicates merge to first occurrence.

**Preserved correctly (meaningful params):** ref, source, via kept with all values distinct.

**Preserved correctly (path case):** `/Docs/Page` vs `/docs/page` remain separate.

**Preserved correctly (non-default ports):** `:8443` kept, `:443` removed.

## Frictions

None observed. The dedup is transparent — users see fewer candidates when tracking params are present, with an honest limitation message. When no duplicates exist (well-organized docs like Claude Code and Pydantic), the output is unchanged.

## Acceptance Verdict

**ACCEPT_CANONICAL_DEDUP**

All 10 static cases pass. Both LLMS real-world cases produce useful evidence with no false collapses. The canonical dedup improves noise reduction without losing distinct results.

## Fixes Made

None. Implementation verified correct.

## Next Recommended Task

**MVP-1M.3** — Fetch-aware redirect/final_url dedup. After `search_query()` fetches evidence, check if `final_url` canonical key matches an earlier evidence result. This would catch redirect-equivalent URLs (e.g., `/latest/` -> `/`) that canonical dedup at discovery time cannot detect.
