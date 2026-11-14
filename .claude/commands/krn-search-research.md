Use the krn-search-research skill to answer this question: $ARGUMENTS

Bootstrap and research commands for this flow are:
`krn-search searxng status`
`krn-search searxng up`
`krn-search search-query "$ARGUMENTS" --research`

Steps:
1. Do not call WebSearch or WebFetch.
2. Do not start with `--provider static`, `--provider searxng`, `fetch-url`, or hand-written candidate URLs.
3. Ensure `krn-search` CLI is available (installed or via `KRN_SEARCH_BIN`), then run `krn-search searxng status`.
4. If status fails, run `krn-search searxng up`.
5. If bootstrap fails, stop the research flow immediately. Output limitation-only with the exact failing command and the operator log pointer `docker logs krn-search-searxng-smoke`. Do not continue with memory, repo docs, or alternative search shapes.
6. Only after bootstrap/status succeeds, run `krn-search search-query "$ARGUMENTS" --research`.
7. If the JSON result is `provider_resolution` because SearXNG is unavailable and no candidate URLs were provided, stop the research flow immediately. Report the limitation honestly unless the user already gave exact URLs or exact URLs are already present in inspected local/source context or prior krn-search output.
8. Do not switch to `--provider static` on your own. Do not search separately for candidate URLs. Do not invent or template URLs, paper IDs, slugs, or docs paths.
9. Use `KRN_SEARCH_ALLOW_EXACT_URLS=1 krn-search search-query ... --provider static --candidate-url <url>` only when exact allowed URLs are already known from the allowed sources above.
10. Read the JSON output, especially `compact_summary_path` for source overview.
11. Read the search-run manifest to understand the run scope.
12. Read the relevant evidence packs for source content.
13. Produce a concise evidence-based answer with source citations and limitations.
14. If evidence is insufficient, say so explicitly and stop. Do not answer from general knowledge, model memory, or repo-local docs as a substitute for external evidence. Do not suggest WebSearch fallback.

Note: `--research` is a deterministic preset that sets --json, --compact, --profile official-docs, --work-dir .local/krn-search-runs, and --follow-redirects. It produces structured JSON evidence artifacts, not answers.
If no evidence packs are produced, the correct output is a limitation report only.

SearXNG notes:
- SearXNG is required for research-mode discovery (`--research` / `provider=auto`). Static provider remains valid when URLs are explicit via `--provider static --candidate-url ...`.
- `krn-search searxng up` is the deterministic local bootstrap path for Claude Code research flow.
- In Claude Code research flow, `provider_resolution` without exact allowed URLs is a fail-closed outcome, not a cue to improvise.
- SearXNG requires `search.formats` to include `json` in `settings.yml`.
- If you cannot complete the task through that `--research` first step, the correct behavior is to stop and report the limitation, not to try a different search shape.

Launcher configuration:

```
Primary:    krn-search installed on PATH (pipx/uv tool/pip install)
Editable:   export KRN_SEARCH_BIN=".venv/bin/python -m search_tool"
```

For `KRN_SEARCH_BIN` containing spaces (editable fallback), use in bash/Claude Code:
```bash
KRN_SEARCH_BIN=".venv/bin/python -m search_tool"
# Command examples use unquoted $KRN_SEARCH_BIN — works in bash, not zsh.
# Claude Code runs bash, so this is safe in that context.
```
