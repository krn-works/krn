# MVP-1C Direction Memo: Dependency Documentation Verification

**Baseline:** `529a55f41d0f453eea0926ee5b01af9fb13ae81a`
**Date:** 2026-05-08
**Scope:** Decision and documentation only. No runtime source changes.

## Context

MVP-0, MVP-1A (fetch-list manifest), and MVP-1B (redirect following) are all accepted. 231 tests pass. The ingestion primitive is stable: `fetch-url` with cache/redirect support, `fetch-list` with manifest generation, correct evidence pack semantics, and strong security posture.

The project has 10 UNVERIFIED dependency entries in README.md (httpx, beautifulsoup4, pytest, and 7 Python stdlib items). The project's documentation verification policy requires these to be resolved.

## Options evaluated

### Option 1: Manifest helper extraction/refactor

Move ~170 lines of manifest logic (`_write_manifest`, `_quality_score`, `_md_table_safe`, `_parse_urls_file`, `InputError`) from `cli.py` into `search_tool/manifest.py`.

| Criterion | Assessment |
|---|---|
| Product value | Low — no user-facing feature change |
| Security risk | None |
| Complexity | Low — move ~170 lines |
| Impact on future `/search` | Neutral — same API, different file |
| Reduces uncertainty | No |
| Helps `krn-ai-os` | No — no behavioral change |
| Framework risk | Mild — premature abstraction for a spike |
| Test burden | Import changes only |
| Before query search? | No — doesn't block or enable anything |

`cli.py` at 428 lines is not yet painful. The manifest logic is substantial but cohesive. Moving it now would be aesthetic preference, not maintainability necessity. The project is explicitly a disposable spike.

### Option 2: Dependency documentation verification

Verify the 10 UNVERIFIED dependency behavior entries in README.md against current upstream documentation. Resolve each to VERIFIED, DOCUMENTED_DISCREPANCY, or BLOCKED_UNVERIFIED.

| Criterion | Assessment |
|---|---|
| Product value | Low — no user-facing feature |
| Security risk | None (reduces risk by confirming assumptions) |
| Complexity | Low — read docs, update README table |
| Impact on future `/search` | Medium — confirms fetch layer behaves as documented |
| Reduces uncertainty | Yes — up to 10 UNVERIFIED entries resolved |
| Helps `krn-ai-os` | Yes — krn-ai-os needs to trust the ingestion layer's documented behavior |
| Framework risk | None |
| Test burden | No new tests expected. Existing full test suite must still pass. |
| Before query search? | Yes — unverified dependency behavior is a hidden coupling risk |

This is the only option that reduces uncertainty. The current README documents `httpx(trust_env=False)`, `follow_redirects=False`, timeout behavior, BeautifulSoup `html.parser`, and standard library IP/DNS behavior — all marked UNVERIFIED. Before adding a discovery layer on top, the foundation should be verified.

### Option 3: Query discovery design (not implementation)

Design future search/discovery layer. No implementation.

| Criterion | Assessment |
|---|---|
| Product value | High — defines the path to `/search` |
| Security risk | High — discovery expands threat model significantly |
| Complexity | High — multi-system design with many open questions |
| Impact on future `/search` | Direct — this IS the `/search` design |
| Reduces uncertainty | Yes — but generates new uncertainties |
| Helps `krn-ai-os` | Yes — the primary output of this project |
| Framework risk | High — design docs can metastasize into framework specs |
| Test burden | None (design only) |
| Before query search? | Yes — by definition |

High value but premature. Depends on krn-ai-os architecture decisions. The ingestion primitives should be verified before designing a discovery layer on top.

## Decision

```
Decision: Dependency documentation verification
Rationale: The ingestion primitive is stable and accepted (MVP-0/1A/1B).
All 10 dependency behavior entries in README are marked UNVERIFIED.
Before adding a discovery design layer or further features, the foundation
should be verified. This is low-cost, low-risk, reduces uncertainty, and
produces the verified-trust artifact that krn-ai-os needs. The project's
documentation verification policy requires this work. The spike is
disposable — unverified docs are wasted signal.

Rejected alternatives:
- Option 1 (manifest refactor): cli.py at 428 lines is not painful.
  Coherent ~170-line manifest block doesn't warrant extraction in a spike.
  Pure housekeeping with no uncertainty reduction.
- Option 3 (query discovery design): High value but premature. The
  discovery layer has open dependencies on krn-ai-os architecture.
  Should come after ingestion docs are verified, so the design has a
  solid verified foundation to build on. Also risks framework-creep
  in a disposable spike.
```

## Scope for next task

- Verify or mark blocked:
  - **httpx**: `trust_env=False`, `follow_redirects=False`, timeout behavior, streaming behavior, redirect response handling
  - **beautifulsoup4**: parser behavior, removal/extraction assumptions, entity/text behavior
  - **Python stdlib**: `ipaddress`, `socket.getaddrinfo`, `urllib.parse.urljoin`, `hashlib`/`json`/`pathlib`/`tempfile` where relevant
  - **pytest** only if repo depends on non-obvious pytest behavior

### Docs access conditionality

Verification is conditional on current docs access:

- If Context7 / current docs / web access is available, verify dependencies against current upstream documentation.
- If no current docs access is available, do NOT claim verification. Produce a verification plan and mark the task INCONCLUSIVE / BLOCKED_ON_DOCS_ACCESS.
- Do not silently switch to query discovery because docs are unavailable. Query discovery remains a separate later decision.

### If a discrepancy is found

If verification reveals a discrepancy between documented behavior and actual usage:

1. Record the finding as DOCUMENTED_DISCREPANCY with details.
2. Add a decision candidate for the fix.
3. Stop. Do not implement the fix in this task.

If a discrepancy reveals a real code/test gap that could cause silent failures:

1. Record the finding.
2. Stop and report before implementing any fixes or new tests.

### Explicit non-goals

- No runtime code changes
- No dependency version constraint changes (record findings as decision candidates only)
- No new dependencies
- No query search
- No discovery
- No browser automation
- No refactor
- No new tests expected (unless a documented discrepancy reveals a real code/test gap — stop and report first)
- No pyproject.toml changes

## Acceptance criteria

- Each UNVERIFIED entry in README becomes one of:
  - **VERIFIED** with doc source, date, and version tested
  - **DOCUMENTED_DISCREPANCY** with details of the mismatch
  - **BLOCKED_UNVERIFIED** because docs access was unavailable
- No false claims of verification
- 231/231 tests still pass (confirmation only — no tests changed)
- README documentation verification status table updated
- PROJECT_STATE.md updated
- ACTIVE_TASK.md updated with verification findings
- EXPERIMENT_LOG.md updated
- DECISION_CANDIDATES.md updated if any new durable candidates emerge
- Docs-only commit
