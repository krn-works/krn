# Project State

**Last updated:** 2026-05-25 (MVP-1U.1 accepted: interactive Claude Code search flow)

## Repo

`korneliuszburian/krn-search`

## Current phase

Baseline: 1084/1084 tests, 11/11 eval-corpus. HEAD: `aba0a2c`.

- MVP-1T.1 merged/accepted in `47feef1`: controlled search MVP closeout accepted as `ACCEPT_CONTROLLED_SEARCH_MVP`. The repository is good enough as a Claude Code `/search`-style evidence-pack tool under the controlled-ingestion contract: SearXNG-required research discovery, no silent static fallback, explicit known-URL static override, health/readiness checks, session directories, session summaries, snippets, relevance, run history, and real `provider=searxng` dogfood proof. Recommended next phase: `STOP_AND_USE` before further feature expansion; only implement MVP-1U source quality/result filtering after real pain appears. Report at `notes/MVP1T1_CONTROLLED_SEARCH_MVP_CLOSEOUT.md`.

- MVP-1U.0 merged/accepted in `52d26b5`: plug-and-play SearXNG bootstrap for Claude Code research flow. New CLI operator path `krn-search searxng status|up|down` provides deterministic local bootstrap on `localhost:9999`, patches the current image-default `settings.yml` to enable JSON output plus a non-default `server.secret_key`, writes config outside the repo (`$XDG_CACHE_HOME/krn-search/searxng` or `/tmp/krn-search-searxng-pnp-<uid>`), and waits for `health --research --wait 30`. `.claude` command/skill surfaces and packaged templates now call bootstrap/status before `search-query --research`. Live operator dogfood passed (`curl` HTTP `200`, `health --research` ok, `search-query --research` via `provider=searxng`). Decision remains `ACCEPT_CLAUDE_CODE_SEARCH_PLUGIN_BOOTSTRAP`; remaining proof is an interactive `/krn-search-research` manual run. Report at `notes/MVP1U0_SEARXNG_PLUG_AND_PLAY_BOOTSTRAP.md`.

- MVP-1U.1 accepted: interactive Claude Code search flow proof completed. After stopping the backend first, the real `/krn-search-research` flow ran `krn-search searxng status`, observed connection refusal, ran `krn-search searxng up`, and then ran `krn-search search-query "latest methodologies for creating AI agents" --research`. The run used `provider=searxng`, produced `candidates_total=10`, `selected_for_fetch=10`, evidence packs, and a `compact_summary_path`; Claude then read the compact summary plus an Anthropic evidence pack. The answer path was evidence-based, not a memory-only fallback. Decision: `ACCEPT_INTERACTIVE_CLAUDE_CODE_SEARCH_FLOW`. Caveat: PATH-level `krn-search` on this machine was briefly older than repo-local code, so hard operator stop/proof used `.venv/bin/python -m search_tool searxng down/up/status`; record this as a packaging/version-skew follow-up candidate, not a blocker. Report at `notes/MVP1U1_INTERACTIVE_CLAUDE_CODE_SEARCH_FLOW.md`.

- MVP-1S.1 merged/accepted. `--research` provider auto-resolution now resolves only to SearXNG and fails early when unreachable; `--candidate-url` no longer silently forces static in research mode; explicit `--provider static --candidate-url` remains supported; non-research auto with candidate URL remains static fallback-compatible. Existing provider resolution error JSON is preserved with updated `provider_resolution` reasons, `limitations`, and recovery guidance; no run/session artifacts are created on provider-resolution failure.

