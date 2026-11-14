# Local SearXNG Runbook

This document covers the deterministic local SearXNG bootstrap path used by the Claude Code research flow.

## Operator commands

Primary path:

```bash
krn-search searxng status
krn-search searxng up
krn-search searxng down
```

Behavior:
- `status` probes `http://localhost:9999/search?q=test&format=json`
- `up` starts `krn-search-searxng-smoke`, publishes the host port on `127.0.0.1:9999` only, patches JSON output plus a non-default `server.secret_key`, and waits for `health --research --wait 30`
- `down` removes only `krn-search-searxng-smoke`

## Prerequisites

- Docker available (`docker --version`)
- Local firewall rules allow host port `9999`
- `curl` and `krn-search` available

## 1) Check status

```bash
krn-search searxng status
```

Expected:
- exit `0` when the JSON endpoint is ready
- non-zero with a concrete reason when not ready

## 2) Start local SearXNG

```bash
krn-search searxng up
```

What it does:
- reads the image-default settings from `/usr/local/searxng/searx/settings.yml`
- writes a user-owned patched `settings.yml` outside the repo (`$XDG_CACHE_HOME/krn-search/searxng` or `/tmp/krn-search-searxng-pnp-<uid>`)
- enables `search.formats: [html, json]`
- binds the service inside the container to `0.0.0.0:8080`, published on the host as `127.0.0.1:9999` only
- sets a non-default `server.secret_key`
- waits for:

```bash
SEARXNG_URL=http://localhost:9999 .venv/bin/python -m search_tool health --research --wait 30
```

If startup fails, inspect:

```bash
docker logs krn-search-searxng-smoke
```

## 3) Verify readiness directly

```bash
curl -i 'http://localhost:9999/search?q=test&format=json'
SEARXNG_URL=http://localhost:9999 .venv/bin/python -m search_tool health --research --wait 30
SEARXNG_URL=http://localhost:9999 .venv/bin/python -m search_tool health --research --json --wait 30
```

Do not treat the local path as ready until both checks pass:
- `curl` returns HTTP `200`
- `health --research` returns `ok`

## 4) Use with Claude Code research flow

The intended Claude Code path is:

```bash
krn-search searxng status || krn-search searxng up
krn-search search-query "<query>" --research
```

Example:

```bash
krn-search search-query "latest methodologies for creating AI agents" --research
```

If bootstrap fails, stop and report the limitation. Do not switch to WebSearch, `--provider static`, or a memory-only answer unless exact allowed URLs already exist and `KRN_SEARCH_ALLOW_EXACT_URLS=1` is intentional.

## 5) Stop local SearXNG

```bash
krn-search searxng down
```

This removes only `krn-search-searxng-smoke`. It does not prune unrelated Docker resources.

## Notes

- SearXNG is required for `--research` discovery, not for every command. Static provider remains an explicit known-URL/manual/test override.
- The old `docker cp "$cid:/etc/searxng/settings.yml"` recipe is stale for the current image. The working source path is `/usr/local/searxng/searx/settings.yml`.
- The bootstrap path deliberately writes config outside the repo to avoid root-owned repo artifacts such as `.tmp_searxng/`.
