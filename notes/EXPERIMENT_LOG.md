# Experiment Log

## 2026-05-25 — MVP-1U.1 Interactive Claude Code search flow proof

**Goal:** close the remaining proof after MVP-1U.0 by validating the real `/krn-search-research` flow with SearXNG initially down.

**Scope:** docs-only follow-up. No code changes, no provider semantics changes, no prompt-hardening, no rerun of broad dogfood.

**Evidence recorded:**
- backend was stopped first via repo-local operator path:
  - `SEARXNG_URL=http://localhost:9999 .venv/bin/python -m search_tool searxng down`
- interactive Claude Code flow then ran:
  - `krn-search searxng status`
  - result: `connection refused`
  - `krn-search searxng up`
  - result: `SearXNG ready at http://localhost:9999`
  - `krn-search search-query "latest methodologies for creating AI agents" --research`
- search result used `provider=searxng`
- result produced:
  - `candidates_total=10`
  - `selected_for_fetch=10`
  - evidence packs
  - `compact_summary_path`
- Claude then read the compact summary and an Anthropic evidence pack
- answer path remained evidence-based; no memory-only fallback was observed

**Important caveat:**
- PATH-level `krn-search` on this machine was briefly older than repo-local code
- hard operator proof used repo-local `.venv/bin/python -m search_tool searxng down/up/status`
- this is a packaging/version-skew follow-up candidate, not a blocker

**Decision:** `ACCEPT_INTERACTIVE_CLAUDE_CODE_SEARCH_FLOW`

**Accepted contract reminder:**
- local SearXNG bootstrap/status/up remains part of the accepted flow
- no memory-only fallback is accepted
- evidence-pack behavior remains the contract

## 2026-05-25 — MVP-1U.0 Plug-and-play SearXNG bootstrap

**Goal:** make the Claude Code `/krn-search-research` flow operationally usable without a manual Docker recipe by adding a deterministic local SearXNG bootstrap/status path.

**Scope:** local operator/bootstrap path, CLI wiring, Claude Code command/skill/template sync, focused tests, and live operator dogfood. No public/native web fallback, no schema/provider refactor, no new Python dependencies.

**Selected design:** Option A — main CLI subcommand:

- `krn-search searxng status`
- `krn-search searxng up`
- `krn-search searxng down`

**What changed:**
- Added `search_tool/searxng.py` for isolated Docker/bootstrap logic.
- Added CLI subcommands in `search_tool/cli.py`.
- Updated `.claude/commands/krn-search-research.md` and `.claude/skills/krn-search-research/SKILL.md` to call bootstrap/status before `search-query --research`.
- Updated packaged Claude templates and `search_tool/bootstrap.py`.
- Rewrote `docs/operations/searxng-local-runbook.md` around the built-in operator commands.
- Updated `README.md` local SearXNG smoke section.

**Verification:**
- `.venv/bin/python -m pytest tests/test_searxng.py -q` -> `10 passed`
- `.venv/bin/python -m pytest tests/test_health.py -q` -> `34 passed`
- `.venv/bin/python -m pytest tests/test_init_claude.py -q` -> `35 passed`
- `.venv/bin/python -m pytest tests/test_candidate_url_static_guard.py tests/test_websearch_hook_guard.py -q` -> `26 passed`
- `.venv/bin/python -m pytest -q` -> `1084 passed`
- `.venv/bin/python -m search_tool eval-corpus tests/fixtures/search_corpus/basic.json` -> `11 passed`

**Live dogfood:**
- `docker rm -f krn-search-searxng-smoke || true`
- `krn-search searxng up` -> ready on `http://localhost:9999`
- `krn-search searxng status` -> exact JSON endpoint ready
- `curl -i 'http://localhost:9999/search?q=test&format=json'` -> HTTP `200`
- `SEARXNG_URL=http://localhost:9999 .venv/bin/python -m search_tool health --research --wait 30` -> `ok`
- `krn-search search-query 'najnowsze metodyki tworzenia agentów AI' --research` -> `provider=searxng`, `10` candidates, `9` successful evidence packs, `1` failed fetch (`403`)

**Bugs found and fixed during dogfood:**
- stale root-owned `/tmp/krn-search-searxng-pnp` blocked settings writes -> switched fallback runtime dir to `/tmp/krn-search-searxng-pnp-<uid>`
- `status` timed out against a healthy but slower endpoint -> increased status probe timeout

**Decision:** `ACCEPT_CLAUDE_CODE_SEARCH_PLUGIN_BOOTSTRAP`

**Residual risk:** headless `claude -p '/krn-search-research ...'` did not produce usable output in this environment and had to be terminated, so the final slash-surface proof should still be confirmed interactively in Claude Code.

## 2026-05-25 — MVP-1T.1 Controlled Search MVP Closeout

**Goal:** close out the controlled search MVP and decide whether the repository is good enough as a Claude Code `/search`-style evidence-pack tool.

**Scope:** docs-only; no code changes, no generated `.local` artifacts, no runtime dogfood rerun, no full pytest.

**What changed:**
- Created `notes/MVP1T1_CONTROLLED_SEARCH_MVP_CLOSEOUT.md`.
- Updated `notes/ACTIVE_TASK.md`, `notes/PROJECT_STATE.md`, and `CLAUDE.md`.

**Evidence carried forward:**
- T.0 decision `ACCEPT_CONTROLLED_SEARCH_DOGFOOD`.
- 3 live `provider=searxng` sessions.
- 10 candidates per session.
- 8-9 evidence packs per session.
- Summaries generated.
- S.6/T.0 baseline `1069/1069` tests and `11/11` eval-corpus.

**Decision:** `ACCEPT_CONTROLLED_SEARCH_MVP`

**Next recommended action:** `STOP_AND_USE` before further feature expansion; consider MVP-1U source quality/result filtering only after real usage pain.

## 2026-05-25 — MVP-1T.0 Real research dogfood acceptance

**Goal:** validate controlled `/search`-style evidence workflow after SearXNG readiness hardening.

**Scope:** docs/runtime checks + 3 dogfood sessions in `.local/krn-search-runs-t0-dogfood`, no provider behavior changes.

**Commands run:**

- `SEARXNG_URL=http://localhost:9999 .venv/bin/python -m search_tool health --research --wait 30`
- `SEARXNG_URL=http://localhost:9999 .venv/bin/python -m search_tool health --research --json --wait 30`
- `SEARXNG_URL=http://localhost:9999 .venv/bin/python -m search_tool search-query "Python requests documentation quickstart timeout session" --research --work-dir .local/krn-search-runs-t0-dogfood --session "t0 requests docs"`
- `SEARXNG_URL=http://localhost:9999 .venv/bin/python -m search_tool search-query "python request requests HTTP client library documentation" --research --work-dir .local/krn-search-runs-t0-dogfood --session "t0 package ambiguity"`
- `SEARXNG_URL=http://localhost:9999 .venv/bin/python -m search_tool search-query "SearXNG docker settings json format local development" --research --work-dir .local/krn-search-runs-t0-dogfood --session "t0 searxng runbook"`
- `.venv/bin/python -m search_tool session-summary --work-dir .local/krn-search-runs-t0-dogfood --session "t0 requests docs"`
- `.venv/bin/python -m search_tool session-summary --work-dir .local/krn-search-runs-t0-dogfood --session "t0 package ambiguity"`
- `.venv/bin/python -m search_tool session-summary --work-dir .local/krn-search-runs-t0-dogfood --session "t0 searxng runbook"`

**Observed outcome:**

- Health readiness (`--research --wait 30`) passed (`overall: ok`, exit `0`).
- All 3 sessions completed successfully with `provider=searxng`, exit `0`, and non-empty evidence packs.
- Session summaries generated for all 3 sessions and recorded in each session folder as `session-summary.md`.
- Evidence mix showed useful official/documentation content plus noisy/blocked candidates (`403` on some URLs).
- Follow-up focus remains source-quality refinement, not protocol-blocking behavior.

**Decision:** `ACCEPT_CONTROLLED_SEARCH_DOGFOOD`

**Artifacts:** `notes/MVP1T0_REAL_RESEARCH_DOGFOOD.md`; `.local/krn-search-runs-t0-dogfood/sessions/session-{47458029ceac,bf6388eb7f58,8f9eb1abc80a}/`

## 2026-05-25 — MVP-1S.6 SearXNG Readiness Hardening

**Goal:** improve operator readiness ergonomics before `search-query --research`.

**Scope:** small health-command hardening only. No provider semantics, search-query behavior, evidence/run/session schema, browser automation, public/native web fallback, Docker automation, or new dependencies.

**Selected design:** `krn-search health --research --wait <seconds>`.

**Why:** it extends the existing research preflight, keeps human and JSON health output on the same structure, and gives operators a deterministic readiness command without adding a new smoke subcommand.

**What changed:**
- `search_tool/health.py` — added `wait_for_searxng_reachable()` and optional `searxng_wait_seconds` for research health.
- `search_tool/cli.py` — added `health --wait <seconds>` and wires it to health checks.
- `tests/test_health.py` — added deterministic delayed-reachability, timeout, JSON, wait-zero, and override-plumbing coverage.
- `docs/operations/searxng-local-runbook.md` — readiness step now uses `health --research --wait 10` before direct query/search validation.
- `notes/MVP1S6_SEARXNG_READINESS_HARDENING.md` — implementation report.

**Verification:**
- `.venv/bin/python -m pytest tests/test_health.py -q` -> `34 passed`
- `.venv/bin/python -m pytest tests/test_research_mode.py -q` -> `22 passed`
- `.venv/bin/python -m pytest -q` -> `1069 passed`
- `.venv/bin/python -m search_tool eval-corpus tests/fixtures/search_corpus/basic.json` -> `11 passed`
- `git diff --check` -> clean
- `git status --short --branch` -> expected modified files only

## 2026-05-25 — MVP-1S Research-mode Resilience Closeout

**Goal:** Close the research-mode resilience slice with a single docs-only acceptance decision and current-state sync.

**Scope:** docs-only closeout, no code changes.

**Outcome:** `ACCEPT_MVP1S_RESEARCH_MODE_RESILIENCE`.

**Summary of slice acceptance:**

- S.0 design, S.1 provider-resolution discipline, S.2 health-required mode, S.3 unreachable dogfood, S.4 first-attempt status, and S.4a known-good startup were all accepted into one operator-resilience story.
- `SearXNG is required for research-mode discovery`, while still not required for every command.
- `--provider static --candidate-url` remains explicit/manual/test override only.
- No public/native web fallback and no LLM-generated URL candidates were introduced.
- No provider refactor, schema changes, database changes, browser automation, MCP, or dependency changes in S.5 closeout.

**Closeout proof artifacts referenced:**

- `notes/MVP1S_RESEARCH_MODE_RESILIENCE_CLOSEOUT.md`
- `notes/MVP1S0_SEARXNG_REQUIRED_RESEARCH_MODE_DESIGN.md`
- `notes/MVP1S1_RESEARCH_PROVIDER_RESOLUTION.md`
- `notes/MVP1S2_RESEARCH_HEALTH_CHECK.md`
- `notes/MVP1S3_RESEARCH_HEALTH_DOGFOOD.md`
- `notes/MVP1S4_REACHABLE_SEARXNG_DOGFOOD.md`
- `notes/MVP1S4A_KNOWN_GOOD_SEARXNG_STARTUP.md`
- `docs/operations/searxng-local-runbook.md`

**Follow-up candidates:** operator-hardening around readiness/retry/cleanup ergonomics (`MVP-1S.6` candidate).

## 2026-05-25 — MVP-1S.4a Known-good SearXNG startup and reachable research validation

**Goal:** find a working local SearXNG startup for research mode and validate `provider=auto --research` end-to-end.

**Scope:** runtime-only dogfood + docs/runbook updates, no code changes.

**Commands run (host):**

- `docker --version`
- `docker pull searxng/searxng:latest`
- `docker create + docker cp` to copy default `/etc/searxng/settings.yml` from image
- host-side Python edit of copied settings to set `search.formats: [html, json]` and bind/port (`0.0.0.0` / `8080`)
- `docker run -d --name krn-search-searxng-smoke-s4a -v /tmp/krn-search-searxng-s4a-full:/etc/searxng -p 9999:8080 searxng/searxng:latest`
- `curl 'http://localhost:9999/search?q=test&format=json'`
- `SEARXNG_URL=http://localhost:9999 .venv/bin/python -m search_tool health --research`
- `SEARXNG_URL=http://localhost:9999 .venv/bin/python -m search_tool health --research --json`
- `SEARXNG_URL=http://localhost:9999 .venv/bin/python -m search_tool search-query "python requests documentation" --research --work-dir .local/krn-search-runs-s4a-dogfood --session "s4a reachable searxng"`
- `docker rm -f krn-search-searxng-smoke-s4a`

**Observed behavior:**

- Baseline pre-check remained unreachable on first check (`exit=1`, overall fail in health JSON).
- Known-good local command path found by exporting schema-default settings, enabling JSON format in the same config file, and mounting as `/etc/searxng` (not `.../loader`, not read-only only).
- Endpoint became queryable: `curl /search?format=json` returned HTTP `200`.
- `health --research` exit `0`, `searxng_reachable` status `ok`.
- `health --research --json` exit `0`, `overall: "ok"`.
- `search-query --research` exit `0`, discovery provider became `searxng`, and session/run artifacts were created under `.local/krn-search-runs-s4a-dogfood`.

**Decision:** `ACCEPT_REACHABLE_SEARXNG_PATH`.

**Cleanup performed:** `docker rm -f krn-search-searxng-smoke-s4a` and temporary `/tmp/krn-search-searxng-s4a-full` settings workspace.

**Follow-up candidates:**

- Keep this startup recipe in docs/runbook and avoid the previous ro `/etc/searxng-loader` variants that fail in this host.
- Consider documenting an alternative prebuilt config package to avoid per-run manual edits.


## 2026-05-24 — MVP-1S.4 Reachable SearXNG Dogfood + Local Runbook

**Goal:** Validate reachable local SearXNG dogfood for research-mode `--research` path and produce a minimal local operator runbook.

**Scope:** Runtime dogfood + docs/runbook, no code changes unless blocker confirmed.

**Commands run:**

- `.venv/bin/python -m search_tool health --research`
- `.venv/bin/python -m search_tool health --research --json`
- Python TCP reachability probe to `127.0.0.1:9999`
- `docker --version`
- `docker run --rm -d --name krn-search-searxng-smoke-s4 -v /tmp/krn-search-searxng-smoke-s4:/etc/searxng:ro -p 9999:8080 searxng/searxng`
- `docker run --rm -d --name krn-search-searxng-smoke-s4 -v /tmp/searxng-config:/etc/searxng-loader:ro -p 9999:8080 searxng/searxng`
- `curl 'http://localhost:9999/search?q=test&format=json'` (repeated readiness attempts)

**Observed behaviors:**

- Default `health --research` without running SearXNG:
  - exit `1`, `overall: "fail"` in JSON.
- Local TCP probe confirmed `localhost:9999` was refused before startup attempts.
- First container attempt with `/etc/searxng` bind mount produced chown/read-only filesystem errors.
- Second attempt with `/etc/searxng-loader:ro` mounted produced repeated startup errors (connection reset / HTTP 403) and did not progress to a queryable search endpoint.
- Could not complete:
  - `SEARXNG_URL=http://localhost:9999 .venv/bin/python -m search_tool health --research --json`
  - `SEARXNG_URL=http://localhost:9999 .venv/bin/python -m search_tool search-query ... --research`
