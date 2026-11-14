# MVP-1I.3 — SearXNG Local Live Smoke

**Date:** 2026-05-16
**Baseline:** `6ad0e3d082fdf51cdb7a36f423d5ef50bd9fd311`

## Baseline verification

| Check | Result |
|---|---|
| HEAD | 6ad0e3d082fdf51cdb7a36f423d5ef50bd9fd311 |
| origin/main | 6ad0e3d082fdf51cdb7a36f423d5ef50bd9fd311 |
| Working tree | Clean |
| Tests | 637/637 passed |
| Compile | OK |
| git diff --check | OK |
| eval-corpus | 11/11 passed, JSON parse OK |

## Health/behavior audit

| Check | Result |
|---|---|
| `health --json` exposes SearXNG reachability | Yes — `searxng_reachable` check |
| Reads `SEARXNG_URL` env var | Yes |
| Distinguishes optional/unreachable from failure | Yes — info (not set), warn (unreachable), ok (reachable). Never fail. |
| Tests for reachable/unreachable | Yes — 3 dedicated tests |
| Port 9999 documented consistently | Partially — memory, SKILL.md, CLI default. Not in README until this task. |
| `/krn-search-research` mentions SearXNG | No — updated in this task |
| Docs say `python` instead of `.venv/bin/python` | Yes — README UI section, SKILL.md. Updated in this task. |

## Pre-smoke Docker state

No SearXNG container had a host port mapping. All 4 SearXNG containers show only `8080/tcp`.

`localhost:8080` returns 404 JSON — not SearXNG (likely a reverse proxy from supersearch project).
`localhost:9999` — not reachable.

## Temporary smoke container

Started: `docker run --rm -d --name krn-search-searxng-smoke -p 9999:8080 searxng/searxng`

Reachable after: 1 second

## Health check with SearXNG running

```json
{
  "schema_version": "0.1",
  "checks": [
    {"name": "package_import", "status": "ok"},
    {"name": "static_provider", "status": "ok"},
    {"name": "searxng_reachable", "status": "warn", "message": "SearXNG unreachable at http://localhost:9999"},
    {"name": "evidence_writable", "status": "ok"},
    {"name": "objects_writable", "status": "ok"}
  ],
  "overall": "degraded"
}
```

**Finding:** Health reports `warn` because default SearXNG Docker image has `search.formats: [html]` only.
JSON API returns 403 on both GET and POST. Health check uses POST `q=__health__&format=json`.

This is **correct behavior** — the health check properly reports SearXNG as unreachable when the JSON API is not configured.

## Discovery provider 403 handling

The discovery provider (`discovery.py:325-331`) handles HTTP 403 with a clear error:
- Code: `api_forbidden`
- Message: `"HTTP 403 — JSON format likely disabled in settings.yml (search.formats must include 'json')"`

This is already user-friendly and requires no changes.

## Docs/test changes

- **README.md** — Added "Local SearXNG live smoke" section with config, verification, health, research smoke, stop steps. Noted SearXNG optional, port 9999 recommended, JSON format required.
- **README.md** — Fixed UI section to use `.venv/bin/python -m search_tool ui`
- **SKILL.md** — Updated all commands to `.venv/bin/python`. Added SearXNG JSON format prerequisite to preconditions.
- **krn-search-research.md** — Added SearXNG availability check step, JSON format note, `.venv/bin/python` note.
- **notes/PROJECT_STATE.md** — Updated to MVP-1I.3.
- **notes/ACTIVE_TASK.md** — Updated last completed and recommended next.

## Verification

| Check | Result |
|---|---|
| Tests pass | 637/637 |
| Compile | OK |
| git diff --check | OK |
| eval-corpus | 11/11, JSON OK |
| Generated artifacts in repo | None |
| Smoke container left running | Cleaned up |

## Verdict

SearXNG is optional, health behavior is correct (warn, not fail), discovery error messages are clear. All polish is docs-only.

## Container status

Stopped and removed: `docker rm -f krn-search-searxng-smoke`