- MVP-1S.2 accepted: health command now supports `--research` and optional `--searxng-url`; `health --research` treats SearXNG as required for research-mode discovery and exits non-zero when unreachable. Target files included `search_tool/cli.py`, `search_tool/health.py`, `tests/test_health.py`, `tests/test_research_mode.py`, and related docs/tasks files.
- MVP-1S.3 accepted: operator dogfood completed for research-mode health UX; decision: `ACCEPT_MVP1S3_OPERATOR_UX`. Unreachable SearXNG scenarios correctly fail with actionable recovery and preflight (`health --research`), no-session artifacts are created on provider-resolution failure, and explicit `--provider static --candidate-url` remains usable as a manual override path; `--searxng-url` takes precedence over `SEARXNG_URL`.
- MVP-1S.4 attempted: local reachable SearXNG runbook executed and validated docs/reference flow, but the first startup variants were not stable in this environment. `MVP-1S.4a` documents a known-good local startup recipe with accepted `provider=auto --research` reachability (`notes/MVP1S4_REACHABLE_SEARXNG_DOGFOOD.md`, decision `NEEDS_FIX`; `notes/MVP1S4A_KNOWN_GOOD_SEARXNG_STARTUP.md`, decision `ACCEPT_REACHABLE_SEARXNG_PATH`).
- MVP-1S.5 accepted: closeout docs/decision consolidated (`notes/MVP1S_RESEARCH_MODE_RESILIENCE_CLOSEOUT.md`), including S.0 design carryover, S.1 no-static fallback behavior, S.2 fail/ok semantics, S.3 unreachable operator UX acceptance, S.4 first-attempt blocker, and S.4a reachability acceptance.
- MVP-1S.6 merged/accepted in `2687066`: operator-hardening follow-up for SearXNG readiness and smoke ergonomics. `krn-search health --research --wait <seconds>` polls SearXNG until reachable or timeout, while default `health --research` remains an immediate check. JSON health shape, non-research health behavior, `--searxng-url` precedence, search-query provider semantics, and static provider explicit override semantics remain unchanged.

- MVP-1T.0 real research dogfood executed and accepted: `ACCEPT_CONTROLLED_SEARCH_DOGFOOD`. Sessions under `.local/krn-search-runs-t0-dogfood` confirmed `provider=auto` resolves to SearXNG in live mode and generates actionable evidence/summaries without candidate URLs.

- MVP-1S.0 design complete (docs-only). Research-mode discovery is now designed as SearXNG-required: `--research` with `provider=auto` should resolve only to SearXNG, preflight the configured SearXNG endpoint, and fail with precise remediation when unreachable. Static provider remains available only as an explicit known-URL/manual/test override via `--provider static --candidate-url ...`; it must not be an automatic research-mode fallback. Existing general/non-research provider behavior should stay backward-compatible. Recommended slices: S.1 research provider resolution/error UX, then S.2 research health check/docs sync. Design memo at `notes/MVP1S0_SEARXNG_REQUIRED_RESEARCH_MODE_DESIGN.md`. No code, schema, dependency, provider refactor, evidence pack, database, browser, MCP, or AI-synthesis changes in S.0.

- MVP-1R accepted. The research session layer now covers design, deterministic session directory/metadata, `--session` search-query wiring, on-demand `session-summary`, source snippets, end-to-end dogfood, and the R.4 run-history counter fix. The layer remains directory-based and mechanical: no AI synthesis, database, new dependencies, schema churn, provider/discovery/search-query ergonomics change, or evidence pack change in the closeout. Closeout report at `notes/MVP1R_RESEARCH_SESSION_LAYER_CLOSEOUT.md`. Recommended next phase: MVP-1S research-mode resilience/operator ergonomics, or a separate Codex native-web enforcement audit if operations take priority.

- MVP-1R.4 complete. Small deterministic bugfix for the R.3 follow-up where `session-summary.md` run-history URL counters could show zero when run artifacts had successful `evidence_results`. Session summary now uses explicit `fetch` counters when present and falls back to mechanical counts from existing `evidence_results[]` when explicit counters are absent or zero; follow-up PR #26 keeps blocked and failed fallback counters separate in the run-history table. Regression covers the dogfood-shaped artifact and rendered run-history markdown. No schema, dependency, provider/discovery/search-query, evidence pack, relevance, or snippet path-safety changes. Verification: 1053/1053 tests, 11/11 eval-corpus. Report at `notes/MVP1R4_RUN_HISTORY_COUNTERS.md`.

- MVP-1R.3 dogfood complete (docs-only). End-to-end session workflow validated using existing CLI (`search-query --research --session`, two runs in one session, `session-summary` generation). Artifacts were generated under `.local/krn-search-runs-r3-dogfood/sessions/session-966dbe334942/` and inspected (`session.yaml`, per-run `search-run.json`, `session-summary.md`). Summary sections for run history, unique sources, relevance, overlap, and source snippets are present. Environment showed expected `--research` auto-provider friction when local SearXNG is unreachable; dogfood completed via explicit static-provider override. Follow-up candidate documented: session-summary run-history URL counters were zero in this scenario despite successful evidence results. Report at `notes/MVP1R3_RESEARCH_SESSION_DOGFOOD.md`.

