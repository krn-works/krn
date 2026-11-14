# MVP-1C Dependency Documentation Verification

**Baseline:** `859c686d2514ed1c6f26e6a4cf028bcb265d43bc`
**Date:** 2026-05-08
**Docs access:** Available — upstream documentation fetched live from project websites and python.org

## Scope

The MVP-1C direction memo references "10 UNVERIFIED dependency entries" and scopes verification across httpx, beautifulsoup4, pytest, and Python stdlib. The actual README table contained **7 rows**. The remaining scope items (streaming behavior, redirect response handling, entity/text behavior, `urllib.parse.urljoin`, `hashlib`/`json`/`pathlib`/`tempfile`) are used in the codebase but had no README table row. These are assessed below and either verified or marked NOT_MATERIAL.

## Verification method

1. Confirmed installed versions via `pip show` and `python --version`.
2. Fetched upstream documentation live from project websites.
3. Cross-referenced documented behavior against actual usage in source files.

## Installed versions

| Package | Version |
|---|---|
| Python | 3.12.3 |
| httpx | 0.28.1 |
| beautifulsoup4 | 4.14.3 |
| pytest | 9.0.3 |

## README table entries (7 rows)

### 1. httpx `Client(trust_env=False)` — VERIFIED

**Behavior verified:** `trust_env=False` prevents reading proxy configuration from environment variables (`HTTP_PROXY`, `HTTPS_PROXY`, `ALL_PROXY`).

**Source:** https://www.python-httpx.org/api/#client — Client init parameters: `trust_env: bool = True` — "Enables or disables usage of environment variables for configuration."

**Access date:** 2026-05-08

**Installed version:** httpx 0.28.1

**Code usage:** `search_tool/fetch.py:49` — `httpx.Client(trust_env=False, follow_redirects=False, timeout=HTTP_TIMEOUT_SECONDS)`

**Finding:** Confirmed. Default is `True`; repo sets `False` explicitly. Prevents proxy env leakage in agent/CI environments.

**Impact:** Security. If `trust_env` defaulted to `True`, agent environments with proxy env vars would route fetches through unintended proxies.

**Action:** None. Correct as implemented.

---

### 2. httpx `follow_redirects=False` — VERIFIED

**Behavior verified:** httpx does not follow HTTP redirects by default. `follow_redirects=False` is the default parameter value.

**Source:**
- https://www.python-httpx.org/api/#client — `follow_redirects: bool = False`
- https://www.python-httpx.org/quickstart/#redirects — "By default, HTTPX will not follow redirects."

**Access date:** 2026-05-08

**Installed version:** httpx 0.28.1

**Code usage:** `search_tool/fetch.py:49` — `follow_redirects=False` in Client constructor.

**Finding:** Confirmed. The repo's explicit `follow_redirects=False` matches the default, making it defensive/documented rather than behavior-changing. The redirect-following path (`--follow-redirects` flag) uses `_fetch_with_redirects()` which manages its own client.

**Impact:** Security. Prevents automatic SSRF via redirect chains. Default is safe.

**Action:** None. Correct as implemented.

---

### 3. httpx timeout behavior — VERIFIED

**Behavior verified:** A float timeout value sets both connection and read timeout. The httpx default is 5.0 seconds. The repo overrides to 30.0 seconds.

**Source:** https://www.python-httpx.org/quickstart/#timeouts — "You can specify a timeout as a simple float... The default timeout is 5 seconds." Also confirms that `timeout=30.0` sets connection+read timeout (not pool nor connect-only).

**Access date:** 2026-05-08

**Installed version:** httpx 0.28.1

**Code usage:** `search_tool/fetch.py:18` — `HTTP_TIMEOUT_SECONDS = 30.0`, used in `httpx.Client(timeout=HTTP_TIMEOUT_SECONDS)`.

**Finding:** Confirmed. The repo uses a single float timeout, which httpx interprets as `Timeout(timeout=30.0)` — equivalent to `Timeout(connect=30.0, read=30.0, write=30.0, pool=30.0)`.

**Impact:** Reliability. 30s timeout accommodates slow documentation servers without excessive wait on genuinely unreachable hosts.

**Action:** None. Correct as implemented.

---

### 4. BeautifulSoup `html.parser` — VERIFIED

**Behavior verified:** `html.parser` is Python's built-in HTML parser (batteries included). It handles all APIs the repo uses: `find_all()`, `decompose()`, `get_text(separator=...)`.

**Source:** https://www.crummy.com/software/BeautifulSoup/bs4/doc/#installing-a-parser — Parser comparison table: `html.parser` — "Batteries included, Decent speed, Lenient (as of Python 3.2)." Lists `html.parser` as "Python's built-in HTML parser."

**Access date:** 2026-05-08

**Installed version:** beautifulsoup4 4.14.3

**Code usage:** `search_tool/extract.py:82` — `BeautifulSoup(raw, "html.parser")`. Uses `find_all()`, `decompose()`, `get_text(separator="\n")`.

