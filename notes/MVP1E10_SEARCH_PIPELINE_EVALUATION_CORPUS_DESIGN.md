# MVP-1E.10 Search Pipeline Evaluation Corpus Design

## Baseline

`358301ebadad18f02f52bc1abcff788f68512445` — docs: evaluate search-run manifest

## Purpose

Design a systematic way to evaluate the end-to-end search pipeline (`query -> discovery -> fetch -> evidence -> manifest`) against expected outcomes using a representative corpus of scenarios.

## Current pipeline

The pipeline is now end-to-end:
1.  **Query:** User provides a raw search query.
2.  **Discovery:** A provider (Static or SearXNG) produces candidate URLs.
3.  **Selection:** Candidates are filtered (policy check, duplicate detection).
4.  **Fetch:** Selected URLs are fetched (caching, redirect following).
5.  **Evidence:** Evidence packs are written for each URL.
6.  **Manifests:** A `fetch-list` manifest and a `search-run` manifest are written.

## Design problem

How to verify that the search pipeline produces useful, safe, and auditable outputs across diverse scenarios without making CI flaky or dependent on a live SearXNG instance?

We need a way to:
- Assert on the structure and content of generated artifacts.
- Test edge cases (duplicates, blocked URLs, provider errors).
- Ensure privacy (redaction) is consistently applied.
- Support both deterministic CI testing and optional live verification.

## Evaluation goals

1.  **Correctness:** Discovery candidates are correctly selected, deduplicated, and fetched.
2.  **Safety:** Blocked URLs are never fetched; redaction is applied to manifests.
3.  **Audits:** Search-run manifests accurately reflect the discovery and fetch phases.
4.  **Resilience:** The pipeline handles provider errors and fetch failures gracefully.
5.  **CI Suitability:** Default evaluation must be fast, network-free, and deterministic.
6.  **Realism:** Optional live evaluation should verify compatibility with real SearXNG instances.

## Candidate corpus strategies

| Strategy | Description | Realism | Determinism | CI Safe | Maintenance |
|---|---|---|---|---|---|
| **A. Mocked deterministic** | Only use mocked providers and fetchers. | Low | High | Yes | Low |
| **B. Live SearXNG only** | Always require a live SearXNG instance. | High | Low | No | High |
| **C. Hybrid (Recommended)** | Deterministic default + optional live profile. | Medium | High/Low | Yes | Medium |
| **D. Golden snapshots** | Compare full artifact files against "golden" versions. | High | High | Yes | Very High |

### Strategy C Evaluation (Recommended)
- **Pros:** CI is safe and deterministic by default. Live verification is available for manual smoke tests or specialized environments. No external dependencies for core tests.
- **Cons:** Requires maintaining two modes of evaluation.
- **Decision:** Recommended. It balances CI stability with real-world verification.

## Recommended strategy

**Strategy C: Hybrid Evaluation Corpus.**

1.  **Deterministic Corpus:** The primary evaluation path. Uses a JSON-based corpus of scenarios with pre-defined discovery candidates and mocked HTTP responses.
2.  **Optional Live Profile:** A secondary path enabled via environment variables (e.g., `KRN_SEARCH_RUN_LIVE=1`). It runs real searches against a configured `SEARXNG_URL` and asserts on structural outcomes rather than exact content.

## Corpus file format proposal

The corpus will use JSON (to avoid new YAML dependencies).

**Path:** `tests/fixtures/search_corpus/basic.json`

```json
{
  "schema_version": "0.1",
  "scenarios": [
    {
      "id": "safe_single_result",
      "description": "Standard happy path with one safe result",
      "query": "python async docs",
      "provider": "static",
      "candidates": [
        {
          "url": "https://docs.python.org/3/library/asyncio.html",
          "title": "asyncio",
          "snippet": "Python asyncio documentation"
        }
      ],
      "mock_responses": {
        "https://docs.python.org/3/library/asyncio.html": {
          "status_code": 200,
          "content_type": "text/html",
          "body": "<html><title>asyncio</title><body>...</body></html>"
        }
      },
      "expect": {
        "discovery": {
          "total": 1,
          "selected": 1,
          "blocked": 0,
          "duplicates": 0
        },
        "fetch": {
          "succeeded": 1,
          "evidence_packs": 1
        },
        "manifests": {
          "search_run": true,
          "fetch_list": true
        },
        "assertions": [
          {"type": "contains", "field": "query_redacted", "value": "python async docs"},
          {"type": "exists", "field": "search_manifest_path"}
        ]
      }
    }
  ]
}
```