- MVP-1R.2a merged. Session summaries now include a `## Source Snippets` table populated by mechanical extraction from existing run artifacts. Snippet source order: existing `snippet`, `excerpt`, or `content` fields from `search-run.json`; fallback to existing evidence pack paths recorded in `evidence_path` only when the resolved path stays inside the current run directory. Absolute paths and traversal outside `run_dir` are rejected. Snippets are capped at 1000 characters, Markdown table cells are escaped/single-lined, missing snippet data renders empty, and unreadable evidence paths record a limitation without aborting summary generation. No evidence schema changes, run manifest schema changes, session metadata schema changes, dependencies, provider refactors, database/MCP/hooks, or search-query behavior changes. Report at `notes/MVP1R2A_SESSION_SUMMARY_SNIPPETS.md`.

- Codex repo-local operating layer added. `.codex/config.toml` registers 6 skills (`coding-system`, `grill`, `debug`, `implementation`, `review`, `handoff`); `.codex/agents/` defines `explorer`, `reviewer`, and `worker`; `AGENTS.md` is the Codex repo contract; `docs/agents/` documents the operating model. Claude Code surfaces remain under `.claude/` and `CLAUDE.md`. Codex debug probe confirmed `AGENTS.md` and repo-local skills load into model-visible context. Codex deterministic native-web enforcement is not yet audited.

- MVP-1R.2 complete and merged. Session summary command and generator. `krn-search session-summary --work-dir <dir> (--session <topic> | --session-id <id>) [--output <file>]`. Exactly-one selector validation, default output path under `sessions/<session-id>/session-summary.md`, custom output path support, valid `session.yaml` metadata reading, missing/corrupt metadata limitation plus fallback to run artifact scanning, best relevance per source as max `evidence_relevance[].score` across runs. Source snippets deferred to MVP-1R.2a. 1049/1049 tests, 11/11 eval-corpus.

- MVP-1R.1 complete and merged. Session directory and metadata. `search_tool/session.py`: session directory structure, session.yaml read/write/append, corrupted metadata recovery. `--session <topic>` on search-query. Deterministic session ID (`session-<sha256(topic)[:12]>`), same topic = same session. Shared cache. Best-effort metadata writes. Additive `session` key in JSON output. 1037/1037 tests, 11/11 eval-corpus. Report at `notes/MVP1R1_SESSION_DIRECTORY_METADATA.md`.
- Calibration/relevance candidates remain unchanged from MVP-1Q.

- MVP-1R.0 design complete. Research session layer architecture. Session = directory of runs with metadata (session.yaml), agent drives strategy, session observes and reports. Cross-run dedup observational, best relevance per source, shared cache, best-effort metadata. Design at `docs/architecture/research-session-design.md`. Memo at `notes/MVP1R0_RESEARCH_SESSION_DESIGN.md`. Staged: R.1 (dir+metadata, done), R.2 (summary, done), R.2a (snippets, done), R.3 (dogfood).

- MVP-1Q complete. Deterministic, non-LLM relevance scoring. Two signals: candidate relevance (pre-fetch) and evidence relevance (post-fetch). Query-run metadata only — no reranking, no filtering. Compact summary relevance column. Dogfood/calibration complete with no blockers. Calibration candidates deferred. Closeout at `notes/MVP1Q_RELEVANCE_LAYER_CLOSEOUT.md`.

MVP-1J.3 complete. Regression dogfood confirmed all 4 J.2 fixes. J.3 added: (1) "Skip to content" to nav chrome strip list; (2) backslash separator artifact cleanup in frontmatter title fallback ("Building Effective AI Agents \\ Anthropic" → "Building Effective AI Agents - Anthropic"). 656/656 tests pass. Static fallback 8/8 success on curated research URLs.

MVP-1K.4 complete. Shell-safe launcher strategy: primary portable story is `krn-search` executable; editable fallback via KRN_SEARCH_BIN with explicit bash-vs-zsh warning. KRN_SEARCH_BIN kept as internal/advanced override. No runtime changes. Design memo at `notes/MVP1K1_PORTABLE_RESEARCH_KIT_DESIGN.md`. 656/656 tests pass.

MVP-1K.5 complete. `krn-search init-claude` bootstrap command implemented. Copies `.claude` artifacts from packaged templates using `importlib.resources`. CLI: `krn-search init-claude [--target-dir PATH] [--dry-run] [--force] [--with-hook]`. 680/680 tests pass. Report at `notes/MVP1K5_INIT_CLAUDE_BOOTSTRAP.md`.