- No `.local/krn-search-runs-s4-dogfood` artifacts were finalized.
- Cleanup performed: killed hanging local process and removed smoke container.

**Decision:** `NEEDS_FIX` (reachable local `--research` path not accepted in this environment)

**Follow-up candidates:**

- Find/confirm a working local SearXNG startup command for this host image version.
- Keep runbook aligned with any required image args/volume behavior (readonly mount behavior may vary by image build).
- Retry S.4 reachable validation once endpoint is actually ready and test run artifact behavior again.

## 2026-05-24 — MVP-1S.3 Research Health Operator UX Dogfood

**Goal:** End-to-end operator dogfood for the S.2 research health behavior: required SearXNG in research mode, operator recovery, and override precedence.

**Scope:** Runtime dogfood only, no code changes unless hard blocker is found.

**Commands run:**

- `SEARXNG_URL=http://localhost:19999 .venv/bin/python -m search_tool health --research`
- `SEARXNG_URL=http://localhost:19999 .venv/bin/python -m search_tool health --research --json`
- `SEARXNG_URL=http://localhost:19999 .venv/bin/python -m search_tool search-query "python http client documentation" --research --work-dir .local/krn-search-runs-s3-dogfood`
- `.venv/bin/python -m search_tool search-query "python requests documentation" --research --provider static --candidate-url "https://requests.readthedocs.io/en/latest/" --work-dir .local/krn-search-runs-s3-dogfood --session "s3 known url override"`
- `.venv/bin/python -m search_tool health --research`
- `SEARXNG_URL=http://localhost:19999 .venv/bin/python -m search_tool health --research --searxng-url http://localhost:19998 --json`

**Observed behaviors:**
- `health --research` with unreachable SearXNG (`19999`) exits non-zero and marks SearXNG check as required failure.
- `health --research --json` reports `overall: "fail"`.
- `search-query --research` with unreachable SearXNG exits non-zero before fetch with recovery guidance to `krn-search health --research`.
- no run/session artifacts were created on provider-resolution failure.
- explicit `--provider static --candidate-url` succeeds and creates session/run artifacts under `.local/krn-search-runs-s3-dogfood`.
- default local health still points at `http://localhost:9999`, which is unreachable in this environment, so reachable-research query scenario was not exercised.
- `--searxng-url` overrides `SEARXNG_URL` and is reported as the URL source in JSON output.

**Result:** `ACCEPT_MVP1S3_RESEARCH_HEALTH_OPERATOR_UX`

## 2026-05-24 — MVP-1S.2 Research Health Check and Docs Sync

**Goal:** Add research-required health-mode to `krn-search health` and sync Claude/Codex research docs/templates.

**Scope:** CLI, health checks, health-mode docs/tests, and existing research recovery guidance sync; no schema, dependency, provider refactor, MCP/browser, database, or evidence-pack changes.

**What changed:**
- `search_tool/cli.py` — added `health --research` and `health --searxng-url`; passed research flag to health checks; updated SearXNG-unreachable recovery text/JSON to point to `health --research`.
- `search_tool/health.py` — `run_health_checks()` now accepts `research_mode` and `searxng_url_override`; unreachable SearXNG is `warn`/`info` unchanged outside research, and `fail` in research mode.
- `tests/test_health.py` — added deterministic health CLI coverage for research/non-research behavior, exit code, JSON status, and override precedence.
- `tests/test_research_mode.py` — updated recovery guidance assertions to `krn-search health --research`.
- `CLAUDE.md` / `notes/ACTIVE_TASK.md` / `notes/PROJECT_STATE.md` / `notes/MVP1S1_RESEARCH_PROVIDER_RESOLUTION.md` — docs/state sync.
- `.claude/commands/krn-search-research.md`, `search_tool/templates/claude/commands/krn-search-research.md`, `notes/MVP1S2_RESEARCH_HEALTH_CHECK.md` — health/research docs synchronized to required-mode distinction.

**Verification:** ✅ completed
- `.venv/bin/python -m pytest tests/test_health.py -q` → `27 passed in 34.99s`
- `.venv/bin/python -m pytest tests/test_research_mode.py -q` → `22 passed in 6.94s`
- `.venv/bin/python -m pytest -q` → `1062 passed in 101.15s`
- `.venv/bin/python -m search_tool eval-corpus tests/fixtures/search_corpus/basic.json` → `11 scenarios, 11 passed, 0 failed, 0 errors`
- `git diff --check` → clean
- `git status --short --branch` → expected modified files only

**Result:** `ACCEPT_MVP1S2_RESEARCH_HEALTH_CHECK`

## 2026-05-24 — MVP-1S.1 Post-Merge Docs Sync

**Goal:** Align startup/task/project documentation with PR #29 merged on `main`.

**Scope:** Docs-only.

**What changed:**
- `notes/ACTIVE_TASK.md` — updated to `MVP-1S.1 merged/accepted`, next option set to `MVP-1S.2`.
- `notes/PROJECT_STATE.md` — updated `Last updated`, baseline/HEAD (`fbabed9`), and S.1 merged wording.
- `CLAUDE.md` — refreshed baseline (`1057/1057`), S.1 acceptance note, and next-task pointer to `MVP-1S.2`.

**Verification:**
- `git diff --check` -> clean
- `git status --short --branch` -> clean on `main`

**Result:** `DOCS_SYNC_MVP1S1_POST_MERGE`

## 2026-05-24 — MVP-1S.1 Research Provider Resolution and Error UX

**Goal:** Implement the S.1 behavior: research-mode `--provider auto` resolves only to SearXNG and fails cleanly without fallback.

**Scope:** CLI/provider-resolution behavior and research-mode operator UX only. No evidence/run/session schema changes; no provider/network code refactor; no new dependencies.

**What changed:**
- `search_tool/cli.py` — made provider auto-resolution research-aware:
  - `--research --provider auto` and bare `--research` resolve only to SearXNG.
  - in research mode, `--candidate-url` no longer implies static fallback; it now errors with clear guidance to use `--provider static`.
  - unreachable SearXNG fails before query execution with explicit URL/source and no provider fallback.
  - added richer provider-resolution JSON (`stage=provider_resolution`, failure reason, limitations, recovery) while preserving top-level error shape.
  - updated discover-query handling to print structured auto-resolution failures.
- `tests/test_research_mode.py` — updated edge-case coverage for:
  - unreachable SearXNG under `--research` (and `--provider auto` variant),
  - `--research --candidate-url` guidance without explicit static,
  - explicit known-URL override remains operational,
  - non-research `--provider auto --candidate-url` behavior unchanged,
  - no run/session artifact creation on resolution failure.
- Added/updated notes:
  - `notes/ACTIVE_TASK.md` — status/narrative moved to S.1 implemented, next option set to S.2.
  - `notes/PROJECT_STATE.md` — current phase updated with S.1 outcome.
  - `notes/MVP1S1_RESEARCH_PROVIDER_RESOLUTION.md` — implementation report added.

**Verification (synchronous):**
- Deterministic provider-resolution tests in `tests/test_research_mode.py` pass with `check_searxng_reachable` mocked.
- `.venv/bin/python -m pytest -q` -> 1057 passed
- `.venv/bin/python -m search_tool eval-corpus tests/fixtures/search_corpus/basic.json` -> 11/11
- `.venv/bin/python -m pytest` -> 1057 passed (after session-artifact coverage test)
- `git diff --check` -> clean

**Result:** `ACCEPT_MVP1S1_RESEARCH_PROVIDER_RESOLUTION`



## 2026-05-24 — MVP-1S.0 SearXNG-Required Research Mode Design

**Goal:** Design the MVP-1S research-mode resilience layer for a SearXNG-required deployment.

**Scope:** Docs-only. No code changes, schema changes, dependency changes, evidence pack changes, database, browser automation, MCP, provider refactor, public search fallback, native WebSearch/WebFetch fallback, LLM-generated candidates, or AI synthesis.

**What changed:**
- `notes/MVP1S0_SEARXNG_REQUIRED_RESEARCH_MODE_DESIGN.md` — added selected behavior, rejected options, operator UX, exact error wording, deterministic test plan, S.1/S.2 implementation slices, risks, reversibility, and out-of-scope boundaries.
- `notes/ACTIVE_TASK.md` — marked S.0 design complete and set S.1/S.2 as next options.
- `notes/PROJECT_STATE.md` — recorded the SearXNG-required research-mode design state.
- `notes/EXPERIMENT_LOG.md` — added this S.0 record.

**Key design decisions:**
- `--research` with `provider=auto` should resolve only to SearXNG and fail clearly when the configured SearXNG endpoint is unreachable.
- `--research --candidate-url ...` without explicit `--provider static` should not silently switch to static.
- `--provider static --candidate-url ...` remains the explicit known-URL/manual/test override.
- Extend existing `krn-search health` with a research-required mode instead of adding a separate `doctor` command.

**Verification:**
- `git diff --check` -> clean
- `git status --short --branch` -> only expected docs files modified/untracked
- `git diff --name-only --cached` -> empty; no generated `.local/...` artifacts staged

**Result:** `DESIGN_MVP1S0_SEARXNG_REQUIRED_RESEARCH_MODE`

## 2026-05-24 — MVP-1R.5 Research Session Layer Closeout

**Goal:** Close the MVP-1R research session layer after R.0 through R.4.

**Scope:** Docs-only. No code changes, schema changes, dependency changes, provider/discovery/search-query changes, evidence pack changes, or AI synthesis.

**What changed:**
- `notes/MVP1R_RESEARCH_SESSION_LAYER_CLOSEOUT.md` — added closeout report covering implemented capabilities, verification baseline, dogfood findings, R.4 fix, known limitations, deferred candidates, and recommended next phase.
- `notes/ACTIVE_TASK.md` — marked MVP-1R accepted and set the next recommended option.
- `notes/PROJECT_STATE.md` — recorded accepted R-layer state and closeout report.
- `notes/EXPERIMENT_LOG.md` — added this R.5 record.

**Verification:**
- `git diff --check` -> clean
- `git status --short --branch` -> only expected docs files modified/untracked; no generated `.local/...` artifacts staged

**Result:** `ACCEPT_MVP1R_RESEARCH_SESSION_LAYER`

## 2026-05-23 — MVP-1R.4 Session Summary Run-History Counters

**Goal:** Fix session-summary run-history URL counters for dogfood-shaped run artifacts where explicit fetch counters are absent or zero but `evidence_results[]` exists.

**Scope:** Session summary only. No schema changes, new dependencies, provider/discovery/search-query changes, evidence pack changes, AI synthesis, relevance logic changes, or source snippet path-safety changes.

**What changed:**
- `search_tool/session_summary.py` — added mechanical counter fallback from `evidence_results[]` when explicit `fetch` counters are missing or zero.
- `tests/test_session_summary_complete.py` — added regression for zero fetch counters with successful/truncated/blocked evidence rows and rendered run-history markdown.
- `notes/MVP1R4_RUN_HISTORY_COUNTERS.md` — added implementation report.
- Updated `notes/PROJECT_STATE.md` and `notes/ACTIVE_TASK.md`.

**Verification:**
- `.venv/bin/python -m pytest tests/test_session_summary_complete.py::test_session_summary_run_history_derives_counts_from_evidence_results_when_fetch_counts_are_zero -q` -> 1 passed after failing before the fix
- `.venv/bin/python -m pytest tests/test_session_summary_complete.py -q` -> 16 passed
- `.venv/bin/python -m pytest -q` -> 1053 passed
- `.venv/bin/python -m search_tool eval-corpus tests/fixtures/search_corpus/basic.json` -> scenarios=11 passed=11 failed=0 errors=0
- `git diff --check` -> clean
- `git status --short --branch` -> only expected source/test/notes files modified; no generated `.local/...` artifacts staged

**Result:** `ACCEPT_MVP1R4_RUN_HISTORY_COUNTERS`

## 2026-05-22 — MVP-1R.3 Research Session Dogfood

**Goal:** Dogfood research sessions end to end using existing session metadata, session-summary, and source snippets flow.

**Scope:** Docs-only evaluation. No code changes, no dependencies, no schema changes, no provider refactor.

**What was run:**
- `krn-search search-query ... --research --session "mvp-1r3-dogfood-research-sessions" --work-dir ".local/krn-search-runs-r3-dogfood" --json` (run 1)
- `krn-search search-query ... --research --session "mvp-1r3-dogfood-research-sessions" --work-dir ".local/krn-search-runs-r3-dogfood" --json` (run 2)
- `krn-search session-summary --work-dir ".local/krn-search-runs-r3-dogfood" --session "mvp-1r3-dogfood-research-sessions"`

**Key observations:**
- Initial `--research` default path (`provider=auto`) failed in this environment because local SearXNG (`http://localhost:9999`) was unreachable.
- Dogfood completed with explicit override (`--provider static` + controlled `--candidate-url`).
- Session workflow worked end to end: single session created, two runs appended, `session-summary.md` generated with run history, unique sources, relevance, overlap, and snippets.
- Candidate issue: run-history URL counters in summary were zero in this scenario despite successful evidence results.

**Artifacts:**
- `.local/krn-search-runs-r3-dogfood/sessions/session-966dbe334942/session.yaml`
- `.local/krn-search-runs-r3-dogfood/sessions/session-966dbe334942/runs/*/search-run.json`
- `.local/krn-search-runs-r3-dogfood/sessions/session-966dbe334942/session-summary.md`
- `notes/MVP1R3_RESEARCH_SESSION_DOGFOOD.md`

**Result:** `ACCEPT_MVP1R3_DOGFOOD_WITH_CANDIDATES`

## 2026-05-22 — MVP-1R.2a Source Snippets for Session Summaries

**Goal:** Add mechanical source snippets to `krn-search session-summary` as the additive follow-up deferred from MVP-1R.2.

**Scope:** Session summary only. No AI synthesis, evidence schema changes, run manifest schema changes, session metadata schema changes, dependencies, provider refactors, database/MCP/hooks, or search-query behavior changes.

**What changed:**
- `search_tool/session_summary.py` — added `SESSION_SNIPPET_CHARS = 1000`, mechanical snippet extraction from existing `snippet`/`excerpt`/`content` fields, fallback extraction from recorded evidence pack paths constrained to the current run directory, Markdown table escaping, and a `## Source Snippets` table.
- `tests/test_session_summary_complete.py` — added tests for capped/sanitized snippets from run JSON, evidence pack fallback, missing snippet data rendering empty without crashing, absolute path rejection, and traversal rejection.
- `notes/MVP1R2A_SESSION_SUMMARY_SNIPPETS.md` — added implementation report.
- Updated `notes/PROJECT_STATE.md` and `notes/ACTIVE_TASK.md`.

**Verification so far:**
- `pytest -q` -> 1052 passed
- `python -m search_tool eval-corpus tests/fixtures/search_corpus/basic.json` -> 11/11
- `git diff --check` -> clean

**Next recommended action:** Review packet, then commit if accepted.

## 2026-05-22 — MVP-1R.1 Post-merge Docs Sync

**Goal:** Sync startup docs after PR #19 squash-merge so the repo opens on the accepted MVP-1R.1 state and the next task is unambiguous.

**Scope:** Docs-only. No code changes. No `search_tool/session.py`, `search_tool/cli.py`, or tests changes.

**Changes:**
- `CLAUDE.md` — refreshed current phase wording, R.1 report link, and R.2 next step
- `notes/ACTIVE_TASK.md` — kept MVP-1R.1 accepted, noted the R.1 report, preserved the R.2 recommendation, and marked calibration/relevance candidates unchanged
- `notes/PROJECT_STATE.md` — synced merged R.1 state, baseline `1037/1037` / `11/11`, and calibration/relevance status