**Finding:** Confirmed. `html.parser` is the correct choice for a lightweight spike: no external parser dependency (lxml, html5lib), decent speed, sufficient for the tag removal and text extraction patterns used.

**Impact:** Dependency simplicity. Avoids lxml/html5lib C-extension dependencies. Sufficient for traditional documentation HTML.

**Action:** None. Correct as implemented.

---

### 5. pytest — VERIFIED (standard usage)

**Behavior verified:** pytest is used as a standard test runner. No non-obvious pytest features, plugins, or configuration behavior are depended upon.

**Source:** N/A — standard usage. No specific upstream doc reference needed.

**Access date:** 2026-05-08

**Installed version:** pytest 9.0.3

**Code usage:** Standard `pytest tests/ -v`. No conftest.py fixtures, no custom markers, no plugin configuration.

**Finding:** No non-obvious pytest behavior to verify. The direction memo scoped pytest as "only if repo depends on non-obvious pytest behavior." It does not.

**Impact:** None. Standard test runner.

**Action:** None.

---

### 6. Python `ipaddress` — VERIFIED (standard library)

**Behavior verified:** `ipaddress.ip_network()` creates network objects for CIDR ranges. `ipaddress.ip_address()` creates address objects for containment checks. Both are stable stdlib APIs.

**Source:** https://docs.python.org/3/library/ipaddress.html — `ipaddress.ip_network(address, strict=True)` and `ipaddress.ip_address(address)` are documented as creating `IPv4Network`/`IPv6Network` and `IPv4Address`/`IPv6Address` objects respectively. The `in` operator checks containment.

**Access date:** 2026-05-08

**Installed version:** Python 3.12.3

**Code usage:** `search_tool/url_policy.py` — defines 16 private/reserved `ip_network()` ranges, resolves hostnames via `socket.getaddrinfo`, checks containment with `ip_address(resolved_ip) in network`.

**Finding:** Confirmed. Standard library APIs used as documented. No version-specific behavior concerns.

**Impact:** Security. Private IP detection is the core SSRF mitigation for resolved hostnames.

**Action:** None. Correct as implemented.

---

### 7. Python `socket.getaddrinfo` — VERIFIED (standard library)

**Behavior verified:** `socket.getaddrinfo(host, port, family, type)` performs DNS resolution and returns address info. `AF_UNSPEC` returns both IPv4 and IPv6 results. `SOCK_STREAM` filters to TCP results.

**Source:** https://docs.python.org/3/library/socket.html#socket.getaddrinfo — documented signature and behavior. Returns list of 5-tuples `(family, type, proto, canonname, sockaddr)`.

**Access date:** 2026-05-08

**Installed version:** Python 3.12.3

**Code usage:** `search_tool/url_policy.py` — `socket.getaddrinfo(hostname, None, socket.AF_UNSPEC, socket.SOCK_STREAM)` for DNS resolution before IP policy check.

**Finding:** Confirmed. `port=None` returns address info without service name resolution. `AF_UNSPEC` ensures both IPv4 and IPv6 addresses are checked against the private network list.

**Impact:** Security. DNS resolution is required to check resolved IPs against the private network blocklist.

**Action:** None. Correct as implemented.

---

## Additional scope items (no README row)

These items were listed in the MVP-1C direction memo scope but had no README table row. Each is assessed below.

### 8. httpx streaming behavior (`client.stream()`, `iter_bytes()`) — NOT_MATERIAL

**Reason:** `client.stream("GET", url)` with `response.iter_bytes()` is standard httpx streaming API. The repo uses it to limit memory usage for large responses (reads chunks, appends to list of bytes, caps at `MAX_CONTENT_LENGTH`). No non-obvious behavior is depended upon — it's documented straightforward streaming.

**Source:** https://www.python-httpx.org/advanced/#streaming-responses

**Access date:** 2026-05-08

**Impact:** Memory efficiency. Standard streaming pattern.

**Action:** No README row needed. Standard API usage with no non-obvious semantics.

---

### 9. httpx redirect response handling (status code on 3xx, Location header) — NOT_MATERIAL

**Reason:** Reading `response.status_code` and `response.headers.get("Location")` on 3xx responses is standard HTTP, not httpx-specific behavior. The repo does not depend on any httpx-specific redirect response semantics beyond basic header access.

**Source:** Standard HTTP (RFC 9110). httpx exposes headers via standard dict-like interface.

**Access date:** 2026-05-08

**Impact:** Redirect detection. Standard HTTP semantics.

**Action:** No README row needed. Standard HTTP header access.

---

### 10. BS4 entity/text behavior — NOT_MATERIAL

**Reason:** `get_text(separator="\n")` is documented BS4 API for extracting visible text with newline separators. `decompose()` is documented for removing tags from the parse tree. `find_all()` is the standard search method. No non-obvious entity decoding or text extraction behavior is depended upon.