MVP-1K.7 complete. Tiny hygiene: fixed two test methods in `tests/test_init_claude.py` missing `test_` prefix. 26/26 init-claude tests, 682/682 full suite. Report at `notes/MVP1K7_HYGIENE_DEAD_TEST_FIX.md`.

MVP-1K.6 complete. Fresh install dogfood: `krn-search init-claude` verified in a brand-new temp directory with a fresh pip install (non-editable mode). 10/10 scenarios pass. Report at `notes/MVP1K6_FRESH_INSTALL_DOGFOOD.md`.

## MVP-1L status

MVP-1L.1 design complete. MVP-1L.2 implementation complete. MVP-1L.3 UX/profile polish complete. MVP-1L.4 real-world dogfood complete (ACCEPT_LLMS_PROVIDER). MVP-1L.5 parser warnings JSON polish complete. Design memo at `notes/MVP1L1_LLMS_TXT_DESIGN.md`. Implementation reports: L.2 at `notes/MVP1L2_LLMS_PROVIDER_IMPLEMENTATION.md`, L.3 at `notes/MVP1L3_LLMS_UX_PROFILE_POLISH.md`, L.4 at `notes/MVP1L4_LLMS_REAL_WORLD_DOGFOOD.md`, L.5 at `notes/MVP1L5_LLMS_WARNINGS_JSON.md`. New discovery provider `llms` with lightweight markdown parsing (supports `-` and `*` bullets), deterministic keyword scoring, relative URL resolution, dedup, scheme blocking. `llms-docs` profile added. Three URL aliases: `--url`, `--llms-url`, `--docs-index-url`. Source URL redirect following via `--follow-redirects`. `search-query --provider llms` stores llms_url on provider instance (L.4 fix). Parser warnings surfaced in limitations with `llms parser warning:` prefix (L.5). 800/800 tests pass.

## MVP-1M status

MVP-1M.1 design complete. MVP-1M.2 implementation complete. MVP-1M.2a dogfood complete (ACCEPT_CANONICAL_DEDUP). MVP-1M.3 design complete. MVP-1M.4 mark-only final_url dedup complete. MVP-1M.4a dogfood complete (ACCEPT_FINAL_URL_MARK_ONLY). MVP-1M.5 skip/extract dedup design complete. MVP-1M.6 mark+reference metadata complete (add `dedup_status`, `duplicate_of_url`, `duplicate_of_evidence_path` to `EvidenceWriteResult`; dedup loop populates metadata on duplicates). MVP-1M.6a dogfood complete (ACCEPT_DEDUP_METADATA — all 6 scenarios pass, no fixes needed). MVP-1M.7 skip extraction complete (add `_final_url_dedup_registry` to `fetch_url_to_evidence()`, pre-extraction dedup check, synthetic `skipped_duplicate` result; change limitation wording to "Skipped"; update manifests and JSON status). MVP-1M.7a skip dogfood bugfix complete (fix: `final_url_override = normalized` for non-redirected URLs when `follow_redirects=True`; secondary fix: post-processing runs before manifest writes so "Skipped N" limitation appears in JSON and manifest). MVP-1M.7b final dedup regression dogfood complete (fix: compact writer limitation dedup — remove concatenation of result.limitations + discovery.limitations since result.limitations already includes discovery limitations). 890/890 tests pass. Eval 11/11. Design memo at `notes/MVP1M5_SKIP_DEDUP_DESIGN.md`. Report at `notes/MVP1M7_SKIP_DUPLICATE_EXTRACTION.md`. Bugfix report at `notes/MVP1M7A_FINAL_URL_SKIP_DOGFOOD_BUGFIX.md`. Regression report at `notes/MVP1M7B_FINAL_DEDUP_REGRESSION_DOGFOOD.md`. MVP-1M.8 dedup hygiene cleanup complete (MVP-1M.8): removed unused `policy`, `refresh`, `evidence_dir` params from `_maybe_skip_duplicate()` and both call sites; replaced unused `kept_idx` with `_` in `search_query()` dedup loop. 890/890 tests pass. Report at `notes/MVP1M8_DEDUP_HYGIENE.md`.

## MVP-1P status

MVP-1P complete. Docs-only search vs research architecture note at `docs/architecture/search-vs-research.md`. Defines search vs research mode distinction, current repo capabilities, failure modes, non-goals, staged roadmap. No code changes. No new dependencies. See `notes/EXPERIMENT_LOG.md` for session record.

## MVP-1P.1 status

