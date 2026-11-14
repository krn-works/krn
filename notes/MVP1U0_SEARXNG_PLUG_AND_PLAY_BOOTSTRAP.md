# MVP-1U.0 — Plug-and-play SearXNG bootstrap for Claude Code research skill

## Goal

Make the Claude Code `/krn-search-research` flow operationally usable without a manual Docker recipe by adding a deterministic local SearXNG bootstrap/status path.

## Decision

`ACCEPT_CLAUDE_CODE_SEARCH_PLUGIN_BOOTSTRAP`

## Selected design

Chose **Option A**: main CLI subcommand.

New commands:

```bash
krn-search searxng status
krn-search searxng up
krn-search searxng down
```

Why this option:
- keeps the operator path discoverable under the same CLI used by the skill
- avoids a separate helper script bootstrap/install story
- stays small and testable by isolating Docker orchestration in a dedicated module (`search_tool/searxng.py`)
- lets Claude Code guidance point to one deterministic command family instead of prose-only runbook steps

## What changed

### CLI/operator path

- Added `search_tool/searxng.py`.
- Added `krn-search searxng status|up|down` in `search_tool/cli.py`.
- `status` probes the exact endpoint `http://localhost:9999/search?q=test&format=json`.
- `up`:
  - reads default settings from `/usr/local/searxng/searx/settings.yml`
  - patches `search.formats` to include `json`
  - patches `server.bind_address` to `0.0.0.0`
  - patches `server.port` to `8080`
  - patches `server.secret_key` to a non-default random value
  - writes config outside the repo in a user-owned runtime dir (`$XDG_CACHE_HOME/krn-search/searxng` or `/tmp/krn-search-searxng-pnp-<uid>`)
  - publishes the host port on `127.0.0.1:9999` only
  - starts container `krn-search-searxng-smoke`
  - waits for `health --research --wait 30`
  - reports `docker logs krn-search-searxng-smoke` on failure
- `down` removes only `krn-search-searxng-smoke`

### Claude Code surface

- Updated `.claude/commands/krn-search-research.md` to require:
  1. `krn-search searxng status`
  2. `krn-search searxng up` on failure
  3. `krn-search search-query "<query>" --research` only after readiness
- Updated `.claude/skills/krn-search-research/SKILL.md` with the same bootstrap-first flow.
- Updated packaged templates under `search_tool/templates/claude/...`.
- Updated `search_tool/bootstrap.py` contract/next-steps so `init-claude --with-hook` installs guidance aligned with the new bootstrap path.

### Docs

- Rewrote `docs/operations/searxng-local-runbook.md` around the built-in operator commands.
- Updated `README.md` SearXNG smoke section to stop recommending the stale manual recipe.

## Tests

Added deterministic coverage in `tests/test_searxng.py` for:
- `settings.yml` patching
- missing `formats` block insertion
- runtime dir selection
- unreachable status behavior
- `down` only targeting `krn-search-searxng-smoke`
- `up` writing patched config and starting the expected container
- `up` recreating an existing target container cleanly

Updated:
- `tests/test_init_claude.py` for template/bootstrap sync with `searxng status|up`

Existing hook tests remained green.

## Verification

### Static and test verification

- `git diff --check`
- `.venv/bin/python -m pytest tests/test_searxng.py -q` → `10 passed`
- `.venv/bin/python -m pytest tests/test_health.py -q` → `34 passed`
- `.venv/bin/python -m pytest tests/test_init_claude.py -q` → `35 passed`
- `.venv/bin/python -m pytest tests/test_candidate_url_static_guard.py tests/test_websearch_hook_guard.py -q` → `26 passed`
- `.venv/bin/python -m pytest -q` → `1084 passed`
- `.venv/bin/python -m search_tool eval-corpus tests/fixtures/search_corpus/basic.json` → `11/11`

### Live operator dogfood

Commands run:

```bash
docker rm -f krn-search-searxng-smoke || true
krn-search searxng up
krn-search searxng status
curl -i 'http://localhost:9999/search?q=test&format=json'
SEARXNG_URL=http://localhost:9999 .venv/bin/python -m search_tool health --research --wait 30
krn-search search-query 'najnowsze metodyki tworzenia agentów AI' --research
```

Observed:
- `krn-search searxng up` succeeded and reported readiness.
- `krn-search searxng status` returned ready on the exact JSON endpoint.
- `curl` returned HTTP `200` JSON.
- `health --research --wait 30` returned `ok`.
- `search-query --research` used `provider=searxng`, discovered `10` candidates, produced `9` successful evidence packs, `1` failed fetch (`OpenAI 403`), and wrote a compact summary.

## Bugs found during dogfood and fixed in-slice

1. **Root-owned stale `/tmp` dir blocked bootstrap**
   - Symptom: `PermissionError` writing `/tmp/krn-search-searxng-pnp/settings.yml`
   - Fix: fallback runtime dir now uses `/tmp/krn-search-searxng-pnp-<uid>`

2. **`status` timed out even when the endpoint was healthy**
   - Symptom: direct `curl` returned `200`, but `krn-search searxng status` failed
   - Fix: increased probe timeout to tolerate a slower first response

## Residual risk

- Headless `claude -p '/krn-search-research ...'` did not produce usable output in this environment and had to be terminated, so the final proof of the slash surface itself is still best done interactively in Claude Code.
- This does not block the operator bootstrap acceptance: the deterministic local backend path now exists, is test-covered, and works end-to-end via the same CLI that the slash flow calls.

## Non-goals preserved

- no public/native web fallback
- no LLM-generated URL candidates
- no browser automation
- no evidence/session schema changes
- no provider refactor
- no new Python dependencies
- no repo-local runtime artifacts committed

## Recommended next step

Use the updated `/krn-search-research` interactively in Claude Code with local SearXNG initially down, and confirm the bootstrap-first flow in the real UI. Only after real usage pain should the repo reopen source-quality work.
