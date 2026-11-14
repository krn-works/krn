# MVP-1U.1 — Interactive Claude Code search flow proof

## Goal

Close the last remaining proof after MVP-1U.0 by validating the interactive `/krn-search-research` flow in Claude Code with SearXNG initially down.

## Decision

`ACCEPT_INTERACTIVE_CLAUDE_CODE_SEARCH_FLOW`

## Scope

Docs-only follow-up after MVP-1U.0. No code changes.

## Evidence

The proof was executed against the real interactive Claude Code slash flow after stopping the backend first.

### Backend was stopped first

Repo-local operator path used for the hard stop:

```bash
SEARXNG_URL=http://localhost:9999 .venv/bin/python -m search_tool searxng down
```

Observed:
- `Removed krn-search-searxng-smoke`
- follow-up `docker ps -a --filter name=krn-search-searxng-smoke` showed no running bootstrap container

### Interactive Claude Code slash sequence

Interactive command:

```text
/krn-search-research Znajdź mi najnowsze metodyki tworzenia agentów AI
```

Observed tool flow inside Claude Code:

1. Claude ran:

   ```bash
   krn-search searxng status
   ```

2. `status` failed with:

   ```text
   Exit code 1
   unreachable: [Errno 111] Connection refused
   ```

3. Claude then ran:

   ```bash
   krn-search searxng up
   ```

4. SearXNG became ready at:

   ```text
   http://localhost:9999
   ```

5. Claude then ran:

   ```bash
   krn-search search-query "latest methodologies for creating AI agents" --research
   ```

6. Search result used:

   ```text
   provider=searxng
   ```

7. Search result produced:
- `candidates_total=10`
- `selected_for_fetch=10`
- evidence packs under `.local/krn-search-runs/runs/20260525T170622Z-e24440b682ae/evidence/`
- `compact_summary_path=.local/krn-search-runs/runs/20260525T170622Z-e24440b682ae/evidence/search-summary-20260525T170625Z-34401fac2c24.md`

8. Claude then read:
- the compact summary
- the Anthropic evidence pack

9. The answer path stayed evidence-based. No WebSearch/WebFetch fallback, no static guessed URLs, and no memory-only fallback were observed.

## Accepted contract

Interactive Claude Code search flow is accepted with this contract:

- local SearXNG bootstrap/status/up is part of the accepted path
- no memory-only fallback is accepted
- evidence-pack behavior remains the contract
- `provider=searxng` remains the intended research-mode discovery path

## Important caveat

There was temporary operator-version skew on this machine:

- the PATH-level `krn-search` launcher was briefly older than the repo-local code
- hard stop/proof for backend teardown used repo-local commands:

  ```bash
  .venv/bin/python -m search_tool searxng down
  .venv/bin/python -m search_tool searxng up
  .venv/bin/python -m search_tool searxng status
  ```

This is recorded as an operator packaging/version-skew follow-up candidate, not a blocker for acceptance. The interactive slash behavior itself still showed the correct bootstrap-first contract.

## Non-goals preserved

- no code changes
- no provider semantic changes
- no public/general search engine readiness claim
- no prompt-hardening follow-up
- no runtime/schema changes

## Recommended next step

Return to normal use. Only reopen work if packaging/version skew causes real operator pain in practice.