Complete. Discovery diagnostics artifact (`discovery-diagnostics.json`) records per-candidate discovery-stage accounting: rank, URL, title, snippet, source_engine, source_quality classification. Added `discovery_diagnostics_path` to `SearchRunResult`. Written during `search_query()` when `evidence_dir` is set. Report at `notes/MVP1P1_DISCOVERY_DIAGNOSTICS.md`. 922/922 tests pass.

## MVP-1Q status

MVP-1Q.0 design complete. MVP-1Q.1 candidate relevance complete. MVP-1Q.2 evidence relevance complete. MVP-1Q.3 compact summary relevance visibility complete. Deterministic, non-LLM relevance scoring. Two signals: candidate relevance (pre-fetch, textual overlap with title/snippet/URL) and evidence relevance (post-fetch, textual overlap with extracted content). Full design at `docs/architecture/deterministic-relevance-scoring.md`. Staged plan: Q.1 candidate metadata (done), Q.2 evidence metadata (done), Q.3 compact summary (done), Q.4 dogfood. Reports: `notes/MVP1Q0_RELEVANCE_SCORING_DESIGN.md`, `notes/MVP1Q1_CANDIDATE_RELEVANCE.md`, `notes/MVP1Q2_EVIDENCE_RELEVANCE.md`, `notes/MVP1Q3_COMPACT_RELEVANCE_VISIBILITY.md`.

MVP-1Q.1: New module `search_tool/relevance.py` with `tokenize_query()`, `score_candidate_relevance()`, dataclasses `QueryTokens`, `CandidateComponents`, `CandidateRelevance`. Whole-token matching via `_text_tokens()` frozenset prevents short-token false positives (AI matching inside "main"). Scoring: 0.40*title + 0.25*snippet + 0.15*url_path + 0.20*exact_phrase_bonus, clamped [0.0, 1.0], plus source quality modifier and generic page penalty. Integrated into `write_discovery_diagnostics()` — additive `candidate_relevance` field on each `selected_candidates[]` entry. 959/959 tests, 11/11 eval. No behavior changes to discovery, fetch, extraction, ranking, or filtering.

MVP-1Q.2: `score_evidence_relevance()` added to `search_tool/relevance.py` with `EvidenceComponents`, `EvidenceRelevance` dataclasses. Post-fetch textual overlap: text, headings (from code fence `#` lines), early content (first 2000 chars), content density (nav chrome removal via `_NAV_CHROME_LINES`). Scoring: 0.30*text_overlap + 0.15*heading_match + 0.25*early_content_overlap + 0.10*content_density + 0.20*exact_phrase_bonus, clamped [0.0, 1.0], plus low_content_penalty. Truncated extraction is scoreable. Query-run metadata only: `EvidenceRelevanceEntry` on `SearchRunResult`, CLI JSON (full components), search-run manifest YAML (lightweight: url + score). Failed/blocked/skipped/failed extraction returns 0.0. 984/984 tests, 11/11 eval. No behavior changes to discovery, fetch, extraction, ranking, filtering, compact summaries, or evidence packs.

## MVP-1F.5 status

Design-only. Memo at `notes/MVP1F5_WEBSEARCH_HOOK_DESIGN.md`. Mode C (ask permission with coaching message) recommended. First implementation targets `.claude/settings.local.json`. No hook code, no settings changes. 450/450 tests pass.

## MVP-1F.4 status

Accepted. krn-search-research skill dogfooded with 2 scenarios (static docs, SearXNG live). Both passed. Report at `notes/MVP1F4_KRN_SEARCH_RESEARCH_SKILL_DOGFOODING.md`. One docs contradiction found and fixed in MVP-1F.4.1. No code bugs. 450/450 tests pass.

## MVP-1F.3 status

Accepted. Claude Code skill (`.claude/skills/krn-search-research/SKILL.md`), slash command (`.claude/commands/krn-search-research.md`), and CLAUDE.md usage policy section created. No hooks, no MCP, no runtime changes. 450/450 tests pass.

## MVP-1F.2.1 status

Accepted. UI quality column bug fixed. `quality_score` added to API response using `_quality_score()` helper. Frontend uses safe integer fallback. 3 new UI tests. 450/450 pass.

## MVP-1F.2 status

Accepted. krn-search is useful as a local Claude Code ingestion primitive. 4 scenarios tested (static docs, live SearXNG, UI manual, failure honesty). Key finding: UI QUAL column bug (`undefined/3`). Recommendation: create skills/rules now, defer WebSearch prevention hook. Report at `notes/MVP1F2_CLAUDE_CODE_DOGFOODING_REPORT.md`.

