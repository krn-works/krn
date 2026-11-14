# krn-search-lab

Minimal URL to evidence pack tool. Controlled untrusted web ingestion.

## Quick start

```bash
# Install
pipx install git+https://github.com/korneliuszburian/krn-search.git

# Verify
krn-search health --json

# Fetch a single URL → evidence pack
krn-search fetch-url https://example.com

# Research mode: discover + fetch + compact index in one command
krn-search search-query "python asyncio" --research

# Bootstrap Claude Code artifacts into a repo
krn-search init-claude --target-dir /path/to/repo
```

Evidence packs land in `.local/krn-search-runs/`. See **Search query** below for artifact layout.

## What this project is

A CLI tool that takes a URL and produces a Markdown evidence pack with:
- YAML frontmatter metadata (schema version, timestamps, security audit trail)
- Extracted readable text from the fetched page
- Explicit safety notice marking content as untrusted
- Failure packs for blocked URLs, fetch errors, and unsupported content

## Architecture

A controlled web ingestion pipeline with dedup-safe evidence generation:

```
URL -> validation -> fetch -> dedup check -> extraction -> cache -> evidence pack
```

Discovery (not search) is available via `search-query`:

```
query -> candidate URLs -> fetch-url for each URL -> evidence pack set -> synthesis
```

No synthesis or ranking is implemented.

## What this project is not

- Not a web search engine (produces evidence artifacts, not answers)
- Not a browser automation tool (static HTML extraction only)
- Not a framework
- Not a Claude Code skill, hook, or MCP server (can bootstrap them for other repos, but is not one itself)

## MVP-0 goal

Test whether a minimal URL-to-evidence-pack tool is useful enough to inform the design of a future `/search` capability in krn-ai-os. MVP-0 through MVP-1N are complete — see `notes/PROJECT_STATE.md`.

## Threat model

**Attacker:** Any HTTP server on the public internet.

**Assets:** Local filesystem, shell environment, AI model behavior.

**Trust boundary:** Every fetched page is untrusted external content. Evidence packs are data containers, not instructions. The tool must never let source content influence its own behavior.

**Specific threats mitigated:**
- SSRF via private IP / loopback / metadata endpoints
- Credential leakage via `user:pass@host` URLs
- DNS rebinding (mitigated at check time; residual risk exists — see Known Limitations)
- Markdown injection via adaptive fences
- HTML injection in titles and metadata via entity escaping
- Prompt injection via explicit safety notice

## URL policy

| Check | Behavior |
|---|---|
| Scheme | Only `http` and `https` allowed |
| Credentials | `user:pass@host` URLs rejected |
| Hostname | `localhost`, `localhost.localdomain` rejected |
| DNS resolution | Rejects if resolved IP is in private/loopback/link-local/multicast/reserved ranges |
| Private networks | 127.0.0.0/8, ::1, 169.254.0.0/16, 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, fe80::/10, fc00::/7, ff00::/8, 0.0.0.0/8, 100.64.0.0/10, 198.18.0.0/15, 224.0.0.0/4, 240.0.0.0/4, 192.0.2.0/24, 198.51.100.0/24, 203.0.113.0/24, 2001:db8::/32 |

## URL normalization

Normalized URL preserves all security-relevant and content-identifying components:
- Scheme lowercased
- Hostname lowercased
- Explicit non-default port preserved (e.g. `:8080`)
- Default ports normalized away (http:80, https:443)
- Path preserved with minimal normalization (no trailing slash except root)
- Query string preserved
- Fragment removed (not sent over HTTP)
- Credentials never survive (blocked before fetch)

Examples:
- `https://Example.COM/docs?page=1` -> `https://example.com/docs?page=1`
- `http://example.com:80/` -> `http://example.com/`
- `https://example.com:443/path#section` -> `https://example.com/path`

## HTTP status semantics

| Status range | `fetch.status` | Behavior |
|---|---|---|
| 2xx | `"success"` | Body extracted, evidence pack written, exit 0 |
| 3xx | `"success"` (redirect recorded) | Redirect not followed, Location recorded, exit 0 |
| 4xx | `"failed"` | Body extracted if available, error recorded, evidence pack written, exit 0 |
| 5xx | `"failed"` | Body extracted if available, error recorded, evidence pack written, exit 0 |
| Network error | `"failed"` | Error recorded, evidence pack written, exit 0 |

Expected fetch failures (404, DNS error, timeout, blocked URL) always exit 0 with a failure evidence pack.

