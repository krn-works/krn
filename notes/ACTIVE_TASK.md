# Active Task

**Status:** MVP-1U.1 interactive Claude Code search flow accepted.

## Last completed

- MVP-1S.0 — Designed the SearXNG-required research-mode resilience layer (`notes/MVP1S0_SEARXNG_REQUIRED_RESEARCH_MODE_DESIGN.md`).
- MVP-1S.1 — Implemented research provider resolution discipline (`notes/MVP1S1_RESEARCH_PROVIDER_RESOLUTION.md`).
- MVP-1S.2 — Added research-required health checks and `--searxng-url` (`notes/MVP1S2_RESEARCH_HEALTH_CHECK.md`).
- MVP-1S.3 — Dogfooded research health operator UX (`notes/MVP1S3_RESEARCH_HEALTH_DOGFOOD.md`).
- MVP-1S.4a — Found known-good local SearXNG startup (`notes/MVP1S4A_KNOWN_GOOD_SEARXNG_STARTUP.md`).
- MVP-1S.5 — Research-mode resilience closeout accepted (`notes/MVP1S_RESEARCH_MODE_RESILIENCE_CLOSEOUT.md`).
- MVP-1S.6 — Added deterministic readiness wait to research health (`notes/MVP1S6_SEARXNG_READINESS_HARDENING.md`).
- MVP-1R accepted (`notes/MVP1R_RESEARCH_SESSION_LAYER_CLOSEOUT.md`).
- MVP-1T.0 — Real controlled-search dogfood accepted (`notes/MVP1T0_REAL_RESEARCH_DOGFOOD.md`).
- MVP-1T.1 — Controlled search MVP closeout accepted (`notes/MVP1T1_CONTROLLED_SEARCH_MVP_CLOSEOUT.md`).
- MVP-1U.0 — Plug-and-play SearXNG bootstrap accepted (`notes/MVP1U0_SEARXNG_PLUG_AND_PLAY_BOOTSTRAP.md`).
- MVP-1U.1 — Interactive Claude Code search flow accepted (`notes/MVP1U1_INTERACTIVE_CLAUDE_CODE_SEARCH_FLOW.md`).

## Current state

MVP-1U.0 is merged and accepted as the operator/bootstrap path for Claude Code research:

```bash
krn-search searxng status
krn-search searxng up
krn-search searxng down
```

MVP-1U.1 confirmed the remaining interactive proof:

- backend was stopped first
- Claude ran `krn-search searxng status`
- status failed with connection refused
- Claude ran `krn-search searxng up`
- Claude then ran `krn-search search-query "<query>" --research`
- the run used `provider=searxng`
- evidence packs and compact summary were produced
- answer path remained evidence-based

Health readiness can still be confirmed directly via:

`SEARXNG_URL=http://localhost:9999 .venv/bin/python -m search_tool health --research --wait 30`

MVP-1T.0 real research dogfood was completed and accepted:

- `t0 requests docs`
- `t0 package ambiguity`
- `t0 searxng runbook`

Decision: `notes/MVP1T0_REAL_RESEARCH_DOGFOOD.md` → `ACCEPT_CONTROLLED_SEARCH_DOGFOOD`.

MVP-1T.1 controlled search MVP closeout remains accepted:

- Final decision: `ACCEPT_CONTROLLED_SEARCH_MVP`
- The repository is good enough as a Claude Code `/search`-style evidence-pack tool.
- Recommendation: `STOP_AND_USE` before further feature expansion.

## Recommended next option

- `STOP_AND_USE`: use the updated `/krn-search-research` on real Claude Code tasks.
- Do not reopen implementation work unless packaging/version skew around the PATH-level `krn-search` launcher becomes a real operator pain.
- If real usage confirms source-quality pain, consider a future filtering slice after this bootstrap work.

## Notes

Historical details live in `notes/EXPERIMENT_LOG.md` and dedicated `notes/MVP*.md` reports.