## MVP-1F.1 status

Accepted. UI search diagnostics improved with detailed discovery and ingestion summaries. Artifact isolation implemented using run-specific subdirectories under the UI work directory. SearXNG provider URLs are sanitized in the API response. All 12 UI tests and 439 project tests pass.

## MVP-1F.0 status

Accepted. Local minimal UI testbench implemented in `search_tool/ui.py`. CLI subcommand `ui` added. Allows manual verification of `search-query` and `eval-corpus`.

## MVP-1E.12 status

Accepted. Final search pipeline evaluation report written to `notes/MVP1E12_FINAL_SEARCH_PIPELINE_EVALUATION_REPORT.md`. Overall status: deterministic local search/ingestion MVP complete.

## MVP-1E.11 status

Accepted. Deterministic evaluation corpus runner implemented and verified. 11/11 scenarios passing. CLI command `eval-corpus` added. Evaluation memo at `notes/MVP1E11_DETERMINISTIC_EVAL_CORPUS_EVALUATION.md`.

## MVP-1E.10 status

Accepted. Search pipeline evaluation corpus design complete. Strategy C (Hybrid Corpus) recommended. Design memo at `notes/MVP1E10_SEARCH_PIPELINE_EVALUATION_CORPUS_DESIGN.md`.

## MVP-1E.9 status

Accepted. search-run manifest (v0.1) implemented and verified. Evaluation at `notes/MVP1E9_SEARCH_RUN_MANIFEST_EVALUATION.md`. 410/410 tests pass.

## MVP-1E.8 status

Accepted. Design complete. Strategy C (Search-run manifest only) recommended. Design memo at `notes/MVP1E8_SEARCH_RUN_MANIFEST_DESIGN.md`.

## MVP-1E.4 status

Accepted. Evaluation at `notes/MVP1E4_SEARXNG_PROVIDER_EVALUATION.md`. 32/32 checklist items PASS. SearxngDiscoveryProvider verified against design contract. No non-goals violated.

## MVP-1E.5 status

Accepted. Evaluation at `notes/MVP1E5_DISCOVER_QUERY_CLI_EVALUATION.md`. 34/34 checklist items PASS. discover-query CLI verified against design contract. No non-goals violated.

## MVP-1D status

Accepted. Query discovery design memo written. Spike thesis proven. Reopen decision recorded in `notes/MVP1E_REOPEN_AND_WORKFLOW.md`.

## MVP-1C status

Accepted. All 7 dependency documentation entries verified. 231/231 tests pass.

## MVP-1B status

Accepted. 231/231 tests pass. Controlled redirect following is a verified capability. Evaluation at `notes/MVP1B_REDIRECT_FOLLOWING_EVALUATION.md`.

## MVP-1A status

Accepted. 200/200 tests pass. Manifest evidence-set primitive verified. Evaluation at `notes/MVP1A_FETCH_LIST_EVALUATION.md`.

## MVP-0 status

Accepted. All 8 gate criteria met. 170/170 tests pass.

## MVP-1E.6 status

Design complete. Architecture B (separate `search_tool/search.py` module) recommended. Option 1 artifacts (evidence packs + manifest only) for MVP-1E.7. Design memo at `notes/MVP1E6_SEARCH_QUERY_COMPOSITION_DESIGN.md`.

## MVP-1E.7 status

Accepted. Evaluation at `notes/MVP1E7_SEARCH_QUERY_COMPOSITION_EVALUATION.md`. 40/40 checklist items PASS. `search_tool/search.py` with `SearchRunResult` dataclass and `search_query()` function. CLI subcommand `search-query` added. 398/398 tests pass (371 baseline + 27 new). Artifacts: evidence packs + fetch-list manifest only. No search-run manifest. No discovery JSON persistence.

## MVP-1H.6 status

Complete. Dogfood evaluation of research mode preset. 5 scenarios tested: static research mode (PASS), override research mode (PASS), error honesty (PASS), skill/command docs review (PASS), hook recovery (PASS). Acceptance verdict: ACCEPT_MVP1H5. Report at `notes/MVP1H6_RESEARCH_MODE_DOGFOODING.md`. 637/637 tests pass.

## MVP-1H workflow summary