**State:** MVP-1R.1 merged. Deterministic session ID and corrupted metadata recovery stay documented briefly. Baseline remains `1037/1037` tests and `11/11` eval-corpus. Next: MVP-1R.2 session summary.

**Verification:** docs-only sync pending commit/push at time of entry.

## 2026-05-22 — MVP-1R.1 Session Directory and Metadata

**Goal:** Implement session directory structure, session.yaml read/write/append, wiring into search-query, corrupted metadata recovery. First implementation slice of research session layer.

**Approach:** New `search_tool/session.py` module. `--session <topic>` flag on search-query. Deterministic session ID from topic hash (deviation from R.0 timestamp-hash design — documented rationale in report). Shared cache. Best-effort metadata writes. Additive `session` key in JSON output.

**Key decisions:**
1. Session ID: `session-<sha256(topic)[:12]>` (deterministic, same topic = same session). Rationale: agent-friendly, no state management burden.
2. Manual YAML serializer/parser (no PyYAML dependency). Single-pass left-to-right unescaping.
3. Recovery scans `search-run.json` from run directories, sets `status: "recovered"`, cannot recover topic.
4. Metadata writes are atomic via temp file + os.replace.

**Results:** 1032/1032 tests (993 baseline + 39 new), 11/11 eval-corpus. `diff --check` clean. No schema changes. No new dependencies.

**Files changed:** `search_tool/session.py` (new), `search_tool/cli.py` (+71 lines), `tests/test_session.py` (new), `notes/MVP1R1_SESSION_DIRECTORY_METADATA.md` (new), `notes/ACTIVE_TASK.md`, `notes/PROJECT_STATE.md`.

**Next recommended action:** MVP-1R.2 session summary (cross-run unique source table, snippets, statistics).

## 2026-05-22 — MVP-1R.0 Research Session Design

**Goal:** Design the research session layer that sits above existing krn-search capabilities to support multi-query, multi-source research workflows.

**Baseline:** 23693fd (main), 993/993 tests, 11/11 eval.

**Changes:**
- `docs/architecture/research-session-design.md` — New. Full architecture design for research session layer.
- `notes/MVP1R0_RESEARCH_SESSION_DESIGN.md` — New. Design memo with decisions, staging, alternatives.
- `notes/ACTIVE_TASK.md` — Updated to R.0 complete, next option: MVP-1R.1.
- `notes/PROJECT_STATE.md` — Synced with R.0 design completion.