**Source:** https://www.crummy.com/software/BeautifulSoup/bs4/doc/#get-text — documents `separator` parameter and behavior.

**Access date:** 2026-05-08

**Impact:** Text extraction quality. Standard API usage.

**Action:** No README row needed. Standard API usage.

---

### 11. `urllib.parse.urljoin` — NOT_MATERIAL

**Reason:** Used in `_fetch_with_redirects()` to resolve relative `Location` headers against the current URL. `urljoin(base, url)` is standard RFC 3986 reference resolution. No non-obvious behavior depended upon.

**Source:** https://docs.python.org/3/library/urllib.parse.html#urllib.parse.urljoin

**Access date:** 2026-05-08

**Impact:** Redirect URL resolution. Standard RFC-compliant behavior.

**Action:** No README row needed. Standard library API.

---

### 12. `hashlib.sha256` — NOT_MATERIAL

**Reason:** Used for SHA-256 hashing in cache keys and evidence filenames. `hashlib.sha256(data).hexdigest()` is standard, deterministic, and has no non-obvious behavior.

**Source:** https://docs.python.org/3/library/hashlib.html

**Access date:** 2026-05-08

**Impact:** Cache key and filename uniqueness. Standard cryptographic hash.

**Action:** No README row needed. Standard library API.

---

### 13. `json.dumps` / `json.loads` — NOT_MATERIAL

**Reason:** Used for serializing cache metadata and config hashes. `json.dumps(obj, sort_keys=True)` for deterministic serialization, `json.loads()` for deserialization. Standard, well-understood API.

**Source:** https://docs.python.org/3/library/json.html

**Access date:** 2026-05-08

**Impact:** Cache metadata persistence. Standard serialization.

**Action:** No README row needed. Standard library API.

---

### 14. `pathlib.Path` — NOT_MATERIAL

**Reason:** Used for filesystem path manipulation (`Path("cache")`, `Path("evidence")`, file existence checks, reads, writes). Standard OOP path API. No non-obvious behavior depended upon.

**Source:** https://docs.python.org/3/library/pathlib.html

**Access date:** 2026-05-08

**Impact:** Filesystem operations. Standard path API.

**Action:** No README row needed. Standard library API.

---

### 15. `tempfile.mkstemp` — NOT_MATERIAL

**Reason:** Used in cache.py for atomic writes (`mkstemp` → write → `os.replace`). Standard pattern for safe file creation. No non-obvious behavior depended upon.

**Source:** https://docs.python.org/3/library/tempfile.html#tempfile.mkstemp

**Access date:** 2026-05-08

**Impact:** Atomic cache writes. Standard safe-write pattern.

**Action:** No README row needed. Standard library API.

---

## Summary

| # | Dependency | Behavior | Status |
|---|---|---|---|
| 1 | httpx `Client(trust_env=False)` | Prevents proxy env leakage | VERIFIED |
| 2 | httpx `follow_redirects=False` | Prevents automatic redirect following | VERIFIED |
| 3 | httpx timeout behavior | Connection/request timeout (30s) | VERIFIED |
| 4 | BeautifulSoup `html.parser` | HTML parsing for text extraction | VERIFIED |
| 5 | pytest | Test runner (standard usage) | VERIFIED |
| 6 | Python `ipaddress` | Private/reserved network detection | VERIFIED |
| 7 | Python `socket.getaddrinfo` | DNS resolution for IP policy | VERIFIED |
| 8 | httpx streaming | `client.stream()` / `iter_bytes()` | NOT_MATERIAL |
| 9 | httpx redirect response | Status code / Location header | NOT_MATERIAL |
| 10 | BS4 entity/text | `get_text()`, `decompose()`, `find_all()` | NOT_MATERIAL |
| 11 | `urllib.parse.urljoin` | Redirect URL resolution | NOT_MATERIAL |
| 12 | `hashlib.sha256` | Cache key / filename hashing | NOT_MATERIAL |
| 13 | `json.dumps` / `json.loads` | Cache metadata serialization | NOT_MATERIAL |
| 14 | `pathlib.Path` | Filesystem path operations | NOT_MATERIAL |
| 15 | `tempfile.mkstemp` | Atomic cache writes | NOT_MATERIAL |

**Totals:** 7 VERIFIED, 0 DOCUMENTED_DISCREPANCY, 0 BLOCKED_UNVERIFIED, 8 NOT_MATERIAL.

## Count mismatch explanation (10 vs 7 vs 15)

The MVP-1C direction memo states "10 UNVERIFIED dependency entries" — this was a counting error in the memo. The actual README table had **7 rows**. The memo's scope section listed additional stdlib items (`urllib.parse.urljoin`, `hashlib`/`json`/`pathlib`/`tempfile`) and httpx/BS4 sub-behaviors that were never in the README table. These 8 additional items are assessed above as NOT_MATERIAL — they use standard library/third-party APIs with no non-obvious behavior that would warrant a README documentation row.

## Discrepancies found

None. All verified behavior matches upstream documentation.
