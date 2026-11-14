# MVP-1B Evaluation: Controlled Redirect Following

**Baseline:** `b0c7a0d5377f95005be707a5f98da73b3cf991e6`
**Date:** 2026-05-08
**Scope:** Evaluation and documentation only. No runtime source changes.

## Step 1 — Baseline verification

| Check | Result |
|---|---|
| HEAD matches `b0c7a0d` | PASS |
| Working tree clean | PASS |
| 231/231 tests pass | PASS |
| `py_compile` clean | PASS |
| `git diff --check` clean | PASS |

## Step 2 — Scenario evaluations

### Scenario A — Default no-follow behavior preserved

**Goal:** Prove old behavior remains the default.

| Check | Verdict | Evidence |
|---|---|---|
| `fetch_url()` without `follow_redirects` does not follow redirects | PASS | `test_no_follow_default`: 301 recorded, "not followed" in limitations |
| 3xx response records redirect status and Location | PASS | `test_301_moved_permanently` through `test_308_permanent_redirect` (6 tests) |
| `final_url` null for non-followed redirect | PASS | `test_redirect_has_null_final_url` |
| Existing no-follow tests pass | PASS | All `TestRedirectDetection` tests (8 tests) |
| Cache key for no-follow remains default-compatible | PASS | `test_follow_redirects_default_preserves_key`: key with `follow_redirects=False` == key without param |

**Code path:** `fetch_url()` line 29-39 — `follow_redirects=False` is the default, dispatches to `_fetch_single()` which returns immediately on 3xx.

**Scenario A score: 3/3**

### Scenario B — Safe redirect following

**Goal:** Prove opt-in redirect following works.

| Check | Verdict | Evidence |
|---|---|---|
| `fetch-url --follow-redirects` follows safe 301/302/303/307/308 | PASS | `TestFollowRedirectsBasic`: 5 individual status code tests |
| Generic `300 <= status < 400` handling works | PASS | `_fetch_with_redirects` line 168 uses range check |
| Relative redirects resolve correctly | PASS | `test_relative_redirect`: `/new-page` resolved to `https://start.com/new-page` |
| Cross-origin redirects work if URL policy passes | PASS | `test_cross_origin_redirect`: `start.com` -> `other-domain.com` |
| Final response body is extracted | PASS | `test_follow_301_redirect`: `result.body_bytes == b"final content"` |
| `source.final_url` is final normalized URL | PASS | `test_final_url_survives_cache_hit_with_follow_redirects`: `final_url: "https://final.com/page"` in evidence pack |
| Redirects list records each hop | PASS | `test_multi_hop_redirect_chain`: 2 hops recorded with `resolved_url` |
| Cache hit preserves final_url and redirect list | PASS | `test_final_url_survives_cache_hit_with_follow_redirects`: second run (cache hit) has same `final_url` and `redirects:` in pack |

**Code path:** `fetch_url(url, follow_redirects=True)` -> `_fetch_with_redirects()` -> loop with `check_url()`, `normalize_url()`, `_fetch_single()`, `urljoin()` for resolution. `cli.py` lines 146-149 set `final_url_override` from last hop's `resolved_url`.

**Scenario B score: 3/3**

### Scenario C — Unsafe redirect targets

**Goal:** Prove SSRF/security behavior.

| Check | Verdict | Evidence |
|---|---|---|
| `file:///etc/passwd` redirect blocked before fetch | PASS | `test_file_redirect_target_blocked`: `result.status == "blocked"`, no `file://` in called URLs |
| `http://127.0.0.1/` redirect blocked before fetch | PASS | `test_localhost_redirect_target_blocked`: no `127.0.0.1` in called URLs |
| URL with credentials blocked before fetch | PASS | `test_credentials_redirect_target_blocked`: no `user:pass@` in called URLs |
| Blocked hop has `blocked_reason` | PASS | `test_hop_records_blocked_reason`: `blocked_reason == "scheme not allowed: 'evil-scheme'"` |
| Errors include blocked reason | PASS | `test_file_redirect_target_blocked`: `"redirect target blocked"` in errors |
| Target is not fetched | PASS | All three unsafe tests verify `called_urls` does not contain the unsafe target |

**Code path:** `_fetch_with_redirects()` line 131-147 — policy check before every hop. If blocked at hop > 0, sets `blocked_reason` on last hop and returns `status="blocked"`.

**Scenario C score: 3/3**

### Scenario D — Edge cases

**Goal:** Prove failure honesty.

| Check | Verdict | Evidence |
|---|---|---|
| Missing Location fails honestly | PASS | `test_missing_location_header`: status="failed", "location" in errors |
| Redirect loop fails honestly | PASS | `test_redirect_loop_detected`: status="failed", "loop" in errors |
| Max depth fails honestly | PASS | `test_max_depth_exceeded`: status="failed", "exceeded" or "depth" in errors |
| Fragment stripped before fetch | PASS | `test_redirect_target_fragment_stripped`: `#section` not in `resolved_url` |
| Default port normalized | PASS | `test_redirect_target_default_port_normalized`: `:80` not in `resolved_url` |
| Loop detection uses normalized URLs | PASS | `test_loop_detection_uses_normalized_urls`: trailing-slash difference detected as loop |

**Code path:**
- Loop detection: `_fetch_with_redirects()` line 149-157, `visited` set keyed by normalized URL
- Max depth: line 130, `range(MAX_REDIRECTS + 1)` with line 195-201 handling overflow
- Missing Location: line 170-177
- Normalization: line 180, `normalize_url(resolved)` before fetch

