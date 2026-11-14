# MVP-1T.0 — Real research dogfood after SearXNG readiness hardening

**Decision:** `ACCEPT_CONTROLLED_SEARCH_DOGFOOD`
**Date:** 2026-05-25
**Scope:** dogfood/report slice, no code changes unless blocker is explicit

## Environment baseline

- `main` is clean after PR #34 and MVP-1S.6 merged/accepted.
- SearXNG required for `--research` discovery.
- Static provider remains explicit known-URL/manual/test override only.
- Baseline after S.6: `1069/1069` tests, `11/11` eval corpus.

## Required prep

### 1) SearXNG readiness checks

- `SEARXNG_URL=http://localhost:9999 .venv/bin/python -m search_tool health --research --wait 30`
  - Exit code: `0`
  - Outcome: `krn-search health: ok`
  - `searxng_reachable`: reachable

- `SEARXNG_URL=http://localhost:9999 .venv/bin/python -m search_tool health --research --json --wait 30`
  - Exit code: `0`
  - JSON `overall`: `ok`
  - Checks: package_import, static_provider, searxng_reachable, evidence_writable, objects_writable

### 2) Session run directory

- `.local/krn-search-runs-t0-dogfood`

## Prepared run commands and outcomes (A/B/C)

### A. Stable docs query

Command:

`SEARXNG_URL=http://localhost:9999 .venv/bin/python -m search_tool search-query "Python requests documentation quickstart timeout session" --research --work-dir .local/krn-search-runs-t0-dogfood --session "t0 requests docs"`

- Exit code: `0`
- Session: `session-47458029ceac`
- Run: `.local/krn-search-runs-t0-dogfood/sessions/session-47458029ceac/runs/20260525T111958Z-7c9b25ca9d4e`
- Provider: `searxng`
- Candidates total: `10`
- Selected for fetch: `10`
- Evidence packs produced: `9`
- Failures: `1` (`403` from `python-requests.org/python-requests-session`)
- Useful for agent: `yes` (official docs + repo/issues + troubleshooting sources present, though mixed with low-value sources)
- Quality observations:
  - Official docs signal was absent (`is_official=false` on all evidence rows)
  - Useful official-ish sources: Requests docs and StackOverflow/GitHub but mixed with guides/media content
  - Snippet utility: good for quick triage, e.g., `Quickstart`, `Advanced Usage`, timeout discussions
- Summary artifact: `.local/krn-search-runs-t0-dogfood/sessions/session-47458029ceac/session-summary.md`

### B. Package/entity ambiguity

Command:

`SEARXNG_URL=http://localhost:9999 .venv/bin/python -m search_tool search-query "python request requests HTTP client library documentation" --research --work-dir .local/krn-search-runs-t0-dogfood --session "t0 package ambiguity"`

- Exit code: `0`
- Session: `session-bf6388eb7f58`
- Run: `.local/krn-search-runs-t0-dogfood/sessions/session-bf6388eb7f58/runs/20260525T112007Z-d8b7152f3ddd`
- Provider: `searxng`
- Candidates total: `10`
- Selected for fetch: `10`
- Evidence packs produced: `9`
- Failures: `1` (`403` from Medium)
- Useful for agent: `yes` (good mix: `requests.readthedocs.io`, `docs.python.org`, GitHub, plus noisy pages)
- Quality observations:
  - `docs.python.org` marked `official_docs` and `authority_score:3`
  - Presence of medium/JS-heavy pages with poor extraction; ambiguity remained partly unresolved and required relevance filtering by agent
- Summary artifact: `.local/krn-search-runs-t0-dogfood/sessions/session-bf6388eb7f58/session-summary.md`

### C. Tooling/operator loop query

Command:

`SEARXNG_URL=http://localhost:9999 .venv/bin/python -m search_tool search-query "SearXNG docker settings json format local development" --research --work-dir .local/krn-search-runs-t0-dogfood --session "t0 searxng runbook"`