**Key design decisions:**
- Session is a directory of runs with metadata (session.yaml), not a database
- Agent drives strategy; session observes and reports (no AI recommendations)
- Cross-run dedup is observational (reports overlap, doesn't block re-fetch)
- Best relevance per source across runs (not average)
- Shared cache (not session-scoped)
- Session metadata is best-effort (failed writes don't block runs)
- Session summary is mechanical aggregation (same philosophy as compact summary)

**Staged plan:** R.1 (session dir + metadata), R.2 (session summary), R.3 (dogfood).

**Verification:** 993/993 tests, 11/11 eval (unchanged). No code changes.

## 2026-05-22 — MVP-1Q.5 Relevance Layer Closeout

**Goal:** Close the MVP-1Q relevance layer as an accepted project phase. Summarize Q.0–Q.4, document accepted capabilities and known limitations, defer calibration candidates, recommend MVP-1R.0 next.

**Baseline:** c302f5b (main), 993/993 tests, 11/11 eval.

**Changes:**
- `notes/MVP1Q_RELEVANCE_LAYER_CLOSEOUT.md` — New. Layer summary, accepted capabilities, known limitations, deferred candidates, next phase recommendation.
- `notes/ACTIVE_TASK.md` — Updated to Q.5 complete, next option: MVP-1R.0.
- `notes/PROJECT_STATE.md` — Synced HEAD to c302f5b, added Q.4/Q.5 completion, updated phase description.
- `CLAUDE.md` — Phase description updated to Q complete.

**Key decision:** No immediate weight tuning. Calibration candidates remain in DECISION_CANDIDATES.md for future evidence-driven action.

**Verification:** 993/993 tests, 11/11 eval (unchanged).

## 2026-05-22 — MVP-1Q.4 Relevance Dogfood/Calibration

**Goal:** Run real queries through scoring pipeline, record scores alongside manual usefulness, identify false-high/false-low cases, document calibration recommendations.

**Baseline:** f2db444 (main), 993/993 tests, 11/11 eval.

**Method:** 6 dogfood scenarios with static provider (SearXNG unavailable). Each query tested 2 candidate URLs covering different relevance patterns. Recorded candidate relevance, evidence relevance, and compact visibility for 12 total source evaluations.

**Key findings:**
- False-low: Official docs undersold vs blog/tutorial content (asyncio official 47% vs RealPython 57%)
- False-high: urllib outscores requests docs for "requests library" query (66% vs 60%) due to token overlap
- Minor false-high: Irrelevant official docs get +0.1 modifier at 0% base (Python docs for Rust query = 10%)
- SEO penalty works but may be insufficient for exact-phrase listings
- Evidence relevance scores cluster in 30-65% range for useful content; interpretation guide's 0.6-0.8 and 0.8-1.0 bands rarely achievable

**Correct behaviors confirmed:** SPA empty content scores 0%, Polish diacritics preserved, SEO penalty applied, complete mismatch correctly discriminated, deterministic scores, compact visibility displays correctly.

**Code changes:** None. Evaluation only.

**Verification:** 993/993 tests, 11/11 eval (unchanged).

## 2026-05-22 — MVP-1Q.3 Compact Summary Relevance Visibility

**Goal:** Add relevance column to compact evidence index. Visibility-only, no behavior changes.

**Baseline:** 0f0b2d7 (main), 984/984 tests, 11/11 eval.

**Changes:**
- `search_tool/compact.py` — Added `relevance_score: float` to `SourceEntry`; built `relevance_map` from `result.evidence_relevance` in `_build_source_entries()`; added `Relevance` column to source table header and rows with percentage display (e.g. `72%`); fallback `0%` when no evidence relevance metadata
- `tests/test_compact_summary.py` — Added `TestRelevanceVisibility` class with 9 tests: score on SourceEntry, zero fallback, zero for failed fetch, column header, percentage display (72%, 0%, 100%), final_url mapping, no ordering change with relevance

**Key design:**
- Visibility-only: relevance scores displayed but never used for sorting or filtering
- URL mapping: `relevance_map` keyed by `EvidenceRelevanceEntry.url`, lookup by `r.final_url or r.normalized_url`
- Compact summary shows only percentage — full components remain in CLI JSON and search-run manifest
- No JSON/manifest/evidence pack/discovery diagnostics changes

**Verification:** 993/993 tests, 11/11 eval. PR #14 squash-merged. No behavior changes.

## 2026-05-21 — MVP-1Q.2 Evidence Relevance Metadata

**Goal:** Implement deterministic evidence-level relevance scoring as query-run metadata. Metadata-only, no behavior changes.

**Baseline:** 077743e (main), 959/959 tests, 11/11 eval.

**Changes:**
- `search_tool/relevance.py` — `EvidenceComponents`, `EvidenceRelevance` dataclasses; `_extract_text_and_headings()`, `_compute_content_density()` (lazy import of `_NAV_CHROME_LINES` from `compact.py` to avoid circular import), `score_evidence_relevance()`
- `search_tool/search.py` — `EvidenceRelevanceEntry` dataclass; `evidence_relevance` field on `SearchRunResult`; evidence relevance computation in `search_query()`; lightweight `evidence_relevance` section in `write_search_run_manifest()` YAML (url + score only)
- `search_tool/cli.py` — `evidence_relevance` array with full component details in JSON output
- `tests/test_relevance.py` — 25 new tests

**Key design:**
- Query-run metadata only — NOT evidence pack frontmatter
- Manifest YAML lightweight: url + score per entry
- Full component details in CLI JSON and SearchRunResult
- `extraction_status="truncated"` is scoreable (contains usable content)
- Failed/blocked/skipped/failed extraction returns 0.0
- Scoring: 0.30*text_overlap + 0.15*heading_match + 0.25*early_content_overlap + 0.10*content_density + 0.20*exact_phrase_bonus
- Low content penalty: -0.20 if text < 200 chars or content density < 0.3

**Verification:** 984/984 tests, 11/11 eval. PR #12 squash-merged. No behavior changes.

## 2026-05-21 — MVP-1Q.1 Candidate Relevance Metadata

**Goal:** Implement deterministic candidate relevance scoring. Metadata-only, no behavior changes.

**Baseline:** 4475087 (main), 925/925 tests, 11/11 eval.

**Changes:**
- `search_tool/relevance.py` (new, ~170 lines) — `tokenize_query()`, `score_candidate_relevance()`, `QueryTokens`, `CandidateComponents`, `CandidateRelevance` dataclasses, `STOP_WORDS`, `_text_tokens()` (whole-token matching), `_token_overlap()`, `_source_quality_modifier()`, `_generic_page_penalty()`
- `search_tool/search.py` — imported `tokenize_query`, `score_candidate_relevance`; added `candidate_relevance` to each `selected_candidates[]` entry in `write_discovery_diagnostics()` (~15 lines)
- `tests/test_relevance.py` (new, 34 tests) — 10 tokenization, 21 candidate scoring, 3 diagnostics integration
- `notes/MVP1Q1_CANDIDATE_RELEVANCE.md` (new) — implementation report

**Key design:** Whole-token matching via `_text_tokens()` using `re.compile(r"[^\W_]+", re.UNICODE)` to tokenize haystack into a frozenset. Prevents short tokens like AI/UI/JS/WP from matching inside unrelated words (e.g., "ai" inside "main"). Scoring formula: 0.40*title_overlap + 0.25*snippet_overlap + 0.15*url_path_overlap + 0.20*exact_phrase_bonus, clamped [0.0, 1.0]. Source quality modifier: SEO=-0.20, forum+low_auth=-0.10, official=+0.10. Generic page penalty: listing titles, generic path segments, empty snippet (largest applies, not cumulative).

**Verification:**
- Tests: 959/959 (925 baseline + 34 new)
- Eval-corpus: 11/11
- `git diff --check`: clean
- PR #10 squash-merged to main at `a2e3950`

**No behavior changes.** No evidence relevance. No compact changes. No manifest changes. No new dependencies. No LLM.

---

## 2026-05-21 — MVP-1P.2a Handoff Artifact Location Fix

**Goal:** Change handoff output from OS temp dir to `.local/krn-search-handoffs/` (gitignored, uncommitted).

**Baseline:** db52aff (main), 925/925 tests, 11/11 eval.

**Changes:**
- `.claude/skills/krn-search-handoff/SKILL.md` — default to `.local/krn-search-handoffs/`, OS temp as fallback
- `search_tool/templates/claude/skills/krn-search-handoff/SKILL.md` — template mirror synced
- `tests/test_init_claude.py` — updated assertions: `.local/krn-search-handoffs`, `Do not create committed notes`
- `notes/MVP1P2_WORKFLOW_SKILLS.md` — updated handoff description
- `notes/EXPERIMENT_LOG.md` — this entry

**Verification:**
- Tests: 925/925
- Eval-corpus: 11/11 (no runtime changes)
- No runtime search changes

---

## 2026-05-21 — MVP-1P.2 Workflow Skills

**Goal:** Add three Claude Code workflow skills: diagnose, design-grill, handoff.

**Baseline:** 4e1ad9f (main), 922/922 tests, 11/11 eval.

**Changes:**
- `.claude/skills/krn-search-diagnose/SKILL.md` (new) — bug diagnostic workflow with deterministic feedback loop
- `.claude/skills/krn-search-design-grill/SKILL.md` (new) — design-only workflow, no code
- `.claude/skills/krn-search-handoff/SKILL.md` (new) — session handoff to `.local/krn-search-handoffs/`
- `search_tool/templates/claude/skills/krn-search-diagnose/SKILL.md` (new) — template mirror
- `search_tool/templates/claude/skills/krn-search-design-grill/SKILL.md` (new) — template mirror
- `search_tool/templates/claude/skills/krn-search-handoff/SKILL.md` (new) — template mirror
- `search_tool/bootstrap.py` — added 3 new template constants, updated MANAGED_FILES and mappings
- `tests/test_init_claude.py` — updated file counts, added TestInitClaudeWorkflowSkills (3 tests)
- `notes/ACTIVE_TASK.md` — updated
- `notes/EXPERIMENT_LOG.md` — this entry
- `notes/MVP1P2_WORKFLOW_SKILLS.md` (new) — implementation report

**Verification:**
- Tests: 925/925 (922 baseline + 3 new)
- Eval-corpus: 11/11
- `git diff --check`: clean
- No runtime changes, no hooks, no git guardrails, no MVP-1Q.1

---

## 2026-05-21 — MVP-1Q.0 Deterministic Relevance Scoring Design

**Goal:** Design deterministic, non-LLM relevance scoring for krn-search. Docs-only, no code.

**Baseline:** 10ad004 (main), 922/922 tests, 11/11 eval.

**Changes:**
- `docs/architecture/deterministic-relevance-scoring.md` (new) — full design document
- `notes/MVP1Q0_RELEVANCE_SCORING_DESIGN.md` (new) — design report
- `notes/ACTIVE_TASK.md` — updated status to MVP-1Q.0 complete, next is MVP-1Q.1
- `notes/EXPERIMENT_LOG.md` — this entry

**Design:**
- Two relevance signals: candidate (pre-fetch) and evidence (post-fetch)
- Query tokenization: whitespace split, lowercase, English stop words, diacritics preserved
- Candidate scoring: title/snippet/URL path overlap + source quality modifier + generic page penalty
- Evidence scoring: text/heading/early-content overlap + content density + low-content penalty
- Score range: 0.0–1.0 per component, weighted combination
- Output: discovery-diagnostics.json, search-run manifest, compact summary
- New module: `search_tool/relevance.py`
- Metadata-only: no behavior changes to discovery, fetch, extraction, or ordering
- Staged: Q.1 candidate, Q.2 evidence, Q.3 compact, Q.4 dogfood

**Verification:**
- Docs-only, no tests required
- `git diff --check`: clean
- Stop condition checks: no implementation code, no LLM, no ranking changes

---

## 2026-05-21 — MVP-1P.1 Discovery Diagnostics Artifact

**Goal:** Add a structured JSON diagnostics artifact alongside search evidence that records discovery-stage accounting: raw candidate counts, selected/blocked/duplicate breakdown, selected candidate metadata with source quality, discovery errors, and limitations.

**Baseline:** 7333e4d (main), 902/902 tests, 11/11 eval.

**Changes:**
- `search_tool/search.py` — added `write_discovery_diagnostics()`, added `discovery_diagnostics_path: Path | None = None` to `SearchRunResult`, diagnostics writer called from `search_query()` when `evidence_dir` is available
- `search_tool/cli.py` — added `discovery_diagnostics_path` to JSON output (`_print_search_result_json`)
- `tests/test_discovery_diagnostics.py` (new) — 20 tests: writer output structure, counts, blocked/duplicate/selected entries, source quality on selected candidates, error/limitation recording, secret redaction, empty discovery, dir creation, integration with `search_query` (with/without evidence_dir, empty URLs, writer failure), URL credential redaction for blocked/selected/duplicate candidates
- `notes/ACTIVE_TASK.md` — updated
- `notes/EXPERIMENT_LOG.md` — this entry
- `notes/MVP1P1_DISCOVERY_DIAGNOSTICS.md` (new) — implementation report

**Design:**
- Diagnostics written to `evidence_dir / "discovery-diagnostics.json"` — single flat file
- Only written when `evidence_dir` is available (same condition as other artifacts)
- No provider refactoring — reads from existing `DiscoveryResult` data
- No relevance scoring. No LLM. Pure mechanical accounting.
- Source quality computed for selected candidates via `classify_source_quality()`

**Verification:**
- Tests: 922/922 (902 baseline + 20 new)
- Eval-corpus: 11/11
- `git diff --check`: clean
- No new dependencies. No behavior changes to fetch/extraction.

---

## 2026-05-21 — MVP-1P Docs-only Architecture Note

**Goal:** Document the architectural distinction between search and research in krn-search. Record the dogfood finding that technically valid evidence can be low-usefulness. Set MVP-1P.1 as next implementation candidate.

**Baseline:** 1936761 (main), 890/890 tests, 11/11 eval.

**Changes:**
- `docs/architecture/search-vs-research.md` (new) — search vs research definition, current capabilities table, failure mode documentation, non-goals, staged roadmap (MVP-1P.1, MVP-1Q, MVP-1R, later)
- `notes/ACTIVE_TASK.md` — added MVP-1P to last completed, added MVP-1P.1 as next implementation candidate (not yet implemented)
- `notes/EXPERIMENT_LOG.md` — this entry

**Dogfood finding:** Real-world queries often produce technically valid but low-usefulness evidence because the current pipeline measures fetch/extraction success, not source usefulness or research relevance. A query about "building AI coding-agent operating systems" returns successful fetches from official docs pages, but the pages are tangential rather than directly relevant. This is the central gap between search and research.

**Verification:**
- Tests: 890/890 (unchanged)
- Eval-corpus: 11/11 (unchanged)
- `git diff --check`: clean
- No code changes. No new dependencies. No behavior changes.

**Docs-only commit.**

---

## 2026-05-19 — MVP-1O.1 Duplicate `_run_fetch_list` Cleanup

**Goal:** Remove dead duplicate `_run_fetch_list` definition and orphaned `write_fetch_list_manifest` body from `search_tool/cli.py`.

**Baseline:** fc448a003a83acf21baf4aeb8e23104ae6a5ae4e, 890/890 tests.

**Changes:**
- `search_tool/cli.py` — removed dead duplicate `_run_fetch_list` (lines 276-304) + orphaned manifest-writing body (lines 306-397) + blank separator
- `notes/MVP1O1_DUPLICATE_FETCH_LIST_CLEANUP.md` (new) — diagnosis and report
- `notes/PROJECT_STATE.md` — updated phase to MVP-1O
- `notes/ACTIVE_TASK.md` — marked MVP-1O.1 complete
- `notes/EXPERIMENT_LOG.md` — this entry

**Diagnosis:** Two `_run_fetch_list` definitions existed. First (line 276) was dead code followed by `return 0`, making its following orphaned `write_fetch_list_manifest` body unreachable. Second (line 400) was the active definition used by the CLI call site. Identical body.

**Verification:**
- Tests: 890/890
- Eval-corpus: 11/11
- Compile: OK
- Whitespace: OK
- No generated artifacts tracked

**No behavior changes.** Dead-code removal only.

---

## 2026-05-19 — MVP-1N.1 Release / Docs Summary

**Goal:** Create a concise release/docs summary of the completed portable research kit improvements: llms.txt provider, URL aliases, canonical dedup, final_url dedup, init-claude bootstrap.

**Baseline:** b06f6ca69cbd02ef9a88b8e2ff135c189d85401c, 890/890 tests.

**Changes:**
- `notes/MVP1N1_RELEASE_SUMMARY.md` (new) — release summary covering init-claude, llms provider, canonical dedup, final_url dedup (mark-only, metadata, skip, bugfixes, hygiene), JSON/manifest/compact/eval consistency
- `notes/PROJECT_STATE.md` — updated phase to MVP-1N
- `notes/ACTIVE_TASK.md` — marked MVP-1N.1 complete, added to last completed
- `notes/EXPERIMENT_LOG.md` — this entry

**Verification:**
- Tests: 890/890
- Eval-corpus: 11/11
- Compile: OK
- Whitespace: OK
- No generated artifacts tracked

**No behavior changes.** Docs-only commit.

---

## 2026-05-19 — MVP-1M.8 Final Dedup Hygiene Cleanup

**Goal:** Clean up dead-code/hygiene issues left from final_url dedup implementation without changing behavior.

**Baseline:** 3dc9c7592d7d33aa647f66c4ea2325aa7bbcf480, 890/890 tests.

**Cleanup performed:**
1. Removed unused `policy`, `refresh`, `evidence_dir` parameters from `_maybe_skip_duplicate()` signature in `search_tool/run.py` and both call sites (lines 108-118, 194-204). Parameters were never read in the function body.
2. Replaced unused `kept_idx` unpacked variable with `_` in `search_query()` dedup loop in `search_tool/search.py:345`.

**Tests:** 890/890. Eval: 11/11. Compile: OK. Whitespace: OK.

**No behavior changes.**

**Out of scope:** Duplicate `_run_fetch_list` in `cli.py` (pre-existing dead code from May 2026, not introduced by M-line dedup work).

---

## 2026-05-19 — MVP-1M.7b Final Dedup Regression Dogfood

**Goal:** Verify complete dedup line (canonical candidate dedup → final_url mark-only → dedup metadata → skipped_duplicate extraction skip → non-redirect fallback fix) across controlled regression matrix.

**Baseline:** 83da4170fe747c0c4ec9584aae147fc6a55723d0, 890/890 tests.

**Bug found:** Compact writer duplicated limitations by concatenating `result.limitations` with `result.discovery.limitations` (both already contained discovery limitations). "Query redaction is best-effort..." appeared twice in compact output.

**Fix:**
- `search_tool/compact.py`: Use `list(result.limitations)` only — same pattern as manifest fix in M.7a.
- `tests/test_compact_summary.py`: Updated `test_contains_limitations` to pass discovery limitations through `result.limitations` (matching real `search_query()` behavior).

**Regression matrix:** A (candidate canonical dedup) PASS. B (redirect→direct) PASS. C (direct→redirect) PASS. D (trailing slash) PASS (candidate dedup handled). E (follow_redirects=False) PASS. F (JSON vs manifest) PASS. G (compact output) PASS. H (evidence pack count) PASS. I (eval-corpus) PASS.

**Tests:** 890/890. Eval: 11/11. Compile: OK. Whitespace: OK.

---

## 2026-05-19 — MVP-1M.7a Final URL Skip Dogfood Bugfix

**Goal:** Verify skip extraction with real redirect pairs; catch runtime bugs.

**Baseline:** 650442c784213cc731737cae95e4d2fe659bed25, 890/890 tests.

**Bug found:** final_url dedup skip did not fire for non-redirected URLs. Test: `httpbin.org/redirect-to?url=/get` (redirects → success) + `httpbin.org/get` (direct → success, expected `skipped_duplicate`). Root cause: `final_url_override` was only set when `fetch_result.redirects` was non-empty. When no redirects, it stayed `None`, causing `_maybe_skip_duplicate()` to return early.

**Fix:**
- `search_tool/run.py`: Added `elif follow_redirects and not fetch_result.redirects: final_url_override = normalized` in both cache-hit and network-miss paths.
- `search_tool/search.py`: Moved post-processing before manifest writes; added `limitations` parameter to `write_search_run_manifest()`.

**Tests:** 890/890. Eval: 11/11. Compile: OK. Whitespace: OK.

---

## 2026-05-19 — MVP-1M.7 Skip Duplicate Extraction

**Goal:** Implement skip stage for final_url dedup. When a fetched URL's final_url is already known, skip extraction and evidence writing.

**Baseline:** f55cc3d61c8a453515a6278256ddd167490b8540, 876/876 tests pass, 11/11 eval-corpus.

**Changes:**
- `search_tool/run.py`: Added `_final_url_dedup_registry` param to `fetch_url_to_evidence()`. Added `_maybe_skip_duplicate()` and `_maybe_register_final_url()` helpers. Added `skipped` counter to `write_fetch_list_manifest()`.
- `search_tool/search.py`: Built dedup registry before fetch loop. Passed to fetcher. M.6 post-processing for fake fetchers. Limitation wording changed from "Detected" to "Skipped" (when actual skips). Added `fetch_skipped` counter.
- `search_tool/cli.py`: JSON status: `succeeded + skipped == total` → "ok". Skipped_duplicate included in evidence_results (not failures).
- `search_tool/eval_corpus.py`: Added `actual_skipped` and `skipped_duplicates` eval check.
- 14 new tests.

**Tests:** 890/890 (876 existing + 14 new). Eval: 11/11. Compile: OK. Whitespace: OK.

## 2026-05-19 — MVP-1M.6a Final URL Duplicate Metadata Dogfood

**Goal:** Dogfood the final_url duplicate reference metadata from MVP-1M.6 and verify duplicates are marked correctly with mark-only behavior.

**Baseline:** 6324cf2f2feebf10f3df8d413df29b69182bb1b5, 876/876 tests pass, 11/11 eval-corpus.

| Scenario | Expected | Got | Verdict |
|----------|----------|-----|---------|
| A: Two results, same final_url | first unique, second duplicate, count unchanged | All assertions pass | PASS |
| B: Three results, same final_url | first unique, second+third duplicate, both reference first | All assertions pass | PASS |
| C: Tracking-param final_url | second collapsed to first | UTM removal canonicalizes correctly | PASS |
| D: Failed/blocked excluded | dedup_status=unique, duplicate_of_*=None | fetch_status guard works | PASS |
| E: No-final-url | all unique, no false refs | final_url=None guard works | PASS |
| F: JSON surface | backward compat, no schema break | Frozen dataclass defaults work | PASS |

**Verdict:** ACCEPT_DEDUP_METADATA. No fixes needed. Docs-only commit.

## 2026-05-18 — MVP-1M.2a Canonical Candidate Dedup Dogfood

**Goal:** Dogfood the new candidate-level canonical URL dedup from MVP-1M.2 and verify it improves noise without collapsing useful distinct results.

**Baseline:** 41a48c1722a7cdfd45758045f9855274b3c7286f, 845/845 tests pass, 11/11 eval-corpus.

**Static synthetic dogfood:** 10 cases via `static_provider()`:

| # | Case | Expected | Got | Verdict |
|---|------|----------|-----|---------|
| A | Tracking params collapse | 1 | 1, `Collapsed 2` | PASS |
| B | Meaningful params preserved | 3 | 3 | PASS |
| C | Fragment/trailing slash collapse | 1 | 1, `Collapsed 2` | PASS |
| D | Path case preserved | 2 | 2 | PASS |
| E | Tracking+meaningful same value | 1 | 1, `Collapsed 1` | PASS |
| F | Tracking+meaningful diff value | 2 | 2 | PASS |
| G | Default port (443) | 1 | 1, `Collapsed 1` | PASS |
| H | Non-default port (8443) | 2 | 2 | PASS |
| I | Duplicate slashes | 1 | 1, `Collapsed 1` | PASS |
| J | ref/source/via distinct | 3 | 3 | PASS |

**LLMS real dogfood:**

| Target | Candidates | Sources | Duplicates | Quality | Verdict |
|--------|-----------|---------|-----------|---------|---------|
| Claude Code (hooks skills commands) | 10 | 10 | 0 | official_docs, 72KB content | PASS |
| Pydantic (validation models) | 10 | 10 | 0 | official_docs, 64KB content | PASS |

Both sources well-organized with unique URLs — no duplicates to collapse. Evidence quality matches L.4 benchmarks. No false collapses.

**Acceptance verdict:** ACCEPT_CANONICAL_DEDUP. All static cases pass. Real LLMS cases stay useful.

**Fixes made:** None. Implementation verified correct.

**Files changed:** `notes/MVP1M2A_CANONICAL_DEDUP_DOGFOOD.md` (new), `notes/PROJECT_STATE.md`, `notes/ACTIVE_TASK.md`, `notes/EXPERIMENT_LOG.md`.

**Commands run:**
- `pytest tests/ -v` (845/845 pass)
- `eval-corpus` (11/11 pass)
- `py_compile` (clean)
- `git diff --check` (clean)
- Static synthetic dogfood via `static_provider()` — 10/10 cases pass
- `search-query --provider llms` — 2 real targets tested

**Next recommended task:** MVP-1M.3 — Fetch-aware redirect/final_url dedup.

---

## 2026-05-19 — MVP-1M.4a Mark-only final_url dedup dogfood

**Goal:** Dogfood MVP-1M.4 mark-only final_url dedup visibility. Verify real or mocked redirect-equivalent URLs produce the expected limitation without skipping extraction.

**Baseline commit:** `c34ee9e6b98411470acf701d18b6546f9123222d`

**Baseline gate:**
- 868/868 tests pass
- 11/11 eval-corpus pass
- Compile: OK
- Whitespace: OK
- Working tree clean

**Controlled mocked dogfood:**

| # | Scenario | Expected Results | Expected Dedup | Got Results | Got Dedup | Verdict |
|---|----------|-----------------|----------------|-------------|-----------|---------|
| A | Same final_url, different originals | 2 | 1 | 2 | 1 | PASS |
| B | Tracking params only | 2 | 1 | 2 | 1 | PASS |
| C | Trailing slash / fragment | 2 | 1 | 2 | 1 | PASS |
| D | Failed fetch excluded | 2 | 0 | 2 | 0 | PASS |
| E | No final_url (no redirects) | 2 | 0 | 2 | 0 | PASS |

**Wording:** Uses "Detected" (not "Collapsed"/"Skipped").

**Evidence count:** Unchanged (2 in all scenarios).

**Fetch/extraction statuses:** Unchanged (all "success").

**Limitation order:** Discovery limitations before dedup limitation (correct).

**Live smoke:** Skipped — all logic is post-fetch registry with 23 controlled tests.

**Acceptance verdict:** ACCEPT_FINAL_URL_MARK_ONLY

**Fixes made:** None. Implementation verified correct.

**Files changed:** `notes/MVP1M4A_FINAL_URL_DEDUP_DOGFOOD.md` (new), `notes/PROJECT_STATE.md`, `notes/ACTIVE_TASK.md`, `notes/EXPERIMENT_LOG.md`.

---

## 2026-05-19 — MVP-1M.5 Skip/extract dedup design

**Goal:** Design the next step after mark-only final_url dedup: safely skipping duplicate extraction/evidence writing when a fetched URL redirects to a final_url already processed.

**Baseline commit:** `a3468542d5b6350851464103986fb1902c1f3ca0`

**Baseline gate:**
- 868/868 tests pass
- 11/11 eval-corpus pass
- Compile: OK
- Whitespace: OK
- Working tree clean

**Architecture analysis:**
- `fetch_url_to_evidence()` is a single atomic function (fetch → extract → write).
- `final_url` is known after fetch, before extraction.
- Dedup registry currently lives in `search_query()` after the fetch loop.
- To skip before extraction, registry must be passed into the fetcher or pipeline split.

**Options evaluated:**
| Option | Description | Risk | Recommended |
|--------|------------|------|-------------|
| A | Keep M.4 mark-only forever | Lowest | No — wasted signal |
| B | Split fetch/extract, dedup between phases | Medium | Yes — for MVP-1M.7 |
| C | Write evidence, then delete duplicates | Medium | No — wasteful |
| D | Post-write synthetic result mutation | Low-Medium | No — frozen dataclass issue |
| E | Two-phase pipeline | High | Too big for MVP |
| F | Mark+reference (MVP-1M.6) | Low | Yes — bridge to skip |

**Recommendation:** MVP-1M.6 mark+reference first (additive fields), then MVP-1M.7 skip extraction.

**Proposed data model (M.6):**
- `dedup_status: str = "unique"` — "unique" | "duplicate_final_url"
- `duplicate_of_url: str | None = None` — canonicalized final_url of kept result
- `duplicate_of_evidence_path: Path | None = None` — kept evidence path

**Backward compatibility:** All new fields have defaults. No existing consumer code touches them. M.6 is fully additive. M.7 introduces `fetch_status="skipped_duplicate"` which is structurally safe (free string) but changes `succeeded == total` logic.

**Files changed:** `notes/MVP1M5_SKIP_DEDUP_DESIGN.md` (new), `notes/PROJECT_STATE.md`, `notes/ACTIVE_TASK.md`, `notes/EXPERIMENT_LOG.md`.

**Commands run:**
- `pytest tests/ -v` (868/868 pass)
- `pytest tests/test_final_url_dedup.py -v` (23/23 pass)
- `pytest tests/test_canonical.py -v` (45/45 pass)
- `eval-corpus` (11/11 pass)
- `py_compile` (clean)
- `git diff --check` (clean)

---

## 2026-05-18 — MVP-1M.3 Fetch-aware final_url dedup design

**Goal:** Design the fetch-aware redirect/final_url dedup layer for krn-search. MVP-1M.2 catches pre-fetch duplicates. M.3 catches post-fetch duplicates where different candidate URLs resolve to the same final_url after redirect following.

**Baseline:** d72fb155292fddf80474b5b511748246da8a2aca, 845/845 tests pass, 11/11 eval-corpus.

**Architecture findings:**
- `FetchResult` has no `final_url` field — only `redirects: list[dict]` with `status`, `location`, `resolved_url`.
- `EvidenceWriteResult` has no `final_url` field — only `original_url`, `normalized_url`, `evidence_path`, `fetch_status`, `http_status`, `cache_status`, `extraction_status`, `text_chars`, `truncated`, `errors`, `limitations`.
- `final_url` is computed in `run.py::fetch_url_to_evidence()` from `fetch_result.redirects[-1]["resolved_url"]` but only passed to `build_evidence_pack()` — never returned on `EvidenceWriteResult`.
- `search_query()` loop in `search.py` accumulates `EvidenceWriteResult` sequentially — safest place for dedup registry.
- `search_query().limitations` only carries `discovery.limitations` — no fetch-level limitations currently added.
- `canonicalize_url_for_dedup()` exists and works on any URL string.

**Options compared:**
- A: Skip duplicate evidence after fetch (requires new `fetch_status` value, breaks consumers)
- B: Extract then dedup + delete files (destructive, high risk)
- C: Mark duplicates only — visibility via limitations (zero risk, additive)
- D: Staged mark-only M.4 → skip M.5 (recommended)
- E: Defer (design only)

**Recommendation:** Option D. MVP-1M.4 mark-only (C), MVP-1M.5 skip (A).

**MVP-1M.4 design:** Add `final_url: str | None` to `EvidenceWriteResult`. In `search_query()`, after fetch loop, build `seen_final_urls` registry using `canonicalize_url_for_dedup(final_url)`. Report collapsed count in `SearchRunResult.limitations`. All evidence packs still created. Zero behavioral change for consumers.

**MVP-1M.5 design (future):** Add `fetch_status = "skipped_duplicate"`. Skip extraction/evidence writing for duplicates. Performance gain materializes.

**JSON compatibility:** `EvidenceWriteResult.final_url` is additive optional field. No breaking change. Limitations message follows established MVP-1M.2 pattern.

**Security:** `final_url` from policy-checked redirects only. Blocked/failed excluded from registry. `follow_redirects` gate prevents dedup when user disabled redirect following. Per-hop `check_url()` already protects SSRF.

**Files changed:** `notes/MVP1M3_FINAL_URL_DEDUP_DESIGN.md` (new), `notes/PROJECT_STATE.md`, `notes/ACTIVE_TASK.md`, `notes/EXPERIMENT_LOG.md`.

**Commands run:**
- `pytest tests/ -v` (845/845 pass)
- `eval-corpus` (11/11 pass)
- `py_compile` (clean)
- `git diff --check` (clean)

---

## 2026-05-18 — MVP-1M.2 Candidate-level Canonical URL Dedup

**Goal:** Implement candidate-level canonical URL dedup before fetch/evidence. Stricter URL normalization with tracking param removal, duplicate slash collapse, query param sorting.

**Baseline:** 6d9385314d436c620e74714ec67b0f271b0721ee, 800/800 tests pass, 11/11 eval-corpus.

**What changed:**
- `search_tool/canonical.py` (new, ~110 lines) — `canonicalize_url_for_dedup()`, `TRACKING_EXACT`, `TRACKING_PREFIX`, `_filter_and_sort_query()`
- `search_tool/discovery.py` — Canonical dedup in `build_discovery_result()` before normalized dedup
- `search_tool/eval_corpus.py` — `collapsed_duplicates_in_limitations` special check
- `tests/test_canonical.py` (new, 45 tests) — Full coverage of canonicalization rules
- `tests/test_discovery.py` — Updated duplicate tests for canonical dedup behavior
- `tests/test_cli_smoke.py` — Updated `test_duplicate_url_selected_once`
- `tests/fixtures/search_corpus/basic.json` — Updated `duplicate_results` and `mixed_candidates` scenarios

**Canonical rules:** Lowercase scheme/host, remove default ports, empty path → `/`, collapse duplicate slashes, strip trailing slash, strip fragment, remove tracking params (utm_*, fbclid, gclid, msclkid, mc_cid, mc_eid, igshid), preserve ref/source/via, sort retained params, preserve path case.

**Behavior change:** Exact duplicates and tracking-param variants now collapse to 1 candidate before DiscoveryCandidate creation. Collapsed count reported in `limitations` tuple. `duplicate_of` field no longer set for canonical duplicates (they don't reach DiscoveryCandidate stage).

**Tests:** 845/845 (800 + 45 new), eval-corpus 11/11, compile OK, whitespace OK.

## 2026-05-17 — MVP-1L.2 llms.txt Discovery Provider

**Goal:** Implement the first runtime slice of llms.txt/docs-index support. Parse a supplied llms.txt file and emit normal discovery candidates into the search-query pipeline.

**Baseline:** 11a1edd0d05421cdeed47e00994c6e8cc4e27849, 682/682 tests pass, 11/11 eval-corpus.

**What changed:**
- `search_tool/discovery_llms.py` (new, ~350 lines) — `LlmsTxtProvider` class, `parse_llms_txt()`, lightweight markdown parser, keyword scoring, relative URL resolution, dedup, scheme blocking
- `search_tool/cli.py` — Added `llms` provider choice, `--url` flag, `_run_llms_discover` handler, search-query llms branch, provider_config for llms
- `search_tool/profiles.py` — Added `llms-docs` profile
- `tests/test_llms_parser.py` (new, 40 tests) — Parser coverage
- `tests/test_llms_provider.py` (new, 48 tests) — Provider coverage
- `tests/fixtures/llms/basic-llms.txt`, `relative-llms.txt`, `malformed-llms.txt` — Test fixtures
- `README.md` — Added llms provider CLI examples
- `notes/MVP1L2_LLMS_PROVIDER_IMPLEMENTATION.md` (new) — Implementation report

**Parser rules:** Markdown links, bullet links, raw URLs, named URLs (`Title: URL`), H2 sections, relative URL resolution, fenced code block filtering, dedup by normalized URL, scheme blocking.

**CLI:** `discover-query "query" --provider llms --url <url>`, `search-query "query" --provider llms --url <url> --json --work-dir <dir>`

**Tests:** 770/770 (682 + 88 new), eval-corpus 11/11, compile OK, whitespace OK.

## 2026-05-17 — MVP-1L.3 llms Provider UX/Profile Polish

**Goal:** Polish the newly pushed llms provider before larger dogfooding. URL aliases, redirect handling, profile docs.

**Baseline:** c3fd0c0668ce37557a9a61e56fd0a664ee83fe45, 770/770 tests pass, 11/11 eval-corpus.

**What changed:**
- `search_tool/cli.py` — Added `_resolve_llms_url()` helper, `--llms-url`/`--docs-index-url`/`--follow-redirects` arguments, updated llms branches
- `search_tool/discovery_llms.py` — Added `follow_redirects` field to `LlmsTxtProvider`, wired through to fetch
- `tests/test_llms_aliases.py` (new, 22 tests) — Alias resolution, CLI args, conflict detection, redirect wiring
- `tests/test_llms_provider.py` — Added 10 follow_redirects and provider field tests
- `README.md` — Updated llms provider docs, added profile docs, CI test count stalability fix

**Aliases:** `--url`, `--llms-url`, `--docs-index-url` (all map to same effective URL; conflicting aliases return error).

**Redirects:** `discover-query` gains `--follow-redirects`. `search-query` llms source fetch now respects `--follow-redirects` (previously only affected evidence fetch). Default: not followed (L.2 preserved).

**Warnings:** Deferred to L.4.

**Tests:** 792/792 (770 + 22 new), eval-corpus 11/11.

## 2026-05-17 — MVP-1L.4 Real-world llms Provider Dogfood / Acceptance

**Goal:** Dogfood the llms provider with real-world llms.txt files. Accept or identify blockers.

**Baseline:** 45f05da6b53f0b281a942d992fea0b1fd1b5e346, 792/792 tests, 11/11 eval-corpus.

**What changed:**
- `search_tool/discovery_llms.py` — Added `llms_url` field to `LlmsTxtProvider`; `discover()` falls back to `self.llms_url` (+4 lines); Extended `_MARKDOWN_LINK_RE` from `[-]?` to `[-*]?` for `*` bullet markdown links (+1 line)
- `search_tool/cli.py` — Pass `llms_url=effective_url` to `LlmsTxtProvider` constructor in `search-query` branch (+1 line); Deduplicate limitations via `dict.fromkeys()` (+1 line)
- `tests/test_llms_parser.py` — Added `test_markdown_link_with_asterisk_bullet` (+7 lines)
- `notes/MVP1L4_LLMS_REAL_WORLD_DOGFOOD.md` (new) — acceptance report
- `notes/PROJECT_STATE.md`, `notes/ACTIVE_TASK.md`, `notes/EXPERIMENT_LOG.md` — updated

**Targets tested:** Pydantic (PASS, 88→10 candidates, 10 evidence 3/3), FastAPI (FAIL — no llms.txt, honest 404), GitHub Docs (PASS after fix, 117→10 candidates, 10 evidence 3/3), Claude Code (PASS, 132→10 candidates, 10 evidence 3/3).

**Fixes:** (1) `search-query --provider llms` llms_url passthrough bug — stored on provider instance; (2) Duplicate redaction limitation in JSON — dedup via dict.fromkeys; (3) `*` markdown bullet not parsed — extended regex.

**Tests:** 793/793 (792 + 1 new), eval-corpus 11/11, compile OK, whitespace OK.

## 2026-05-18 — MVP-1M.1 Canonical/Dedup Refinement Design

**Goal:** Design the next quality layer for krn-search: canonical URL normalization and dedup refinement across discovery, fetch, evidence, and llms provider flows.

**Baseline:** a54152925fb1b7c3a62323e5ddd1caf4f2df1ad0, 800/800 tests pass, 11/11 eval-corpus.

**Current architecture findings:**
- `normalize_url` (url_policy.py:138): lowercases scheme/host, removes default ports, strips trailing slash, preserves query string (no filtering/sorting), drops fragment. Does NOT remove tracking params.
- Candidate dedup: two stages — (a) `parse_llms_txt()` dedups by normalized URL, (b) `build_discovery_result()` dedups across providers, marks `duplicate_of`.
- Fragments: stripped by normalize_url, dedup correct but raw URL preserves fragment.
- Query params: fully preserved, no tracking param removal.
- Redirect/final_url: stored in evidence pack frontmatter, NOT on DiscoveryCandidate.
- Canonical HTML tags: NOT extracted.
- Evidence keying: SHA-256 of normalized URL — different query params = different evidence files.
- Safe dedup insertion: discovery layer (before `build_discovery_result`), search.py layer (before fetch loop).

**Duplicate classes identified:** String-equivalent (casing, ports, trailing slash, slashes, percent encoding, fragments), query-param (utm_*, fbclid, gclid, etc.), redirect-equivalent, canonical HTML, content duplicates (title+hash), llms-specific (multi-section, relative/absolute).

**Options compared:** A (normalize early only), B (fetch-aware canonical), C (evidence-level dedup), D (hybrid staged graph), E (reporting only).

**Recommendation:** Option A (normalize early only) as MVP-1M.2. Staged hybrid (Option D) as vehicle.

**Staged plan:**
- M.2: `canonical.py` module, `canonicalize_url_for_dedup()`, candidate-level dedup before `build_discovery_result`. Strip fragments, tracking params, collapse slashes, sort retained params. No HTML parsing.
- M.3: Fetch-aware redirect/final_url dedup.
- M.4: HTML canonical tag extraction.
- M.5: Dogfood across llms + static + real docs.

**Canonical rules for MVP-1M.2:** Lowercase scheme/host, remove default ports, empty path → `/`, collapse duplicate slashes, strip trailing slash (except root), strip fragments always, remove tracking params (utm_*, fbclid, gclid, msclkid, mc_cid, mc_eid, igshid), sort retained params, preserve `ref`/`source`/`via` (defer).

**JSON compatibility:** Fewer candidates, same schema. `duplicate_of` already exposed. Limitations gains collapsed-count string. No new fields.

**Tests planned:** 27+ tests (13 canonical unit, 10 discovery dedup, 5 search/evidence).

**Files changed:** `notes/MVP1M1_CANONICAL_DEDUP_DESIGN.md` (new), `notes/PROJECT_STATE.md`, `notes/ACTIVE_TASK.md`, `notes/EXPERIMENT_LOG.md`.

**Commands run:**
- `pytest tests/ -v` (800/800 pass)

**Test results:** 800/800 pass. No runtime changes.

---

## 2026-05-18 — MVP-1L.5 llms Parser Warnings JSON Polish

**Goal:** Surface llms.txt parser warnings in JSON output without breaking existing consumers.

**Baseline:** 4766901fd8e3038a56dd2d73ed9eb5245986684e, 793/793 tests pass, 11/11 eval-corpus.

**Chosen strategy:** Append parser warnings to existing `DiscoveryResult.limitations` with `llms parser warning:` prefix. Zero schema risk — no new fields, no renames.

**What changed:**
- `search_tool/discovery_llms.py` — After `parse_llms_txt()`, warnings captured, deduped via `dict.fromkeys()`, capped at 20. Appended to `limitations` in both success path (via `dc_replace`) and no-entries path (direct tuple concat).
- `tests/test_llms_provider.py` — +7 tests in `TestParserWarnings` class.

**JSON behavior:** Warnings appear in `limitations` list in both discover-query and search-query JSON output. Static/SearXNG unaffected. Error JSON (preflight) unchanged.

**Tests:** 800/800 (793 + 7 new), eval-corpus 11/11, compile OK, whitespace OK.

**Known limitations:** Warnings mixed with limitations in single list; dedicated `warnings` field deferred to L.6.

## 2026-05-17 — MVP-1K.5 `krn-search init-claude` Bootstrap Command

**Goal:** Implement the smallest useful bootstrap command for the portable research kit. One command to copy `.claude` artifacts into a target repo.

**Baseline:** 696d530162530e971c2c1d8845bab6a9627a14dd, 656/656 tests pass, 11/11 eval-corpus.

**What changed:**
- `search_tool/bootstrap.py` (new, ~110 lines) — Core bootstrap logic: template reading via `importlib.resources`, file copy, summary printing
- `search_tool/cli.py` — Added `init-claude` subcommand with `--target-dir`, `--dry-run`, `--force`, `--with-hook` flags
- `search_tool/templates/claude/` (new) — Template source files copied from canonical `.claude/` artifacts
- `pyproject.toml` — Added `[tool.setuptools.package-data]` for template packaging
- `tests/test_init_claude.py` (new, 24 tests) — Full test coverage
- `README.md` — Added bootstrap command docs section
- `notes/MVP1K5_INIT_CLAUDE_BOOTSTRAP.md` (new) — Implementation report

**CLI contract:**
```
krn-search init-claude                          # copy skill + command
krn-search init-claude --with-hook              # also copy hook
krn-search init-claude --dry-run                # print only
krn-search init-claude --force                  # overwrite existing
krn-search init-claude --target-dir /path       # custom target
```

**Defaults:** Copies skill + command. Skips existing files. No hook, no settings files, no activation.

**Tests:** 680/680 pass (656 baseline + 24 new). Eval-corpus: 11/11. Compile: OK.

**Template strategy:** Templates under `search_tool/templates/claude/` packaged via `[tool.setuptools.package-data]`. Read via `importlib.resources.files("search_tool.templates")` — works in both editable and installed modes.

**Verification:** compile OK, eval-corpus OK, no generated artifacts, no WebSearch/WebFetch, no dependency changes.

---

## 2026-05-17 — MVP-1K.6 Fresh Install Dogfood

**Goal:** Verify `krn-search init-claude` works from a fresh pip install (non-editable mode) in a brand-new directory.

**Baseline commit:** `61a7b777aadcbca5fd896153d43c9dff70ad33d1`

**Environment:** Linux 6.6.87.2-microsoft-standard-WSL2, Python 3.12.3, `python3 -m venv` + `pip install`

**Scenarios:**
- Installed CLI: `krn-search --version` → `krn-search 0.1.0` (PASS)
- Dry-run: reports 2 files, no disk changes (PASS)
- Default create: creates SKILL.md + command, no hooks, no settings (PASS)
- Content verification: key strings present in both files (PASS)
- Idempotent skip: second run skips both (PASS)
- `--with-hook`: creates hook file with WebSearch/WebFetch content (PASS)
- `--force`: overwrites 3 files, restores modified content (PASS)
- Health check: valid JSON, overall ok, no SearXNG required (PASS)
- No leakage: no untracked files in source repo working tree (PASS)
- Existing tests: 24/24 init-claude, 680/680 full suite (PASS)

**Friction found:** None. Installed mode works identically to editable mode.

**Verdict:** FRESH_INSTALL_PASS

---

## 2026-05-17 — MVP-1K.7 Tiny Hygiene: Dead Test Prefix Fix

**Goal:** Fix two test methods in `tests/test_init_claude.py` missing the `test_` prefix, making them invisible to pytest.

**Baseline commit:** `ad7f49582e4bb651c596d70b9d68b4157ebd9a84`

**What changed:**
- `tests/test_init_claude.py` — Line 141: `def command_file_contains_expected_strings` → `def test_command_file_contains_expected_strings`
- `tests/test_init_claude.py` — Line 148: `def hook_file_contains_expected_strings` → `def test_hook_file_contains_expected_strings`

**Verification:**
- Init-claude tests: 26/26 pass (was 24/24, 2 were hidden)
- Full suite: 682/682 pass (was 680/680)
- Eval-corpus: 10/10 pass
- No runtime code changes, no new files

**Verdict:** HYGIENE_PASS — two hidden tests uncovered, both pass.

---

## 2026-05-16 — MVP-1K.4 Shell-Safe Launcher Strategy

**Goal:** Resolve friction from K.3 — `KRN_SEARCH_BIN` with command+args only works in bash, not zsh.

**Recommendation:** Primary portable story is `krn-search` executable. Editable fallback via `KRN_SEARCH_BIN` with explicit bash-vs-zsh warning. KRN_SENTINEL kept as internal/advanced override.

**Files polished:**
- CLAUDE.md — primary launcher `krn-search`, KRN_SEARCH_BIN simplified
- README.md — all command examples `krn-search`, editable fallback documented separately with zsh warning
- .claude/commands/krn-search-research.md — primary launcher `krn-search`
- .claude/skills/krn-search-research/SKILL.md — primary launcher `krn-search`, launcher config section

**Micro-dogfood:** editable fallback status ok, 1/1 evidence, quality 3/3. Installed CLI not tested (not installed in this env).

**Verdict:** docs/artifact polish only. No runtime changes.

## 2026-05-16 — MVP-1K.3 Portable Kit External Dogfood

**Goal:** Prove the v0.1 portable model works outside krn-search repo.

**Baseline:** 550a9bca3c2442d9c3176f0e484be3e14cf97b38

**Target:** temporary empty git repo (created via mktemp -d)

**KRN_SEARCH_BIN:** editable fallback via `/home/krn/coding/krn/krn-search/.venv/bin/python -m search_tool`

**Results:**
- health --json: valid JSON, CLI works
- static research (1 candidate, docs.python.org): status ok, quality 3/3, authority 3
- skillflow research (2 candidates, anthropic.com + docs.anthropic.com): status ok, 2/2 success, quality 3/3
- all artifacts under target repo `.local/krn-search-runs`
- no path leakage into krn-search repo
- hook copied but not configured

**Friction:**
1. unquoted `$KRN_SEARCH_BIN` word splitting only works in bash (Claude Code's shell), not zsh
2. most users won't have `krn-search` on PATH — need to export KRN_SEARCH_BIN with editable path

**Verdict:** PORTABLE_KIT_PASS

## 2026-05-16 — MVP-1K.2 KRN_SEARCH_BIN Convention Applied

**Goal:** Replace hardcoded `.venv/bin/python` in all reusable Claude Code artifacts with `KRN_SEARCH_BIN` convention.

**Baseline commit:** `02ce750cb8f063520cf4b032662af644e9c1faf3`

**Convention:**
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
Resolution order: env var override → installed CLI → editable `.venv` → `python3` → `python`.

**Files changed:**
- `.claude/commands/krn-search-research.md` — commands → `$KRN_SEARCH_BIN`, added convention snippet
- `.claude/skills/krn-search-research/SKILL.md` — all 8 command examples → `$KRN_SEARCH_BIN`, added convention note
- `.claude/skills/krn-search-next-task/SKILL.md` — test command → `$PYTHON_BIN`
- `.claude/skills/krn-search-implementation/SKILL.md` — test commands → `$PYTHON_BIN`
- `.claude/skills/krn-search-review/SKILL.md` — test command → `$PYTHON_BIN`
- `.claude/skills/krn-search-acceptance/SKILL.md` — test commands → `$PYTHON_BIN`
- `CLAUDE.md` — Python command hygiene section split into PYTHON_BIN and KRN_SEARCH_BIN
- `README.md` — all command examples → `$KRN_SEARCH_BIN`; added portable kit section and convention note
- `notes/PROJECT_STATE.md` — updated phase, HEAD, preferred command
- `notes/ACTIVE_TASK.md` — marked MVP-1K.2 complete

**Not changed (historical):** `notes/MVP1K1_PORTABLE_RESEARCH_KIT_DESIGN.md`, `notes/EXPERIMENT_LOG.md` (historical entries), `notes/MVP1*` dogfooding reports, `notes/MVP1A_FETCH_LIST_EVALUATION.md`, `evals.json`

**Tests:** 656/656 pass. Eval-corpus: 11/11. No runtime source changes. No dependency changes.

## 2026-05-16 — MVP-1K.1 Portable Research Kit Design

**Goal:** Audit krn-search portability, compare packaging options A-E, recommend staged hybrid, write design doc.

**Baseline commit:** `a9f71ccc5813e9c9ea7f783c2e66d1e02fcc11bf`

**Portability audit findings:**
- `search_tool/` package is already portable (no repo-absolute paths)
- `pyproject.toml` already has `krn-search` CLI entrypoint — installable via pip/uv/pipx
- SKILL.md, commands, implementation/acceptance/review skills use `.venv/bin/python` hardcoded — need `KRN_SEARCH_BIN` convention
- SearXNG defaults to `localhost:9999` in cli.py — configurable via `SEARXNG_URL` env var, acceptable
- Hook guard script is generic Python stdlib — portable as-is
- Evidence work-dir `.local/krn-search-runs` is a convention, not code enforcement

**Decision: Staged hybrid**
- v0.1: Installable CLI + copyable `.claude/` bundle + optional hook + `KRN_SEARCH_BIN` convention
- v0.2: Bundle script to copy Claude artifacts
- v0.3: Validate across 2+ repos
- v1.0: Plugin only after skill/hook proven stable

**Non-goals:** No MCP, no plugin, no pyproject.toml changes, no WebSearch, no runtime changes to search_tool/.

**Commands run:**
- `pytest tests/ -v` (656/656 pass)
- `eval-corpus` (11/11 pass, JSON valid)
- `py_compile search_tool/*.py .claude/hooks/websearch_krn_search_guard.py` (clean)
- `git diff --check` (clean)

**Verification:** compile OK, whitespace OK, eval-corpus OK, no generated artifacts, no WebSearch/WebFetch, no dependency changes.

## 2026-05-16 — MVP-1J.3 Research Pipeline Regression Dogfood and Tiny Readability Polish

**Goal:** Regression dogfood after J.2 fixes + apply 2 tiny deterministic polish items: "Skip to content" nav chrome stripping and frontmatter title backslash separator cleanup.

**Baseline commit:** `7b7bf84108b620fde2052a5c3905785960ce089b`

**What changed:**
- `search_tool/compact.py` — Added `"Skip to content"` to `_NAV_CHROME_LINES` (+1 line)
- `search_tool/cli.py` — Added YAML-ish backslash separator cleanup in frontmatter title fallback: `val.replace(r" \\ ", " - ")` and `val.replace(r" \ ", " - ")` (+3 lines)
- `tests/test_search_json.py` — 2 new tests: `test_title_double_backslash_artifact_cleaned`, `test_title_normal_unchanged`
- `notes/MVP1J3_RESEARCH_PIPELINE_REGRESSION_DOGFOOD.md` (new) — regression report
- `notes/PROJECT_STATE.md`, `notes/ACTIVE_TASK.md`, `notes/EXPERIMENT_LOG.md` — updated

**Commands run:**
- `pytest tests/ -v` (656/656 pass)
- `eval-corpus` (11/11 pass, JSON valid)
- `py_compile search_tool/*.py` (clean)
- `git diff --check` (clean)
- Static fallback research: 8/8 success, all titles visible, no nav chrome in JSON excerpts

**Test results:** 656/656 pass (637 baseline + 19 new: 2 title backslash, 1 nav chrome excerpt, existing 16 from J.2)

**Known limitations:**
- Compact summary `_strip_nav_chrome` only strips beginning nav lines — mid-content nav items (Reference, Resources, etc.) remain
- Google A2A title backslash from HTML `<title>` tag extraction layer (not frontmatter) — deferred
- No generic word stripping (Cloud, Docs, Products, Resources) — too broad

**Verification:** compile OK, whitespace OK, eval-corpus OK, no generated artifacts, no WebSearch/WebFetch, no dependency changes.

## 2026-05-16 — MVP-1J.2 Source Quality and Evidence Readability Polish
**Goal:** Fix 4 frictions from MVP-1J.1 dogfooding: null titles in JSON, underclassified vendor blogs, false redirect loops, nav chrome in compact snippets.
**Baseline commit:** `9a12291c40b767dae0ec3556d9fc4d88f5421780`
**What changed:** (1) `cli.py`: evidence_results[].title populated from evidence pack frontmatter when discovery candidate title missing (+19 lines); (2) `source_quality.py`: added `_PRIMARY_BLOG_DOMAINS` (anthropic.com, openai.com) and `_PRIMARY_DEV_BLOG_DOMAINS` (developers.googleblog.com) classified as blog authority 3/3 (+27 lines); (3) `fetch.py`: `_redirect_safe_url()` preserves trailing slashes for redirect loop detection, fixing openai.github.io and developers.googleblog.com (+32/-7 lines); (4) `compact.py`: `_strip_nav_chrome()` strips common nav-only lines from beginning of extracted text (+43 lines).
**Files changed:** search_tool/cli.py, search_tool/compact.py, search_tool/fetch.py, search_tool/source_quality.py, tests/test_compact_summary.py, tests/test_fetch.py, tests/test_search_json.py, tests/test_source_quality.py, notes/MVP1J2_SOURCE_QUALITY_READABILITY_POLISH.md, notes/PROJECT_STATE.md, notes/ACTIVE_TASK.md.
**Commands run:** `pytest`, `eval-corpus`, `py_compile`, `git diff --check`.
**Test results:** 653/653 pytest pass (16 new: 5 source quality, 7 nav chrome, 2 title frontmatter, 2 trailing-slash redirect), 11/11 eval-corpus pass.
**Known limitations:** Nav chrome only stripped from beginning of text; redirect safe URL only for redirect resolution, not cache keying.
**Verification:** compile OK, whitespace OK, no generated artifacts, no WebSearch/WebFetch, no dependency changes.

## 2026-05-16 — MVP-1J.1 Research Pipeline Dogfooding

**Goal:** Establish the ideal Claude Code research/search pipeline using krn-search. Test the actual workflow on a non-trivial research example, identify friction, write operating procedure.

**Baseline commit:** `ba4ff8bbf072c8a5e9c2dd368ab42a5c620956e9`

**Changes:**
- `notes/MVP1J1_RESEARCH_PIPELINE_DOGFOODING.md` (new) — dogfooding report
- `notes/PROJECT_STATE.md` — updated to MVP-1J.1
- `notes/ACTIVE_TASK.md` — updated last completed
- `notes/EXPERIMENT_LOG.md` — this entry

**Results:**
- Baseline: 637/637 tests, 11/11 eval-corpus, compile OK, no whitespace errors
- Hook: present and active in `.claude/settings.local.json`. Blocks WebSearch/WebFetch with krn-search recovery. Not in committed `settings.json`.
- SearXNG: not reachable on localhost:9999. Containers on 8080 exist but JSON format disabled (404). Health reports degraded. Optional, not blocking.
- Research question: "Current best practices for building AI coding-agent operating systems in 2026"
- Attempt A (SearXNG): error status, 0 candidates, connection error (expected)
- Attempt B (static, 8 curated URLs): partial_success, 6/8 succeeded quality 3/3, 2 redirect loops
- Successful sources: Anthropic hooks/skills/tool-use docs (official_docs, auth 3/3), GitHub Copilot agent docs, Anthropic research blog, MCP intro
- Failed: OpenAI Agents Python (redirect loop), Google A2A blog (redirect loop)
- Frictions: null titles in API response, nav chrome in excerpts, redirect loops on trailing-slash URLs

**Ideal pipeline:**
1. Fast path: `/krn-search-research <query>` when SearXNG JSON available
2. Static fallback: `search-query --research --provider static --candidate-url ...`
3. Evidence reading order: JSON → compact summary → manifests → evidence packs
4. WebSearch not trusted/available; use krn-search first
5. SearXNG optional, JSON required, missing = degraded not blocker

**WebSearch/WebFetch used in this task:** No.

**Verdict:** Pipeline operational with known frictions. Docs-only.

---

## 2026-05-16 — MVP-1I.3 SearXNG Local Live Integration Polish

**Goal:** Make local SearXNG live usage boring and obvious. Docs/ops polish: smoke instructions, JSON format config, Python command hygiene.

**Baseline commit:** `6ad0e3d082fdf51cdb7a36f423d5ef50bd9fd311`

**Changes:**
- `README.md` — Added "Local SearXNG live smoke" section with config, verification, health, research smoke, stop steps. Fixed UI section Python command.
- `.claude/skills/krn-search-research/SKILL.md` — Updated all commands to `.venv/bin/python`. Added SearXNG JSON format prerequisite.
- `.claude/commands/krn-search-research.md` — Added SearXNG availability check, JSON format note, `.venv/bin/python` note.
- `notes/PROJECT_STATE.md` — Updated to MVP-1I.3.
- `notes/ACTIVE_TASK.md` — Updated last completed and recommended next.
- `notes/MVP1I3_SEARXNG_LOCAL_LIVE_SMOKE.md` (new) — smoke test report.
- `notes/EXPERIMENT_LOG.md` — this entry.

**Results:**
- Baseline: 637/637 tests, 11/11 eval-corpus, compile OK
- Docker state: 4 SearXNG containers on host, none with host port mapping
- Temporary container started, reachable in ~1s
- Health with SearXNG: reports `warn` (default image lacks JSON format) — correct behavior
- Discovery 403 handling: clear error about settings.yml JSON format — already user-friendly
- No runtime changes needed — all polish is docs-only
- Smoke container stopped and removed

**WebSearch/WebFetch used in this task:** No.

---

## 2026-05-16 — MVP-1I.2 Operational Smoke Test

**Goal:** Verify CI gate runs on GitHub Actions, validate local deterministic gate, test static research smoke, check SearXNG availability.

**Baseline commit:** `3b946acb053c946c334818bc03169e7e158292e5`

**Changes:**
- `notes/MVP1I2_OPERATIONAL_SMOKE_TEST.md` (new) — smoke test report
- `notes/PROJECT_STATE.md` — updated phase
- `notes/ACTIVE_TASK.md` — updated last completed
- `notes/EXPERIMENT_LOG.md` — this entry

**Results:**
- CI gate: success on GitHub Actions (commit `3b946ac`)
- Local gate: 637/637 tests, 11/11 eval-corpus, compile OK
- Health: all ok, SearXNG optional (info)
- Static research smoke: OK (live fetch docs.python.org, compact summary created)
- SearXNG live smoke: skipped (multiple containers on host but none with mapped port, localhost:8080 returns 404 from non-SearXNG proxy)

**WebSearch/WebFetch used in this task:** No.

---

## 2026-05-16 — MVP-1I.1 CI Gate Stabilization

**Goal:** Add deterministic GitHub Actions CI gate for krn-search to prevent silent regression of the MVP-1H research workflow.

**Baseline commit:** `8e66ff40ab9ad7f7abf14f3e622104878e8b52ef`

**Changes:**
- `.github/workflows/ci.yml` (new) — CI gate with 7 checks: compile, whitespace, pytest, eval-corpus, research-mode error JSON, research-mode preflight structure
- `README.md` — added CI gate section
- `notes/PROJECT_STATE.md` — added MVP-1I.1 status section
- `notes/ACTIVE_TASK.md` — marked CI complete, removed from next options
- `notes/EXPERIMENT_LOG.md` — this entry

**Results:** 637/637 tests pass, 11/11 eval-corpus pass. CI is network-free, requires no SearXNG.

**Design decisions:**
- Research-mode happy-path smoke (live fetch) is avoided in CI to keep it network-free. The 21 existing pytest tests in `test_research_mode.py` cover the research-mode integration path.
- Research-mode preflight validation (invalid profile → error JSON, structure checks) is fully deterministic and network-free — these are the CI smoke tests.
- No shell script created — YAML is clear enough with inline steps.
- No pyproject.toml changes — uses existing `pip install -e ".[dev]"` install method.
- No new dependencies.

**WebSearch/WebFetch used in this task:** No.

---

## 2026-05-14 — MVP-1H.7 Docs Sync and Closure

**Goal:** Synchronize top-level project docs after MVP-1H completion.

**Baseline commit:** `3fbc43db62479ccb59a790e572f0209431373c7b`

**Changes:**
- `CLAUDE.md` — updated phase to MVP-1H complete, refined usage policy wording, added no-MCP/no-browser-rendering non-goals
- `README.md` — added artifact reading order, compact evidence index to produces list, research mode limitations section
- `notes/PROJECT_STATE.md` — updated phase, added MVP-1H workflow summary
- `notes/ACTIVE_TASK.md` — set no active task, listed recommended next options (CI, krn-ai-os, dedup, llms.txt)
- `notes/EXPERIMENT_LOG.md` — this entry

**Results:** 637/637 tests pass, 11/11 eval-corpus pass. No runtime changes.

**WebSearch/WebFetch used in this task:** No.

**Next recommended action:** Choose next direction from ACTIVE_TASK.md options.

## 2026-05-14 — MVP-1H.6 Research Mode Dogfooding Evaluation

**Goal:** Dogfood the complete no-WebSearch research workflow with `--research` preset.

**Baseline commit:** `376986d43a92c1aa27ec491b3eea9fdf0518b96c`

**Changes:**
- `notes/MVP1H6_RESEARCH_MODE_DOGFOODING.md` (new) — evaluation report
- `notes/PROJECT_STATE.md` — updated phase and status
- `notes/ACTIVE_TASK.md` — updated to MVP-1H.6

**Scenarios:**
- A. Static research mode: PASS — JSON valid, research_mode correct, profile=official-docs, compact_summary_path exists, evidence quality 3/3, answerable
- B. Override research mode: PASS — --no-compact, --no-follow-redirects, --profile security-research all correctly override preset
- C. Error honesty: PASS — invalid profile emits valid JSON error with research_mode present
- D. Skill/command docs review: PASS — uses --research, correct artifact order, no WebSearch fallback, no answer claims
- E. Hook recovery: PASS — denies WebSearch, recovery mentions /krn-search-research

**Acceptance verdict:** ACCEPT_MVP1H5. Minor polish items do not block.

**Results:** 637/637 tests pass, 11/11 eval-corpus pass. No runtime changes.

**WebSearch/WebFetch used in this task:** No.

**Next recommended action:** Update CLAUDE.md phase, consider stabilization or krn-ai-os port.

## 2026-05-14 — MVP-1H.5 Research Mode Preset Implementation

**Goal:** Implement `search-query --research` as a deterministic preset over existing search-query capabilities.

**Baseline commit:** `e6cc8f738d50146c69bebba22030101b3d624073`

**Changes:**
- `search_tool/cli.py` — `--research` flag, `--no-compact`/`--no-follow-redirects` via BooleanOptionalAction, research mode defaults, `research_mode` in JSON/error JSON
- `tests/test_research_mode.py` (new) — 18 tests
- `tests/test_search_json.py` — 2 new tests
- `tests/test_compact_summary.py` — 1 new test
- `.claude/commands/krn-search-research.md` — updated to use `--research`
- `.claude/skills/krn-search-research/SKILL.md` — research mode docs, updated artifact order
- `notes/PROJECT_STATE.md`, `notes/ACTIVE_TASK.md`, `notes/DECISION_CANDIDATES.md` — updated

**Behavior:**
- `--research` sets: provider=auto, json=true, compact=true, profile=official-docs, work-dir=.local/krn-search-runs, follow-redirects=true
- Explicit flags override defaults (except JSON is mandatory)
- `--no-compact` and `--no-follow-redirects` available for negation
- `--provider` is now optional (required without `--research`, defaults to `auto` with `--research`)
- JSON output includes `research_mode` object with `enabled`, `preset_version`, `expanded_defaults`, `effective_values`
- Non-research JSON includes `research_mode: null` for stable shape
- Error JSON includes `research_mode` when `--research` was requested

**Results:** 637/637 tests pass (616 baseline + 21 new), 11/11 eval-corpus pass.

**Next recommended action:** Accept MVP-1H.5, update CLAUDE.md phase.

**WebSearch/WebFetch used in this task:** No.

**Durable decision:** Research mode is a deterministic preset over search-query, not a new pipeline.

## 2026-05-14 — MVP-1H.4 Research Mode Preset Design

**Goal:** Design a stable Claude Code research mode wrapper/preset over existing capabilities.

**Baseline commit:** `ebba682e577bf5f7e77b084eaef967241235b080`

**Changes:**
- `notes/MVP1H4_RESEARCH_MODE_PRESET_DESIGN.md` (new) — design memo
- `notes/PROJECT_STATE.md` — updated phase and status
- `notes/ACTIVE_TASK.md` — updated to MVP-1H.4

**Design decisions:**
- Option B (`search-query --research`) chosen over subcommand, documented preset, or slash-command-only
- `--research` expands to: provider=auto, json=true, compact=true, profile=official-docs, work-dir=.local/krn-search-runs, follow-redirects=true
- Explicit flags override defaults (except --json is mandatory in research mode)
- JSON contract: `research_mode` object with `expanded_defaults` and `effective_values`; `null` when not active
- follow-redirects defaults to `true` in research mode (SSRF mitigated by per-hop policy check)

**Results:** 616/616 tests pass, 11/11 eval-corpus pass. No runtime changes.

**Next recommended action:** MVP-1H.5 — implement `--research` preset flag.

## 2026-05-14 — MVP-1H.3 Deterministic Query Profiles

**Goal:** Add small deterministic query profiles to `search-query` so Claude Code can bias research toward better source classes without using LLM ranking or synthesis.

**Baseline commit:** `f6c9f31a67a702397027eac2c72e7010ef61d3e8`

**Changes:**
- `search_tool/profiles.py` (new) — `Profile` frozen dataclass, `PROFILES`, `get_profile()`, `profile_to_json()`, `profile_sort_key()`
- `search_tool/cli.py` — `--profile` arg on `search-query`, profile in JSON output and error JSON
- `search_tool/compact.py` — profile-aware ordering and metadata in compact summary
- `tests/test_profiles.py` (new) — 28 tests

**Profiles:**
- `official-docs`: prefer official_docs, standards, repository; min authority 2
- `github-repo`: prefer repository, official_docs; min authority 2
- `security-research`: prefer advisory, standards, official_docs, paper, repository; min authority 2

**Behavior:**
- `--profile` is optional; default unchanged
- `--profile` works with `--json` and `--compact`
- Profile visible in JSON output as `"profile"` object
- Profile visible in compact summary metadata and ordering label
- Selection policy: `prefer_not_require` — no hard filtering
- Ordering: profile_preference_match desc, authority desc, quality desc, rank asc
- Unknown profile: CLI exits 1; non-json mode prints a clear stderr error; --json mode emits valid preflight error JSON with recovery.websearch_allowed=false

**Results:** 615/615 tests pass (587 baseline + 28 new), 11/11 eval-corpus pass.

## 2026-05-14 — MVP-1H.2 Compact Evidence Index

**Goal:** Add `--compact` flag to `search-query --json` that generates a deterministic evidence index for progressive disclosure.

**Baseline commit:** `4e65f361d2b2a91c8b05c8d7fdd58a37772ae586`

**Changes:**
- `search_tool/compact.py` (new) — `write_compact_summary()`, `SourceEntry`, `_build_source_entries()`, `_extract_evidence_text()`
- `search_tool/cli.py` — `--compact` flag, `compact_summary_path` in JSON output
- `tests/test_compact_summary.py` (new) — 25 tests
- `tests/test_search_json.py` — 3 new tests

**Behavior:**
- `--compact` only valid with `--json`; writes summary under work-dir/evidence/
- Filename: `search-summary-YYYYMMDDTHHMMSSZ-<sha12>.md`
- Source table: title, URL, source_type, authority_score, is_official, status, quality_score, evidence_path
- Mechanical snippets: first 1000 chars per successful evidence pack
- Reading order: authority_score desc, quality desc, rank asc (mechanical, not AI)
- No synthesis, no AI summarization, no LLM ranking

**Results:** 587/587 tests pass, 11/11 eval-corpus pass. Smoke test with static Python docs verified.

## 2026-05-14 — MVP-1H.1 Deterministic Source Quality Metadata

**Goal:** Add deterministic source quality metadata to discovery/search JSON output.

**Baseline commit:** `d04a559808b9b6c3a6ceb0115034e3106cb81bd7`

**Changes:**
- `search_tool/source_quality.py` (new) — `SourceQuality` dataclass, `classify_source_quality()` with URL/domain/path/title heuristics
- `search_tool/cli.py` — `--json` output includes `source_quality` nested object per evidence result with: source_type, authority_score, is_official, is_primary_source, domain, reason
- `tests/test_source_quality.py` (new) — 34 tests
- `tests/test_search_json.py` — 2 new tests (source_quality in JSON, no secrets in domain)

**Heuristics:**
- Seed set: `docs.python.org`, `developer.mozilla.org` → official_docs score 3
- Generic `docs.*` subdomain → official_docs score 3
- `/docs` path → official_docs score 3
- `code.claude.com` → official_docs score 3
- `github.com`, `raw.githubusercontent.com`, `gitlab.com` → repository score 2-3
- `arxiv.org`, `doi.org` → paper score 2
- `owasp.org`, `openssf.org` → standards score 3
- `cve.org`, `nist.gov` → advisory score 3
- `reddit.com`, `stackoverflow.com`, `news.ycombinator.com` → forum score 1
- `medium.com`, `dev.to`, `*.substack.com` → blog score 1
- Private IP / localhost / `.local` / `.internal` → unknown score 0
- Everything else → unknown score 1

**Test results:** 558/558 pass (522 baseline + 36 new)

**Key design decision:** Source quality is deterministic metadata, not AI ranking. Small seed set + generic patterns, not a growing curated allowlist.

## 2026-05-12 — MVP-1G.2 JSON Failure Contract Hardening

**Goal:** In --json mode, always emit valid JSON to stdout, including for preflight/config errors.

**Changes:**
- `search_tool/cli.py` — added `_print_search_error_json()` helper; all 9 early-return error paths in `_run_search_query` now emit JSON when `--json` is set; `_resolve_auto_provider` returns error message string instead of exit code
- `tests/test_search_json.py` — 11 new tests (6 unit for error JSON helper, 5 integration for CLI error paths)

**Test results:** 523/523 pass (was 512)

**Verification:**
- `krn-search search-query "x" --provider auto --json` → valid JSON on stdout, exit 1, `status: "error"`, `recovery.websearch_allowed: false`
- `krn-search search-query "x" --provider auto` (no --json) → stderr-only, exit 1 (unchanged)

## 2026-05-12 — MVP-1G.1 No-WebSearch Dogfooding & Guard Verification

**Goal:** Verify that No-WebSearch Operating Mode works end-to-end.

**Baseline commit:** `fa02b3a`

**Results:**
- 512/512 tests PASS
- Hook deny-with-recovery: PASS (20/20 hook tests, recovery commands present, no forbidden phrases)
- Health check JSON: PASS (valid JSON, overall "ok")
- Static fallback search-query JSON: PASS (live smoke, evidence produced)
- Work-dir artifact isolation: PASS (runs/<run_id>/ layout, cache SHA256-keyed)
- Auto provider failure: FRICTION — stderr-only, no JSON on stdout (candidate MVP-1G.2)
- Forbidden phrases audit: no true violations, 2 acceptable policy negations, 6 legacy artifacts
- Report: `notes/MVP1G1_NO_WEBSEARCH_DOGFOODING.md`

## 2026-05-12 — MVP-1G.0 No-WebSearch Operating Mode

**Goal:** Mechanically block WebSearch/WebFetch and make krn-search the only web research path.

**Baseline commit:** `fa02b3a`

**What changed:**
- `.claude/hooks/websearch_krn_search_guard.py` — updated REASON to include krn-search recovery commands, removed WebSearch approval suggestion
- `CLAUDE.md` — updated phase to MVP-1G.0, replaced WebSearch fallback policy with no-WebSearch policy
- `.claude/skills/krn-search-research/SKILL.md` — removed WebSearch fallback section, updated decision tree
- `.claude/commands/krn-search-research.md` — removed WebSearch fallback suggestion
- `.claude/skills/krn-search-implementation/SKILL.md` — added contract-hardening checklist
- `search_tool/health.py` (new) — health check module with HealthCheck/HealthReport, check_searxng_reachable()
- `search_tool/cli.py` — added `health` subcommand, `--json` and `--work-dir` flags on search-query, `--provider auto` on search/discover
- `search_tool/evidence.py` — write_evidence_pack() accepts optional evidence_dir
- `search_tool/cache.py` — get/put/ensure_dirs accept optional cache_dir
- `search_tool/run.py` — fetch_url_to_evidence and write_fetch_list_manifest accept optional evidence_dir
- `search_tool/search.py` — write_search_run_manifest and search_query accept optional evidence_dir/cache_dir
- `.claude/hooks/postcommit_contract_check.py` (new) — warning-mode PostToolUse hook for git commit
- `tests/test_health.py` (new) — 20 tests
- `tests/test_search_json.py` (new) — 11 tests
- `tests/test_work_dir.py` (new) — 3 tests
- `tests/test_websearch_hook_guard.py` — updated 1 test, added 5 tests
- `tests/test_postcommit_hook.py` (new) — 9 tests

**Commands run:**
- `python -m pytest tests/ -v` (512/512 pass)
- `krn-search health` (manual smoke)
- `krn-search health --json` (manual smoke)

**Test results:** 512/512 pass (464 baseline + 48 new)

**Key design decisions:**
- WebSearch/WebFetch permanently disabled by hook policy, not soft CLAUDE.md suggestion
- work-dir propagation via explicit optional parameters, not context variables — backward compatible
- cache shared across runs under same work-dir (<work-dir>/cache/), evidence isolated per run
- EvidenceWriteResult stays stable — JSON printer reads evidence pack files for excerpts
- provider auto resolves: candidate-urls → static, searxng reachable → searxng, else structured error
- PostCommit hook is warning-only, committed as script with docstring installation instructions
- SearXNG health uses raw httpx, not url_policy (operational probe needs localhost access)
- Health status: ok / degraded (SearXNG unavailable) / fail (critical)

**WebSearch/WebFetch used in this task:** No.

**Next recommended action:** Dogfood the no-WebSearch operating mode in real workflow sessions.

**Goal:** Implement the MVP-1F.5 design as a local-only PreToolUse hook (initially ask-mode, later upgraded to deny-with-recovery in MVP-1G.0).

**Baseline commit:** `59f7f50da44db7a3f0e3e2885988b061230a218b`

**What changed:**
- Created `.claude/hooks/websearch_krn_search_guard.py` (42 lines, Python stdlib).
- Created `.claude/settings.local.json` with PreToolUse matcher (not committed).
- Created `tests/test_websearch_hook_guard.py` (14 tests).
- Updated `notes/PROJECT_STATE.md`, `notes/ACTIVE_TASK.md`, `notes/EXPERIMENT_LOG.md`, `notes/DECISION_CANDIDATES.md`.

**Commands run:**
- `python -m pytest tests/ -v` (464/464 pass)
- `python -m py_compile .claude/hooks/websearch_krn_search_guard.py` (clean)
- Manual stdin tests: WebSearch → ask, WebFetch → ask, Bash → no output.

**Test results:** 464/464 pass (450 + 14 new hook tests). 11/11 eval-corpus pass.

**Key design decisions:**
- Used `importlib.util` for test imports (no package structure needed).
- Hook fails open on malformed input (exit 0, no output).
- No deprecated `decision`/`reason` fields — uses `hookSpecificOutput.permissionDecision`.
- `settings.local.json` is globally gitignored — cannot be accidentally committed.

**WebSearch/WebFetch used in this task:** No.

**Decision:** Hook implemented and active locally. Ready for dogfood.

**Next recommended action:** Dogfood by intentionally attempting WebSearch in real workflow.

## 2026-05-11 — MVP-1F.5 WebSearch/WebFetch Hook Design

**Goal:** Design a PreToolUse hook that asks before WebSearch/WebFetch when krn-search should be tried first.

**Baseline commit:** `6f52df6a41e42190a3061fe8c0e81599f58bcb8b`

**What changed:**
- Created `notes/MVP1F5_WEBSEARCH_HOOK_DESIGN.md` design memo.
- Updated `notes/PROJECT_STATE.md`, `notes/ACTIVE_TASK.md`, `notes/EXPERIMENT_LOG.md`, `notes/DECISION_CANDIDATES.md`.

**Trigger incident:** During the first attempt at this task, Claude Code attempted to use WebSearch to research hook documentation. The user rejected the tool call. This confirmed that soft policy (CLAUDE.md, skills) is insufficient and a mechanical guard is needed.

**Commands run:**
- `python -m pytest tests/ -v` (450/450 pass)
- `python -m py_compile search_tool/*.py` (clean)
- `git diff --check` (clean)
- `python -m search_tool eval-corpus tests/fixtures/search_corpus/basic.json --work-dir "$(mktemp -d)"` (11/11 pass)

**Test results:** 450/450 pass, 11/11 eval-corpus pass. No runtime changes.

**Decision:** Mode C (ask permission with coaching message) recommended. First implementation targets `.claude/settings.local.json`.

**WebSearch/WebFetch used in this task:** No.

**Next recommended action:** MVP-1F.6 — implement local-only hook (implemented as ask-mode, later upgraded to deny-with-recovery in MVP-1G.0).

## 2026-05-11 — MVP-1F.4.1 Fix CLAUDE.md SearXNG Non-Goal Wording

**Goal:** Fix documentation contradiction where CLAUDE.md listed SearXNG as a hard non-goal but the tool ships a SearXNG provider.

**Baseline commit:** `d0eb4c10fd2d7f41fe876f9898fb8db7983e968f`

**What changed:**
- CLAUDE.md: "SearXNG" → "SearXNG as a required runtime dependency; optional explicit provider allowed only through ACTIVE_TASK.md-scoped work"
- Updated `notes/PROJECT_STATE.md`, `notes/ACTIVE_TASK.md`, `notes/EXPERIMENT_LOG.md`, `notes/DECISION_CANDIDATES.md`.

**Test results:** 450/450 pass, 11/11 eval-corpus pass. No runtime changes.

**Decision:** Docs-only fix. Scope discipline preserved.

**Next recommended action:** MVP-1F.5 WebSearch hook design.

## 2026-05-11 — MVP-1F.4 Dogfood krn-search-research Skill

**Goal:** Test whether the krn-search-research skill and slash command are usable in real workflow.

**Baseline commit:** `defce2e76c313d93fbbb98730e1634e39443d18d`

**What changed:**
- Created `notes/MVP1F4_KRN_SEARCH_RESEARCH_SKILL_DOGFOODING.md` report.
- Updated `notes/PROJECT_STATE.md` and `notes/ACTIVE_TASK.md`.

**Commands run:**
- `python -m pytest tests/ -v` (450/450 pass)
- `python -m py_compile search_tool/*.py` (clean)
- `git diff --check` (clean)
- `python -m search_tool eval-corpus tests/fixtures/search_corpus/basic.json --work-dir "$(mktemp -d)"` (11/11 pass)
- `python -m search_tool search-query "Is Python http.server safe for production" --provider static --candidate-url "https://docs.python.org/3/library/http.server.html" --max-candidates 1 --follow-redirects` (1/1 success, 3/3 quality)
- `python -m search_tool search-query "Claude Code hooks PreToolUse WebSearch WebFetch" --provider searxng --searxng-url "http://localhost:9999" --max-candidates 5 --follow-redirects` (3/5 success, 2 redirect loop failures)

**Test results:** 450/450 pass, 11/11 eval-corpus pass. No runtime changes.

**Key findings:**
- Skill workflow is comfortable. Both scenarios completed without code bugs.
- Manifests easy to inspect. Evidence reading order clear.
- Failure honesty works: redirect loops reported, not hidden.
- One docs contradiction: CLAUDE.md lists SearXNG as hard non-goal but tool ships SearXNG provider.
- No WebSearch fallback triggered — krn-search evidence sufficient for both scenarios.

**Decision:** Skill dogfooding passed. Ready for WebSearch hook design.

**Next recommended action:** Fix CLAUDE.md SearXNG non-goal wording, then design WebSearch hook.

## 2026-05-11 — MVP-1F.3 Claude Code Skills/Rules

**Goal:** Create Claude Code project-level skills/rules for krn-search usage.

**Baseline commit:** `36050b5a1738f2f9af733fe3dee051ba227fd643`

**What changed:**
- Created `.claude/skills/krn-search-research/SKILL.md` with full workflow instructions.
- Created `.claude/commands/krn-search-research.md` as user-invoked slash command.
- Added krn-search usage policy section to `CLAUDE.md`.
- Created `notes/MVP1F3_CLAUDE_CODE_SKILLS_RULES_DESIGN.md` design note.
- Updated `notes/PROJECT_STATE.md` and `notes/ACTIVE_TASK.md`.

**Commands run:**
- `python -m pytest tests/ -v` (450/450 pass)
- `python -m py_compile search_tool/*.py` (clean)
- `git diff --check` (clean)
- `python -m search_tool eval-corpus tests/fixtures/search_corpus/basic.json --work-dir "$(mktemp -d)"` (11/11 pass)

**Test results:** 450/450 pass, 11/11 eval-corpus pass. No runtime changes.

**Decision:** Skills/rules created. Hooks deferred. No settings.json changes.

**Next recommended action:** Dogfood skill in Claude Code with real tasks.

## 2026-05-11 — MVP-1F.2.1 Fix UI QUAL undefined/3

**Goal:** Fix UI quality column showing `undefined/3`.

**Baseline commit:** `5753681bf99756772981ef1e589dfb15ab2d5572`

**What changed:**
- `search_tool/ui.py`: Added `quality_score` to each evidence result in API response via `_quality_score()`. Added safe integer fallback in HTML template.
- `tests/test_ui.py`: 3 new tests — quality_score in API, quality values match expected, HTML no undefined/3.

**Commands run:**
- `python -m pytest tests/test_ui.py -v` (17/17 pass)
- `python -m pytest tests/ -v` (450/450 pass)
- `python -m py_compile search_tool/*.py`
- `git diff --check`

**Test results:** 450/450 pass (3 new UI tests).

**Acceptance verdict:** ACCEPT_MVP1F2.1

## 2026-05-11 — MVP-1F.2 Claude Code Dogfooding Report

**Goal:** Dogfood krn-search from Claude Code user perspective. Report-only, no code changes.

**Baseline commit:** `03017432ad74b591ff1da0b5e64a11a20c182dbe`

**What changed:**
- Created `notes/MVP1F2_CLAUDE_CODE_DOGFOODING_REPORT.md`.
- Updated `notes/PROJECT_STATE.md` and `notes/ACTIVE_TASK.md`.

**Commands run:**
- `python -m search_tool search-query` (4 scenarios: static, searxng, failure honesty)
- `python -m search_tool ui --port 8765` (manual UI test)
- `python -m pytest tests/ -v` (447/447 pass)
- `python -m search_tool eval-corpus` (11/11 pass)

**Key findings:**
- Static docs fetch: excellent evidence quality (1678 lines, 3/3).
- SearXNG live query: 3/5 succeeded, 2 failed (Reddit 301, Medium 403), 1 PDF skipped.
- UI bug: QUAL column shows `undefined/3` — `quality_score` not in `EvidenceWriteResult`.
- `--work-dir` missing from `search-query` CLI.
- Failure honesty: file:// and localhost correctly blocked with visible reasons.

**Recommendation:** Create Claude Code skills/rules. Defer WebSearch prevention hook.

## 2026-05-11 — MVP-1F.1 UI Search Diagnostics and Isolation Fix

**Goal:** Improve UI search diagnostics and ensure artifact isolation under the UI work directory.

**Baseline commit:** `b3b0dd3a957c59504816572fcadd8cce6b21adc5`

**What changed:**
- Updated `search_tool/ui.py` with detailed discovery and ingestion summaries.
- Implemented run-specific subdirectory isolation for evidence.
- Sanitized SearXNG provider URLs in API responses.
- Updated `tests/test_ui.py` to verify isolation and summaries.
- Updated `README.md`, `ACTIVE_TASK.md`, and `PROJECT_STATE.md`.

**Commands run:**
- `python -m pytest tests/test_ui.py -v`
- `python -m pytest tests/ -v`
- `python -m search_tool eval-corpus tests/fixtures/search_corpus/basic.json --work-dir /tmp/eval_work_dir`

**Test results:**
- Full pytest suite: 439/439 passed
- UI specific tests: 12/12 passed
- Manual verification of isolation: PASS (artifacts in `runs/`)

**Acceptance verdict:** ACCEPT_MVP1F1

**Next recommended action:** Proceed to krn-ai-os integration.

**Goal:** Formally evaluate and accept the deterministic evaluation corpus implementation.

**Baseline commit:** `dd5b8ebe13f3a54c77606b7e14d3265171e6b098`

**What changed:**
- Created `notes/MVP1E11_DETERMINISTIC_EVAL_CORPUS_EVALUATION.md`.
- Updated `notes/PROJECT_STATE.md` and `notes/ACTIVE_TASK.md`.

**Commands run:**
- `.venv/bin/python -m pytest tests/ -v`
- `python -m search_tool eval-corpus tests/fixtures/search_corpus/basic.json --work-dir /tmp/eval_work_dir`

**Test results:**
- Full pytest suite: 420/420 passed
- Eval-corpus scenarios: 11/11 passed
- JSON stdout parse check: PASS

**Acceptance verdict:** ACCEPT_MVP1E11

**Next recommended action:** MVP-1E.12 — Generate and evaluate search pipeline evaluation report.

**Should this influence krn-ai-os?** Yes. Deterministic evaluation is a critical pattern for safe search tool integration.

**Durable candidates:** No new durable candidates emerged in this acceptance phase.

## 2026-05-11 — MVP-1E.12 Final Search Pipeline Evaluation Report
**Goal:** Create a final docs-only pipeline evaluation report summarizing the current state of krn-search.
**Baseline commit:** `b45ad682cceeafd3494e76130514d8d28a8ded1f`
**What changed:** Created `notes/MVP1E12_FINAL_SEARCH_PIPELINE_EVALUATION_REPORT.md`, updated project documentation.
**Commands run:** `pytest`, `eval-corpus`, `py_compile`, `git status`.
**Test results:** 420/420 pytest pass, 11/11 eval-corpus pass.
**Final verdict:** krn-search is a usable deterministic local search/ingestion pipeline MVP.
**Next recommended action:** Stop feature expansion and proceed to krn-ai-os integration or CI stabilization.
**Should this influence krn-ai-os?** Yes, it provides a safe, deterministic ingestion primitive.