The MVP-1H series (MVP-1H.1 through MVP-1H.6) delivered:
- Deterministic source quality metadata (URL/domain heuristics)
- Compact evidence index (mechanical progressive disclosure)
- Deterministic query profiles (official-docs, github-repo, security-research)
- Research mode preset (`--research` flag)
- Full dogfooding acceptance

Preferred research command: `/krn-search-research`, which should now bootstrap through `krn-search searxng status|up` before `krn-search search-query "<query>" --research`.

## MVP-1H.5 status

Complete. Research mode preset implemented on `search-query`. `--research` flag expands to: provider=auto, json=true, compact=true, profile=official-docs, work-dir=.local/krn-search-runs, follow-redirects=true. Explicit flags override defaults. JSON output includes `research_mode` object with `expanded_defaults` and `effective_values`. Error JSON includes `research_mode`. `--no-compact` and `--no-follow-redirects` negation flags added via `BooleanOptionalAction`. `--provider` is now optional (required without `--research`, defaults to `auto` with `--research`). 637/637 tests pass. 21 new tests.

## MVP-1I.1 status

Complete. Deterministic CI gate at `.github/workflows/ci.yml`. Runs on push/PR to main. Checks: compile, whitespace, pytest (637/637), eval-corpus (11/11, fully mocked, network-free), research-mode invalid-profile error JSON (network-free preflight), research-mode preflight structure validation (network-free). No SearXNG required. No live network research. Mirrors local acceptance checks.

## MVP-1H.4 status

## Last decision

RESEARCH_MODE_PRESET_OPTION_B. `--research` flag on `search-query` expands to deterministic research defaults. Smallest surface, no CLI duplication, backward compatible. Implemented in MVP-1H.5. 637/637 tests pass.

## Current CLI

- `krn-search fetch-url <url> [--refresh] [--follow-redirects]`
- `krn-search fetch-list <urls.txt> [--refresh] [--follow-redirects]`
- `krn-search discover-query "<query>" --provider static|searxng|llms|auto [options]`
- `krn-search search-query "<query>" --provider static|searxng|llms|auto [provider options] [--refresh] [--follow-redirects|--no-follow-redirects] [--work-dir <dir>] [--json] [--compact|--no-compact] [--profile <name>] [--research] [--session <topic>]`
- `krn-search session-summary --work-dir <dir> (--session <topic> | --session-id <id>) [--output <file>]`
- `krn-search eval-corpus <corpus.json> [--work-dir <dir>]`
- `krn-search ui [--port <port>] [--host <host>] [--work-dir <dir>]`
- `krn-search health [--json] [--work-dir <dir>]`
- `krn-search searxng status|up|down`
- `krn-search init-claude [--target-dir PATH] [--dry-run] [--force] [--with-hook]`

## Important commits