- Exit code: `0`
- Session: `session-8f9eb1abc80a`
- Run: `.local/krn-search-runs-t0-dogfood/sessions/session-8f9eb1abc80a/runs/20260525T112010Z-e63f42351c6a`
- Provider: `searxng`
- Candidates total: `10`
- Selected for fetch: `10`
- Evidence packs produced: `8`
- Failures: `2` (both `403` from Medium URLs)
- Useful for agent: `yes` (directly includes SearXNG docs and JSON/docker setup pages; useful operator feedback loop)
- Quality observations:
  - 3 `official_docs` sources (`docs.searxng.org` and docs subdomains) with high authority
  - Mixed with low-value tutorial/blog pages and GitHub discussions
- Summary artifact: `.local/krn-search-runs-t0-dogfood/sessions/session-8f9eb1abc80a/session-summary.md`

## Session summary command used

`krn-search session-summary --help` printed:

`krn-search session-summary [-h] [--work-dir WORK_DIR] [--session SESSION] [--session-id SESSION_ID] [--output OUTPUT]`

I used:

- `.venv/bin/python -m search_tool session-summary --work-dir .local/krn-search-runs-t0-dogfood --session "t0 requests docs"`
- `.venv/bin/python -m search_tool session-summary --work-dir .local/krn-search-runs-t0-dogfood --session "t0 package ambiguity"`
- `.venv/bin/python -m search_tool session-summary --work-dir .local/krn-search-runs-t0-dogfood --session "t0 searxng runbook"`

Each command exited `0` and wrote a `session-summary.md` in each session folder.

## Evaluation

1. Did `health --research --wait` make startup smoother?
   - Yes. Startup was stable when using the known-good local mount configuration; readiness checks became green in under 30s and allowed real dogfood.

2. Did `provider=auto` use SearXNG as expected?
   - Yes. All runs resolved to `provider: searxng` and executed discovery through SearXNG.

3. Did the tool produce useful evidence packs without manual URL candidates?
   - Mostly yes. Evidence was produced in all sessions without `--candidate-url` and was mostly actionable.

4. Did session summaries help compare runs/sources?
   - Yes. Summary files gave compact session metadata, run-history counters, unique source view, relevance table, and snippets for quick triage.

5. Did relevance/snippets make results easier to inspect?
   - Yes. Relevance tables plus snippets made low-value/JS-heavy entries easier to filter out.

6. False positives/poor sources?
   - Present but manageable:
     - Medium/blog pages and YouTube often included as relevant-looking but noisy.
     - Some 403 failures prevented a couple high-value pages.

7. Operator output confusion?
   - No major CLI confusion in this successful path. Key friction point remains mixed-quality sources and `docs_site` classification not always marking `is_official`.

8. Good enough for Claude Code `/search` MVP?
   - **Yes, with caveat.** Useful enough for controlled operator loop as long as agent treats snippets mechanically and respects source quality.

## Failure/confusion points observed

- External content blocks (`HTTP 403`) appeared from some candidate URLs (mostly Medium/browse-heavy pages).
- Relevance ranking is mechanical and can over-rank broad guides when query terms are ambiguous.
- No native/public fallback was used in any session.
- No AI-generated URL candidates were used in commands.
- No browser automation used.

## Final decision

**`ACCEPT_CONTROLLED_SEARCH_DOGFOOD`**

Criteria satisfied:
- SearXNG readiness works with `--research --wait`.
- `provider=auto` path uses SearXNG.
- Evidence packs generated and usable in `/search`-style controlled loops.
- Session summary aids comparison and inspection.

## Follow-up candidates

- Add optional stricter source quality gating for `--research` defaults (e.g., prefer official docs over unknown/high-noise domains).
- Add post-hoc `--max-failures` handling visibility in session outputs when many candidates are blocked.
- Consider a tiny optional docs-domain boost hint in source scoring for ambiguous queries.