## Redirect policy

Any `300 <= status_code < 400` is treated as a redirect. Redirects are **not followed by default**. The redirect status code and Location header (truncated if > 2048 chars) are recorded. A limitation is added stating the redirect was not followed. Redirect response bodies are not consumed — they have no value in MVP-0.

### Controlled redirect following (`--follow-redirects`)

When `--follow-redirects` is passed, redirects are followed with these guarantees:

- **Opt-in only** — default remains no-follow
- **Depth limited** — maximum 3 hops (`MAX_REDIRECTS = 3`)
- **Per-hop policy checked** — every redirect target passes the full URL policy (scheme, credentials, private IP)
- **Unsafe targets blocked** — `file://`, `127.0.0.1`, URLs with credentials are rejected before fetch
- **Loop detected** — normalized URLs tracked; cycles fail honestly
- **Relative redirects resolved** — relative `Location` headers resolved against current URL
- **Targets normalized** — fragments stripped, default ports removed before fetch
- **Blocked hops recorded** — `blocked_reason` set on the redirect hop that was blocked

## `final_url` semantics

- **2xx success (no redirects):** `final_url` = normalized requested URL
- **2xx success (followed redirects):** `final_url` = normalized final URL after all redirect hops
- **3xx redirect (not followed):** `final_url` = `null`
- **Blocked URL or redirect target:** `final_url` = `null`
- **Failed fetch:** `final_url` = `null`

## Cache semantics

- **Layout:** `cache/objects/<sha256-body>` for bodies, `cache/entries/<sha256-config>.json` for metadata
- **Key:** SHA-256 of `{normalized_url, trust_env, follow_redirects, timeout, max_bytes}`
- **Refresh is not part of the key** — it bypasses cache, it does not define a different cached object identity
- **Cache paths are never derived from URL paths** — only hash digests are used
- **Same URL + same config = cache hit.** Config changes invalidate the key.
- **`--refresh` bypasses cache** but produces the same cache key
- **Writes are atomic** via temp file + `os.replace`

## Evidence pack path naming

Evidence filenames use a hash-based scheme: `<hostname-prefix>-<sha256-url-prefix>.md`

Example: `evidence/example-0f115db062b7c0dd.md`

URL path segments are never used as filesystem path components.

## Evidence schema (v0.1)

Every evidence pack is Markdown with YAML frontmatter. Required fields:

```
schema_version: "0.1"
generated_at_utc: <ISO timestamp>
tool: {name, version, config_hash}
command: {name, refresh}
source: {original_url, normalized_url, final_url, title}
fetch: {status, http_status, content_type, content_length_bytes, body_sha256, redirects}
cache: {status, key, body_cache_ref}
extraction: {status, method, text_chars, truncated}
security: {url_policy, blocked_reason, credentials_in_url, private_ip_blocked}
errors: []
limitations: []
```

Body sections: Source (with title if available), Safety notice, Extracted source content (fenced), Errors, Limitations.

## Known limitations

- Redirects not followed by default (opt-in via `--follow-redirects`)
- `MAX_REDIRECTS = 3` is a constant, not configurable via CLI
- Redirect following increases SSRF surface area (mitigated by per-hop policy check)
- No JavaScript rendering — only static HTML extraction
- Binary content (PDF, DOCX, images) is skipped with honest reporting
- **DNS rebinding is possible** after the policy check — this is a check-then-use race. The tool validates the IP at policy-check time, but between the check and the actual HTTP request, a malicious DNS server could rebind the hostname to a different IP. This is a known residual risk that cannot be fully mitigated without a custom DNS resolver or persistent connection pinning.
- No cache TTL or eviction
- Large responses are truncated at 10 MB (raw) / 500K chars (extracted)
- Content behind authentication is not supported

## Dependencies

| Package | Why |
|---|---|
| `httpx` | HTTP client with explicit redirect control, streaming, and `trust_env=False`. |
| `beautifulsoup4` | HTML parsing for text extraction. Removes script/style/svg/iframe. No JS rendering. |
| `pytest` | Test runner (dev only) |

## Documentation verification status

All entries verified 2026-05-08.

