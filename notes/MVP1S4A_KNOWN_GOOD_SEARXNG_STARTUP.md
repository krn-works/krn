# 2026-05-25 — MVP-1S.4a Known-good SearXNG Local Startup

## Decision

**ACCEPT_REACHABLE_SEARXNG_PATH**

## Goal

Validate a reproducible, local SearXNG startup path and prove `provider=auto` research flow from `krn-search` against a real, queryable endpoint.

## Scope

- Runtime dogfood only.
- No app code changes.
- No browser automation / no public/native web fallback / no LLM-generated candidates.
- Do not commit generated `.local/...` artifacts.

## Commands run and results

### A) Baseline reachability

- `.venv/bin/python -m search_tool health --research`
  - Exit code: `1`
  - Output: unreachable SearXNG at `http://localhost:9999`.

- `.venv/bin/python -m search_tool health --research --json`
  - Exit code: `1`
  - JSON: `overall: "fail"`, `checks[].name=="searxng_reachable"` status `fail`.

- `curl -i 'http://localhost:9999/search?q=test&format=json'`
  - Exit code: `7` when no container was running.

### B) Container experiments

Observed failures/notes:

- Mounting incomplete or permissioned config variants failed (`Invalid settings.yml`, connection reset during init), and default settings also required extra setup for reliable JSON output.
- `--rm` + `/etc/searxng-loader:ro` caused early startup / config write issues.
- Minimal `use_default_settings` overlay files were not stable in this environment.

### C) Known-good startup used

1. Capture default settings from image (for schema-safe local edit):

```bash
cid=$(docker create searxng/searxng:latest true)
docker cp "$cid:/etc/searxng/settings.yml" /tmp/krn-search-searxng-s4a-full/settings.yml
mkdir -p /tmp/krn-search-searxng-s4a-full
docker rm "$cid"
```

2. Enable JSON in that schema-valid file (host-side edit):

```bash
python3 - <<'PY'
from pathlib import Path
import yaml

p = Path('/tmp/krn-search-searxng-s4a-full/settings.yml')
config = yaml.safe_load(p.read_text())
config['search']['formats'] = ['html', 'json']
config['server']['bind_address'] = '0.0.0.0'
config['server']['port'] = 8080
p.write_text(yaml.safe_dump(config, sort_keys=False))
PY
```

3. Start container with full settings file mount:

```bash
docker run -d --name krn-search-searxng-smoke-s4a -v /tmp/krn-search-searxng-s4a-full:/etc/searxng -p 9999:8080 searxng/searxng:latest
```

4. Probe JSON endpoint:

```bash
curl -sS -o /tmp/s4a_final_json.txt -w '%{http_code}' 'http://localhost:9999/search?q=test&format=json'
# observed: exit 0, HTTP 200
```

5. Validate krn-search research mode against the endpoint:

```bash
SEARXNG_URL=http://localhost:9999 .venv/bin/python -m search_tool health --research
SEARXNG_URL=http://localhost:9999 .venv/bin/python -m search_tool health --research --json
SEARXNG_URL=http://localhost:9999 .venv/bin/python -m search_tool search-query "python requests documentation" --research --work-dir .local/krn-search-runs-s4a-dogfood --session "s4a reachable searxng"
```

Observed:

- `health --research`: exit `0`, `searxng_reachable` check status `ok`.
- `health --research --json`: exit `0`, `overall: "ok"`.
- `search-query --research`: exit `0`, `discovery.provider` became `searxng`, artifact tree under `.local/krn-search-runs-s4a-dogfood` created.

6. Cleanup:

```bash
docker rm -f krn-search-searxng-smoke-s4a
```

Cleanup executed in this dogfood run.

## Artifacts

- `.local/krn-search-runs-s4a-dogfood` generated during successful `search-query --research` probe.
- No tracked commits/staged runtime artifacts.

## Conclusion

A known-good local command path was found for this image/environment and the reachable `provider=auto` research path is accepted with `SEARXNG_URL=http://localhost:9999`.
