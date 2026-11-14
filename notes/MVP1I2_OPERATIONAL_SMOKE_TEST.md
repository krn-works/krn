# MVP-1I.2 — Operational Smoke Test

**Date:** 2026-05-16
**Baseline:** `3b946acb053c946c334818bc03169e7e158292e5`

## CI Status

- **Run exists:** Yes
- **Status:** success
- **Commit:** `3b946ac`
- **Run created:** 2026-05-16T09:03:19Z
- **Workflow:** CI on GitHub Actions
- **Verdict:** CI gate runs and passes on pushed commit.

## Local Deterministic Gate

| Check | Result |
|---|---|
| pytest tests/ -v | 637/637 passed |
| py_compile | OK |
| git diff --check | OK |
| eval-corpus | 11/11 passed, JSON parse OK |

## Health Check

- **Overall status:** ok
- **package_import:** ok
- **static_provider:** ok
- **searxng_reachable:** info — `SEARXNG_URL` not configured (optional, static provider works)
- **evidence_writable:** ok
- **objects_writable:** ok

Missing SearXNG is `info`/optional, not a failure.

## Docker / SearXNG Status

Multiple SearXNG containers running (`searxng/searxng:latest`) across supersearch, krn-supersearch, supersearch-package, krn-skill-improver-local-version projects. None have host port 8080 mapped.

`localhost:8080` returns `{"error":{"message":"File Not Found","type":"not_found_error","code":404}}` on all paths (`/search`, `/`, etc.). This is not a SearXNG instance — likely a reverse proxy or load balancer from the supersearch project.

**Local SearXNG command (not run without authorization):**
```bash
docker run --rm -p 9999:8080 searxng/searxng
```

## Static Research Smoke

```bash
WORKDIR="$(mktemp -d)"
python -m search_tool search-query "python http.server security docs" \
  --research --provider static \
  --candidate-url "https://docs.python.org/3/library/http.server.html" \
  --work-dir "$WORKDIR"
```

- **Result:** JSON OK
- **status:** "ok"
- **research_mode.enabled:** true
- **profile.name:** "official-docs"
- **compact_summary_path:** exists
- **recovery.websearch_allowed:** false
- **Note:** Hits live docs.python.org (fetch is required for static candidate URLs).

## SearXNG Live Smoke

**Skipped.** SearXNG containers exist on this host but none are reachable on a host-mapped port. `localhost:8080` returns 404 (not SearXNG).

Static research mode still works. SearXNG remains optional local provider.

## Artifact Hygiene

- No generated artifacts tracked
- `.local` directory is ignored by `.gitignore`
- Working tree clean (except ignored files)

## Verdict

CI gate is operational. Local deterministic checks all pass. Research mode works with static provider (live fetch). SearXNG live smoke skipped due to unconfigured local instance.

## Recommended Next Action

Spin up a SearXNG container with host port mapping for live integration smoke:
```bash
docker run --rm -p 9999:8080 searxng/searxng
python -m search_tool search-query "test" --research --provider searxng --searxng-url http://localhost:9999
```