| Dependency | Decision | Status |
|---|---|---|
| httpx `Client(trust_env=False)` | Prevents proxy env leakage | VERIFIED — [API ref](https://www.python-httpx.org/api/#client): `trust_env=True` is default; `False` disables env var config. Tested: httpx 0.28.1 |
| httpx `follow_redirects=False` | Prevents automatic redirect following | VERIFIED — [API ref](https://www.python-httpx.org/api/#client) + [quickstart](https://www.python-httpx.org/quickstart/#redirects): `follow_redirects=False` is default. Tested: httpx 0.28.1 |
| httpx timeout behavior | Connection/request timeout | VERIFIED — [quickstart](https://www.python-httpx.org/quickstart/#timeouts): float timeout is connection+read; default 5.0s, repo uses 30.0s. Tested: httpx 0.28.1 |
| BeautifulSoup `html.parser` | Sufficient for MVP-0 text extraction | VERIFIED — [docs](https://www.crummy.com/software/BeautifulSoup/bs4/doc/#installing-a-parser): `html.parser` is batteries-included, decent speed, handles all used APIs. Tested: bs4 4.14.3 |
| pytest | Test runner | VERIFIED — standard usage. No non-obvious pytest behavior depended upon. Tested: pytest 9.0.3 |
| Python `ipaddress` | Private/reserved network detection | VERIFIED — [docs](https://docs.python.org/3/library/ipaddress.html): `ip_network()` and `ip_address()` are stable stdlib APIs. Tested: Python 3.12.3 |
| Python `socket.getaddrinfo` | DNS resolution for IP policy | VERIFIED — [docs](https://docs.python.org/3/library/socket.html#socket.getaddrinfo): `AF_UNSPEC`/`SOCK_STREAM` flags for DNS resolution. Tested: Python 3.12.3 |

## Local SearXNG live smoke

SearXNG is **optional**. The tool works with the static provider without any external dependencies.

### Quick smoke test

Use the built-in local operator path:

```bash
krn-search searxng status
krn-search searxng up
```

Verify SearXNG is reachable:

```bash
curl 'http://localhost:9999/search?q=test&format=json'
```

Run health check:

```bash
SEARXNG_URL=http://localhost:9999 krn-search health --research --json --wait 30
```

Run live research smoke:

```bash
krn-search search-query "claude code hooks documentation" \
  --research \
  --max-candidates 5 \
  --work-dir "$(mktemp -d)"
```

Stop:

```bash
krn-search searxng down
```

### Important notes

- **SearXNG is optional** — CI does not require SearXNG, and the tool works with the static provider
- **Port 9999** is the recommended local smoke port (SearXNG container listens on 8080 internally)
- **Port 8080** may be occupied by unrelated local services — the recommended approach maps host 9999 → container 8080
- **Container running is not enough** — the JSON endpoint must answer on `http://localhost:9999/search?q=test&format=json`
- **JSON format must be enabled** — `krn-search searxng up` patches `search.formats` to include `json`
- **Default secret key is not valid** — `krn-search searxng up` also writes a non-default `server.secret_key`
- **Current image source path changed** — the working default settings file comes from `/usr/local/searxng/searx/settings.yml`
- **Runtime config stays user-owned** — the bootstrap path writes outside the repo under `$XDG_CACHE_HOME/krn-search/searxng` or `/tmp/krn-search-searxng-pnp-<uid>`
- Missing SearXNG is `info`/`warn`, not `fail`; `health` probes `SEARXNG_URL` when set and otherwise checks the default local instance at `http://localhost:9999`

## Portable Claude Code research kit

Install krn-search as a reusable Claude Code skill + command for any repo:

**Install the CLI:**
```bash
pipx install git+https://github.com/korneliuszburian/krn-search.git
# or: uv tool install git+https://github.com/korneliuszburian/krn-search.git
# or local editable: python3 -m venv .venv && .venv/bin/pip install -e ".[dev]"
```

**Verify:**
```bash
krn-search health --json
```

**Configure portable command (optional):**
```bash
export KRN_SEARCH_BIN=krn-search
```

**Copy Claude artifacts** (from the target repo):
- `.claude/skills/krn-search-research/SKILL.md` → `.claude/skills/krn-search-research/SKILL.md`
- `.claude/commands/krn-search-research.md` → `.claude/commands/krn-search-research.md`
- Optional: `.claude/hooks/postcommit_contract_check.py`
- Optional: `.claude/hooks/websearch_krn_search_guard.py`
- Optional: `.claude/hooks/candidate_url_static_guard.py`

**Use:**
```bash
/krn-search-research "What does X say about Y?"
# or
krn-search searxng status || krn-search searxng up
krn-search search-query "<query>" --research
```

**Work-dir:** artifacts go to `.local/krn-search-runs` (configurable via `--work-dir`).

**SearXNG:** optional overall, but required for `--research` discovery. Local bootstrap path: `krn-search searxng up`.

> **Note:** MCP server and plugin packaging are deferred. Only the CLI skill + slash command are included in the portable kit.

### Bootstrap command

One command to copy all `.claude/` artifacts into a target repository:

```bash
krn-search init-claude                          # copy skill + command
krn-search init-claude --with-hook              # also copy and configure the Claude Code guard hooks
krn-search init-claude --dry-run                # print intended actions, write nothing
krn-search init-claude --force                  # overwrite existing managed files
krn-search init-claude --target-dir /path/to/repo  # target a specific directory
```

**Defaults:**
- Copies `.claude/skills/krn-search-research/SKILL.md` and `.claude/commands/krn-search-research.md`
- Injects the managed krn-search research contract into existing `CLAUDE.md`, `AGENTS.md`, and `.claude/rules/00-operating-model.md` files when present
- Does **not** copy or activate the hook unless `--with-hook` is used
- With `--with-hook`, copies `.claude/hooks/websearch_krn_search_guard.py` and `.claude/hooks/candidate_url_static_guard.py`, then merges `.claude/settings.local.json` to activate the PreToolUse guards
- Does **not** write `.claude/settings.json`
- Skips existing files by default; use `--force` to overwrite

**Work-dir:** artifacts go to `.local/krn-search-runs` (configurable via `--work-dir`).

```
Primary:    krn-search installed on PATH (pipx/uv tool/pip install)
Editable:   export KRN_SEARCH_BIN=".venv/bin/python -m search_tool"
```

For `KRN_SEARCH_BIN` containing spaces (editable fallback): use in bash/Claude Code with unquoted `$KRN_SEARCH_BIN`. **Not zsh-safe** for manual copy-paste — the variable contains spaces and bash-only word splitting applies. For zsh compatibility, use an installed `krn-search` executable.

### KRN_SEARCH_BIN convention

If `KRN_SEARCH_BIN` is set, it is used directly. Otherwise the resolution order is:

```bash
if [ -n "${KRN_SEARCH_BIN:-}" ]; then :
elif command -v krn-search >/dev/null 2>&1; then
  KRN_SEARCH_BIN="krn-search"
elif [ -x .venv/bin/python ]; then
  KRN_SEARCH_BIN=".venv/bin/python -m search_tool"
elif command -v python3 >/dev/null 2>&1; then
  KRN_SEARCH_BIN="python3 -m search_tool"
else
  KRN_SEARCH_BIN="python -m search_tool"
fi
```

## Running tests

```bash
python3 -m venv .venv
.venv/bin/pip install -e ".[dev]"
.venv/bin/pytest tests/ -v
```

All tests use mocked DNS and HTTP. No live internet dependency.

## CI gate

A deterministic acceptance gate runs on every push and pull request to `main` via GitHub Actions. It validates:

- Python source compiles (no syntax errors)
- No trailing whitespace in working tree
- Full test suite (pytest exit code)
- Eval-corpus (11/11, fully mocked, network-free)
- Research mode preflight structure (JSON shape + `research_mode.enabled`)
- Research mode invalid-profile error JSON (preflight validation)

CI is fully network-free. It does not require SearXNG and does not perform live web search. It mirrors the local acceptance checks documented in this README.

## Running one fetch

```bash
# Via installed CLI entrypoint
krn-search fetch-url https://example.com
krn-search fetch-url https://example.com --refresh
krn-search fetch-url https://example.com --follow-redirects

# Version
krn-search --version
```

Output: path to the evidence pack Markdown file.

## Discover query

Discover candidate URLs for a query using a discovery provider. This only discovers URLs — it does not fetch them, create evidence packs, or produce any files.

```bash
# Static provider — provide candidate URLs directly
krn-search discover-query "python async await" \
  --provider static \
  --candidate-url "https://docs.python.org/3/library/asyncio.html" \
  --candidate-title "asyncio — Asynchronous I/O" \
  --candidate-snippet "This module provides the infrastructure for writing single-threaded concurrent code"

# SearXNG provider — requires explicit self-hosted instance URL
krn-search discover-query "python async await" \
  --provider searxng \
  --searxng-url "https://search.example.com"

# llms provider — discover URLs from an llms.txt/docs-index file
krn-search discover-query "validation models" \
  --provider llms \
  --url "https://docs.example.com/llms.txt"
```

**llms provider note:** Discovers URLs by parsing a single llms.txt file. Discovered URLs still go through the standard URL policy validation and fetch/evidence pipeline. No WebSearch or SearXNG required. Source llms.txt HTTP redirects are NOT followed by default; use `--follow-redirects` to enable. Three CLI aliases for the source URL: `--url`, `--llms-url`, `--docs-index-url` (only one allowed).

**Output:** JSON to stdout with query metadata, provider info, candidates, and a `urls_for_fetch` list.

**Important:** The `urls_for_fetch` list can be used with `fetch-list` in a later step to batch-fetch discovered URLs. This workflow is not yet automated.

**No public SearXNG default.** The `--searxng-url` option is required when using the searxng provider. See `notes/MVP1E3_SEARXNG_PROVIDER_VERIFICATION.md` for configuration requirements.

**Privacy warning:** When using the searxng provider, your query is forwarded to upstream search engines (Google, Bing, DuckDuckGo, etc.) via your SearXNG instance. Query redaction catches accidental token pastes but does not prevent semantic leakage.

## Search query

Discover candidate URLs for a query and fetch them in a single command.

```bash
# Research mode (recommended for Claude Code)
krn-search search-query "python async await" --research
# Expands to: --provider auto --json --compact --profile official-docs --work-dir .local/krn-search-runs --follow-redirects
# Override: --research --profile security-research --no-compact

# Using SearXNG (requires SEARXNG_URL)
krn-search search-query "python async await" \
  --provider searxng \
  --searxng-url "https://search.example.com"

# Using static URLs (for testing)
krn-search search-query "test query" \
  --provider static \
  --candidate-url "https://example.com"

# Using llms provider (discover from docs-index, with redirect following)
krn-search search-query "validation models" \
  --provider llms \
  --llms-url "https://docs.pydantic.dev/llms.txt" \
  --json --work-dir .local/krn-search-runs --follow-redirects

# With fetch options
krn-search search-query "test" \
  --provider static \
  --candidate-url "https://example.com" \
  --refresh --follow-redirects
```

Produces:
1. **Evidence packs:** One Markdown file per successful fetch. Duplicate URLs (canonical + final_url) are skipped before extraction and reported in `limitations`.
2. **Fetch-list manifest:** A Markdown file linking all evidence packs for this specific run.
3. **Search-run manifest:** The root artifact for the search run. It links to the fetch-list manifest and contains discovery metadata (query hash, redacted query, provider info, discovery counts).
4. **Compact evidence index** (`--compact` or `--research`): Source table with authority/quality scores and mechanical snippets. Read this before individual evidence packs.

**Artifact reading order (research mode):** JSON output → compact evidence index → search-run manifest → fetch-list manifest → evidence packs.

**Stdout format:** Per-URL tab-separated lines (url, status, cache, quality, evidence_path), followed by `Manifest: <path>` and `SearchManifest: <path>`. Diagnostic summaries on stderr.

**Privacy:**
- The **raw original query is NOT stored** in any artifact.
- The **SHA-256 hash** of the original query is stored in the search-run manifest for auditability.
- A **redacted version** of the query (secrets removed) is stored in the search-run manifest.

**No public SearXNG default.** The `--searxng-url` option is required when using the searxng provider.

**Exit codes:** 0 for all operational outcomes. 1 for CLI misuse or if the search-run manifest fails to write.

**Query profiles:** `--profile` biases source selection by source-type preference. Available profiles: `official-docs` (default for `--research`), `github-repo`, `security-research`, `llms-docs`. The `llms-docs` profile prefers `official_docs`, `docs_site`, and `repository` source types — useful when discovering from llms.txt files that list both official docs and third-party content. Profiles are source-quality guidance only; they do not bypass URL policy, security checks, or trust boundaries.

**Research mode limitations:**
- SPA/JS-heavy docs may extract navigation chrome, cookie banners, or loading spinners instead of content
- PDFs are downloaded but not extracted (reported honestly as skipped)
- SearXNG is optional; without a running instance, `--provider auto` uses static only when explicit candidate URLs are provided
- Without SearXNG and without candidate URLs, `--research` returns a `provider_resolution` JSON error instead of guessing URLs or using WebSearch
- No synthesis, no AI summarization, no LLM ranking — krn-search produces evidence artifacts, not answers

**Privacy warning:** When using the searxng provider, your query is forwarded to upstream search engines via your SearXNG instance.

## Evaluation corpus

Run the end-to-end search pipeline against a deterministic set of scenarios.

```bash
krn-search eval-corpus tests/fixtures/search_corpus/basic.json
krn-search eval-corpus tests/fixtures/search_corpus/basic.json --work-dir ./eval-results
```

- **Stdout:** Machine-parseable JSON summary of all scenario results.
- **Stderr:** Compact human-readable summary.
- **Artifacts:** Isolated by default in a temporary directory. Use `--work-dir` to specify a persistent location.
- **Network:** Zero live network or real DNS. All responses and resolutions are mocked.
- **Exit codes:** 0 if all scenarios pass, 1 if any scenario fails or on error.

## Local UI testbench

A minimal local-only browser UI for manual testing and diagnostics.

```bash
# Start with defaults (http://127.0.0.1:8765, artifacts in .local/krn-search-ui)
krn-search ui

# Custom port and work directory
krn-search ui --port 8888 --work-dir ./my-tests
```

**Features:**
- **Search Query:** Manually run searches and see real-time artifacts.
  - **Discovery Summary:** Breakdown of candidates found, selected, blocked, duplicates, and errors.
  - **Ingestion Summary:** Breakdown of evidence packs (extracted, truncated, redirects, failed, blocked, skipped).
  - **Artifact Links:** Clickable links to fetch list and search run manifests.
  - **Follow Redirects:** Option to follow 3xx redirects for final page content.
- **Eval Corpus:** Run deterministic evaluation scenarios and see a visual report.
- **Artifacts:** Browse and view generated manifests and evidence packs.
  - **Isolation:** Each search run is isolated in its own `runs/YYYYMMDDT%H%M%SZ/` subdirectory.
  - **Cache:** Persistent cache shared across runs under `work-dir/cache/`.

**Security & Safety:**
- **Local-only:** Binds to `127.0.0.1` by default.
- **Not production:** Uses Python `http.server`, intended for local development only.
- **Path confinement:** Artifact viewer is restricted to the specified `work-dir`.
- **No authentication:** Designed for single-user local access.
- **Provider URL Redaction:** SearXNG credentials, paths, and queries are redacted in the UI.

## Running a batch fetch

```bash
# Create a URL list file (UTF-8, one URL per line)
cat > urls.txt <<'EOF'
# Comments and blank lines are ignored
https://example.com
https://docs.python.org/3/
EOF

# Via installed CLI entrypoint
krn-search fetch-list urls.txt
krn-search fetch-list urls.txt --refresh
krn-search fetch-list urls.txt --follow-redirects

# Via python -m
krn-search fetch-list urls.txt
```

**Input contract:**
- UTF-8 file, one URL per line
- Blank lines and full-line comments (`# ...`) are ignored
- Inline comments are not supported
- Order and duplicates are preserved
- Maximum 50 URLs per invocation
- Missing file, non-UTF-8, too many URLs, or zero valid URLs exit non-zero

**Stdout format:** One tab-separated line per URL (`url`, `status`, `cache_status`, `quality`, `evidence_path`), followed by a `Manifest: <path>` line.

**Per-URL failures** (blocked, DNS error, 404, timeout) produce honest evidence packs and do not abort the batch.

## Manifest schema (v0.1)

The manifest is a Markdown file with YAML frontmatter written to `evidence/manifest-<timestamp>-<sha12>.md`.

```
manifest_version: "0.1"
schema_version: "0.1"
generated_at_utc: <ISO timestamp>
tool: {name, version}
command: {name, refresh}
input: {source_file, total_urls, unique_urls}
results: {succeeded, blocked, failed}
cache: {hit, miss, bypass, not_written, errors, limitations}
```

Body sections: Summary metadata, Safety notice, Evidence Packs table (URL, Status, Cache, Quality, Evidence link).

## Quality score

The manifest quality score (0-3) is a **fetch/extraction outcome score**, not a content-usefulness assessment:

| Score | Meaning |
|---|---|
| 0 | Blocked or fetch failed |
| 1 | Fetch succeeded but extraction skipped or failed |
| 2 | Fetch and extraction succeeded but content was truncated |
| 3 | Fetch and extraction fully succeeded |

## History

MVP-0 criteria were met as of commit `02f2408`. Full MVP-1 (query discovery, research mode, dedup, llms.txt provider, portable kit) is complete. See `notes/PROJECT_STATE.md` for the current milestone tracking.