| Short | Full | Message |
|-------|------|---------|
| `5dd21c9` | `5dd21c9851356cba395e5018aa38df1d22b58d37` | chore: add repo-local codex skills |
| `b3a15f3` | `b3a15f36acddfb99b477d5eda56a61d89181546e` | feat: complete research session summary implementation (#22) |
| `b7be6ec` | `b7be6ec5c11f288a17c604ffdfa59f064049f501` | docs: evaluate search-query composition |
| `69ec460` | `69ec4600fb8801bcd2d08eced97114985b05247a` | docs: fix search-query handoff metadata |
| `ecca5fd` | `ecca5fd470d6c81f63e088dbc1c944df140bc917` | feat: add search-query composition |
| `3acb1ef` | `3acb1ef024315ea93da938809300d79f80113514` | docs: design search-query composition |
| `bffca04` | `bffca046130c796e587e8540785b5551f9d9fc17` | docs: evaluate discover-query cli |
| `72160d8` | `72160d83b5d0c93d761dcd9d1356545ea1721c4e` | feat: add discover-query cli |
| `aaa35aa` | `aaa35aa8b274b5bd0a39e8592caa0eb7f8855e64` | fix: harden searxng failure honesty |
| `fb2e24e` | `fb2e24ebd66187f6ee28e0e7aa0bb68dd0813310` | feat: add searxng discovery provider |
| `f7d5e01` | `f7d5e011bbac7f0ab2e69b56ade6a927ac53eb1f` | docs: verify searxng provider design |
| `1a0a60d` | `1a0a60d7b8f7195cc9167f9309d7935962e0bfff` | feat: add static discovery provider |
| `7beb80a` | `7beb80ab86627eed161aac5fb859a746d6628510` | feat: add discovery contract types |
| `45fd3b6` | `45fd3b69be26db64e7febc536777395bf966ac3d` | docs: design query discovery layer |
| `1923d20` | `1923d20bbe646fb94d83f2f5347ff99e1266323f` | docs: reopen spike for query discovery |
| `b845d69` | `b845d69a77c55684cfcab5954e3c40dcf748fc67` | docs: verify dependency assumptions |
| `859c686` | `859c686d2514ed1c6f26e6a4cf028bcb265d43bc` | docs: decide MVP-1C direction |
| `529a55f` | `529a55f41d0f453eea0926ee5b01af9fb13ae81a` | docs: evaluate controlled redirect following |
| `b0c7a0d` | `b0c7a0d5377f95005be707a5f98da73b3cf991e6` | fix: set blocked_reason on redirect hop when target is blocked |
| `7b7e2b7` | `7b7e2b7f1cb9b66a76ca8a8a872684c06c5f4967` | fix: harden redirect normalization and cache config |
| `00ea205` | `00ea205f1cb9b66a76ca8a8a872684c06c5f4967` | feat: add controlled redirect following |
| `9a72248` | `9a7224877fcd5807e0cf2c70543df20d2dd7bbfd` | docs: evaluate fetch-list evidence manifest |
| `fb865d3` | `fb865d333405b98152e563e164d51624c85bf32b` | fix: harden fetch-list manifest contract |
| `9bf4790` | `9bf4790491db9c12bc034fa39c418d88d968972f` | feat: add fetch-list evidence manifest |
| `d5523a3` | `d5523a3f1cb9b66a76ca8a872684c06c5f4967` | refactor: return structured evidence write result |
| `2752399` | `275239937bc5ece7b61c6b2f26202ae7269bd845` | docs: add agent handoff and execution protocol |
| `7adfec8` | `7adfec8fc42d34d4341c82774a3acc2dc3d88287` | feat: implement controlled URL to evidence pack spike |

## Current architecture

- `search_tool/bootstrap.py` — init-claude bootstrap (template copy)
- `search_tool/cli.py` — CLI entrypoint
- `search_tool/search.py` — search query composition
- `search_tool/discovery.py` — discovery contract types, validation, providers (static, searxng)
- `search_tool/discovery_llms.py` — llms.txt discovery provider (MVP-1L.2/3/4; supports `-` and `*` bullets, llms_url on provider instance)
- `search_tool/url_policy.py` — URL validation and security policy
- `search_tool/fetch.py` — HTTP fetch
- `search_tool/extract.py` — HTML to text extraction
- `search_tool/evidence.py` — evidence pack generation
- `search_tool/cache.py` — filesystem cache (SHA256-keyed)
- `search_tool/health.py` — health checks (package import, static provider, SearXNG reachable, dir writability)
- `search_tool/source_quality.py` — deterministic source quality classification (URL/domain/title heuristics)
- `search_tool/compact.py` — compact evidence index generation (deterministic mechanical summary)
- `search_tool/profiles.py` — deterministic query profiles for source preference biasing (MVP-1L.3: add `llms-docs`)
- `search_tool/session.py` — research session directory, session.yaml metadata (MVP-1R.1)
- `search_tool/session_summary.py` — session summary aggregation and markdown output (MVP-1R.2)
- `.codex/` — repo-local Codex skills, agents, and project-scoped config
- `AGENTS.md` — Codex repo contract

## Accepted limitations

- SPA/JS-heavy sites extract nav chrome with low information density
- Redirects not followed by default (opt-in via `--follow-redirects`)
- No title extraction for pages without `<title>` tags
- No cache TTL/eviction
- `MAX_REDIRECTS = 3` is a constant, not configurable via CLI
- Redirect following increases SSRF surface area (mitigated by per-hop policy check)
- Redirect response bodies are not consumed
- No retry logic for transient provider failures
- No query cache in SearXNG provider
- Query redaction is best-effort, not a security boundary
- Manifest source_file field shows "search-query" string, not a real file path

## krn-search / krn-ai-os boundary

krn-search is the implementation home for the controlled search/ingestion tool. krn-ai-os will consume the capability later. This keeps the boundary clean and lets us test behavior independently. Query discovery adds a thin URL-producing layer above the existing `fetch-list` pipeline.

## What not to read first

Do not explore the full repo on startup. Read only `CLAUDE.md`, `notes/PROJECT_STATE.md`, `notes/ACTIVE_TASK.md`, and `notes/AGENT_PROTOCOL.md`.
