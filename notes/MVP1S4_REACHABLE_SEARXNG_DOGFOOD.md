# 2026-05-24 — MVP-1S.4 Reachable SearXNG Dogfood + Local Runbook

## Goal

Validate whether the research-mode `SearXNG` path can be run locally end-to-end:
- `krn-search health --research` with reachable local SearXNG.
- `krn-search health --research --json`.
- `krn-search search-query --research` using real `provider=auto` path.
- Optional override-precedence check.

## Scope

- No code changes unless a hard blocker is found.
- No public/native web fallback.
- No LLM-generated URL candidates.
- No generated `.local/...` artifacts committed.

## Outcome

`--research` healthy path **not validated as runnable in this environment**.  
`SearXNG` was reachable in probe commands only in principle via Docker checks, but actual ready HTTP JSON/search endpoint was never achieved with the local commands I could execute safely.

## Commands run and results

### A. Environment discoverability (`localhost:9999`)

- `.venv/bin/python -m search_tool health --research`
  - Exit code: `1`
  - Output: fail with `research mode requires SearXNG discovery, but SearXNG is unreachable at http://localhost:9999 (source: default).`

- `.venv/bin/python -m search_tool health --research --json`
  - Exit code: `1`
  - JSON `overall`: `"fail"`
  - `checks[].name=="searxng_reachable"` status: `"fail"`

- Python TCP probe to `127.0.0.1:9999`
  - Result: `ConnectionRefusedError [Errno 111] Connection refused`

### B. Existing local run references

- `rg -n "SearXNG|searxng|9999|docker" README.md` found an existing local smoke section under **README.md** with:
  - Docker launch recipe on port `9999`.
  - JSON format requirement in `settings.yml`.
  - `krn-search health --json` verification flow.

### C. Attempted reachable startup + validation

Since no dedicated repo script exists, I tested the README-style command set.

1. `docker run --rm -d --name krn-search-searxng-smoke-s4 -v /tmp/krn-search-searxng-smoke-s4:/etc/searxng:ro -p 9999:8080 searxng/searxng`
   - Container started but startup logs showed file-system permission errors on `/etc/searxng`.
   - HTTP probe did not become usable for `search` JSON endpoint.

2. Retried with README-like mount:
   - `docker run --rm -d --name krn-search-searxng-smoke-s4 -v /tmp/searxng-config:/etc/searxng-loader:ro -p 9999:8080 searxng/searxng`
   - Repeated `curl 'http://localhost:9999/search?q=test&format=json'` produced:
     - connection reset before handoff,
     - then repeated HTTP 403 responses during startup window.
   - The process was then manually terminated to avoid a hanging startup loop.

Because the reachable endpoint never became queryable, I did not execute:
- `SEARXNG_URL=http://localhost:9999 .venv/bin/python -m search_tool health --research --json`
- `SEARXNG_URL=http://localhost:9999 .venv/bin/python -m search_tool search-query ... --research --work-dir .local/krn-search-runs-s4-dogfood --session ...`

No `.local/krn-search-runs-s4-dogfood` artifacts were created.

### D. Override precedence check

- `SEARXNG_URL=http://localhost:19999 .venv/bin/python -m search_tool health --research --searxng-url http://localhost:19998 --json`
  - Exit code: `1`
  - (Previously validated in S.3 and retained for S.4 as still-documented behavior.)

## Decision

`NEEDS_FIX`

## Clarification

- `health --research` required behavior is confirmed in this environment for unreachable SearXNG.
- Reachable auto-research path is not accepted yet, because no validated local ready endpoint was obtained.
- Next step: validate locally with a working, ready SearXNG endpoint (or document accepted external endpoint for operator runbook).

## Follow-up candidates

- Capture a reliable local SearXNG startup recipe for this host image/version (the mount/options path produced 403 in this environment).
- If startup remains flaky, add a short "known good container image/version + optional init notes" note to runbook.
- If image startup remains blocked by policy/network, add fallback operator note that `krn-search --research` requires external reachable SearXNG per `SEARXNG_URL`.