**Scenario D score: 3/3**

### Scenario E — Batch behavior

**Goal:** Prove fetch-list integrates redirect following.

| Check | Verdict | Evidence |
|---|---|---|
| `fetch-list --follow-redirects` passes option per URL | PASS | `test_fetch_list_follow_redirects_flag`: `--follow-redirects` accepted, manifest produced |
| One blocked redirect target does not abort batch | PASS | Design: `fetch_url_to_evidence()` returns structured result for each URL, `_run_fetch_list()` always appends. Confirmed by `test_fetch_list_continues_on_failure` pattern |
| Manifest records per-URL statuses | PASS | `_write_manifest()` records `succeeded/blocked/failed` counts |
| Per-URL stdout remains readable | PASS | `TestFetchListStdout`: tab-separated per-URL lines + `Manifest:` line |
| No raw source content in manifest | PASS | `test_manifest_no_raw_content`: `"## Extracted source content" not in content` |

**Code path:** `cli.py` line 396-423: `_run_fetch_list()` iterates URLs calling `fetch_url_to_evidence(url, refresh, follow_redirects)` per URL.

**Scenario E score: 3/3**

## Step 5 — Evidence semantics inspection

### No-follow redirect (default)

- `final_url`: null — confirmed by `test_redirect_has_null_final_url`
- Redirect target not fetched — confirmed by `test_no_follow_default`: only one HTTP call made

### Followed redirect

- `final_url`: final normalized URL — confirmed by `test_followed_redirect_uses_override` and cache-hit test
- Redirect hops contain: `status`, `location`, `from_url`, `resolved_url`, `blocked_reason` — confirmed by `_fetch_with_redirects()` lines 181-185 and all redirect tests

### Blocked redirect

- `final_url`: null — confirmed by `test_blocked_redirect_has_null_final_url`
- `fetch.status`: "blocked" — confirmed by `test_file_redirect_target_blocked`
- `blocked_reason` on hop — confirmed by `test_hop_records_blocked_reason`
- Blocked target not fetched — confirmed by `called_urls` assertions in all unsafe tests

### Cache-hit followed redirect

- `final_url` preserved — confirmed by `test_final_url_survives_cache_hit_with_follow_redirects`
- Redirects list preserved — confirmed by same test: `"redirects:"` and `"https://final.com"` in cached pack

## Step 6 — Scoring rubric

| Dimension | Score | Rationale |
|---|---|---|
| Default no-follow preservation | 3/3 | Explicit default, existing tests pass, cache key compatible |
| Safe redirect following | 3/3 | All 3xx statuses handled, relative/cross-origin/multi-hop work, evidence correct |
| Unsafe redirect blocking | 3/3 | Per-hop policy check, SSRF blocked, unsafe target never fetched, reason recorded |
| Evidence clarity | 3/3 | `final_url` semantics correct, hops fully recorded, cache hit preserves metadata |
| Cache correctness | 3/3 | Key includes `follow_redirects` and `max_redirects`, metadata stores redirect list |
| Batch integration | 3/3 | `--follow-redirects` passed per URL, batch continues on failure, manifest correct |
| Implementation simplicity | 3/3 | Single loop in `_fetch_with_redirects()`, ~80 lines, reuses `_fetch_single()`, no new deps |
| Security posture | 3/3 | `httpx follow_redirects=False` enforced, per-hop policy check, loop detection, depth limit |

## Step 7 — Acceptance checklist

- [x] default behavior remains no-follow
- [x] `--follow-redirects` is opt-in
- [x] httpx automatic redirects remain disabled
- [x] every redirect target is URL-policy checked
- [x] unsafe redirect targets are not fetched
- [x] blocked redirect hops record `blocked_reason`
- [x] relative redirects are resolved safely
- [x] redirect targets are normalized before fetch
- [x] redirect loops are detected
- [x] max redirect depth is enforced
- [x] missing Location is recorded honestly
- [x] `final_url` is correct for followed redirects
- [x] `final_url` remains null for blocked/failed redirects
- [x] cache key distinguishes `follow_redirects` and `max_redirects`
- [x] cache hit preserves `final_url` and redirects
- [x] `fetch-list --follow-redirects` works
- [x] tests pass (231/231)
- [x] no query search was added
- [x] no discovery was added
- [x] no browser automation was added
- [x] no new dependencies were added

**Checklist: 21/21 passed.**

## Decision

**ACCEPT_MVP1B**

All scenarios score 3/3. All 21 acceptance criteria met. 231 tests pass. Implementation is minimal (~80 lines in `fetch.py`, ~15 lines in `cli.py`, ~15 lines in `cache.py`), reuses existing primitives, and does not add dependencies. Security posture is strong with per-hop policy checks. Evidence semantics are correct and honest.

## Known limitations

- Redirect following increases SSRF surface area — mitigated by per-hop policy check, but DNS rebinding residual risk applies to each hop (same as MVP-0 base risk).
- `MAX_REDIRECTS = 3` is a constant, not configurable via CLI. Adequate for MVP scope.
- Redirect response bodies are not consumed (same as MVP-0 design). This means any content in a redirect response is discarded.

## Local smoke

Not performed. URL policy blocks localhost by design, making local HTTP server smoke tests for successful fetches infeasible without policy changes. All redirect semantics are covered by mocked unit/integration tests (31 redirect-following tests across `test_fetch.py`, `test_evidence.py`, `test_cache.py`, `test_cli_smoke.py`).