## Scenario taxonomy

1.  **safe_single:** Happy path, one result.
2.  **duplicate_results:** Two discovery candidates resolving to same normalized URL.
3.  **blocked_candidate:** Discovery returns a `file://` or private IP URL.
4.  **mixed_candidates:** Safe + blocked + duplicate in one discovery result.
5.  **provider_error:** Discovery provider returns a 500 or timeout.
6.  **zero_candidates:** Discovery returns an empty list.
7.  **fetch_failure:** Discovery succeeds, but HTTP fetch fails (e.g., 404).
8.  **fetch_blocked_redirect:** Follow-redirects hits a blocked target.
9.  **extraction_truncated:** Content exceeds character limit.
10. **query_redaction_check:** Query contains a secret (e.g., `sk-...`) that must be redacted in manifest.
11. **provider_redaction_check:** SearXNG URL contains credentials that must be redacted in manifest.

## Expected output model

The evaluation runner will produce a report (likely JSON or TSV) for each scenario:

```json
{
  "scenario_id": "safe_single_result",
  "status": "PASS",
  "checks": {
    "discovery_counts": "PASS",
    "fetch_counts": "PASS",
    "manifest_written": "PASS",
    "privacy_redaction": "PASS"
  },
  "artifacts": {
    "search_manifest": "tmp/evidence/search-....md",
    "fetch_manifest": "tmp/evidence/manifest-....md",
    "evidence_packs": ["tmp/evidence/docs-....md"]
  }
}
```

## Scoring model

Evaluation is strictly **Pass/Fail** based on structural and metadata assertions.

- **No LLM scoring.**
- **No relevance ranking.**
- **No content quality assessment** beyond the existing 0-3 fetch/extraction quality score.

## Deterministic vs live evaluation

### Deterministic (CI)
- Uses `static` provider and mocked HTTP.
- Zero network I/O.
- Assertions on exact counts and specific fields.
- Fast and reliable.

### Live (Manual/Optional)
- Uses `searxng` provider and real network.
- Requires `SEARXNG_URL`.
- Assertions on structure only (e.g., "did we get ANY evidence packs?", "is the manifest valid?").
- Used for integration smoke testing.

## Privacy / safety model

- The corpus fixtures themselves must not contain real secrets.
- Redaction logic is tested by including "fake" secrets in corpus queries and asserting their absence in the output manifests.
- Evaluated artifacts are written to temporary directories and never committed.

## CI policy

- Deterministic corpus evaluation runs in standard PR/CI checks.
- Live evaluation is **skipped** in CI.
- No new external service dependencies for CI.

## Test plan for implementation

1.  **Fixture load tests:** Verify corpus JSON files are valid and parsed correctly.
2.  **Mocking engine tests:** Verify the runner correctly intercepts discovery and fetch calls based on corpus definitions.
3.  **Assertion engine tests:** Verify that "expect" blocks in the corpus correctly trigger pass/fail outcomes.
4.  **CLI integration tests:** Verify a future `krn-search eval-corpus` command (or similar) correctly executes the corpus.

## Non-goals

- No browser automation.
- No synthesis or LLM-based evaluation.
- No automated "fixing" of failures.
- No permanent storage of evaluation results in the repo (except the corpus definitions).

## Decision

Adopt **Strategy C (Hybrid Corpus)**. Use JSON-based scenario definitions for deterministic CI testing, with the ability to run structural checks against live instances when manually enabled.

## Next recommended task

MVP-1E.11 — Implement the deterministic evaluation corpus runner and the first set of scenarios.
