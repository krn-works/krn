# MVP-1H.6 Research Mode Dogfooding Evaluation

## Baseline

Full HEAD SHA: `376986d43a92c1aa27ec491b3eea9fdf0518b96c`

## Goal

Dogfood the complete no-WebSearch research workflow with `--research` preset and formally accept or identify final polish.

## Scenarios

### A. Static research mode

```bash
python -m search_tool search-query "python http.server security docs" \
  --research \
  --provider static \
  --candidate-url "https://docs.python.org/3/library/http.server.html" \
  --work-dir "$(mktemp -d)"
```

**Results:**
- Exit code: 0
- JSON valid, structured, parseable
- `research_mode.enabled`: true
- `research_mode.preset_version`: "0.1"
- `expanded_defaults`: all 6 preset values match design document
- `effective_values.provider`: "static" (explicit override from "auto" default)
- `profile.name`: "official-docs" (preset default applied)
- `compact_summary_path`: exists, 2447 bytes, correct naming pattern
- Evidence: 1 pack, quality 3/3, 24433 chars extracted text
- `recovery.websearch_allowed`: false
- Evidence mentions "security" and "http.server" — answerable

**Verdict:** PASS

### B. Override research mode

```bash
python -m search_tool search-query "python http.server security docs" \
  --research \
  --provider static \
  --candidate-url "https://docs.python.org/3/library/http.server.html" \
  --profile security-research \
  --no-compact \
  --no-follow-redirects \
  --work-dir "$(mktemp -d)"
```

**Results:**
- Exit code: 0
- `compact_summary_path`: null (correctly disabled)
- `profile.name`: "security-research" (override applied)
- `research_mode.effective_values.compact`: false
- `research_mode.effective_values.follow_redirects`: false
- `research_mode.effective_values.profile`: "security-research"
- `research_mode.expanded_defaults`: unchanged (show what preset would have set)
- `expanded_defaults` vs `effective_values` distinction clear and useful

**Verdict:** PASS

### C. Error honesty

```bash
python -m search_tool search-query "test" \
  --research --profile nonexistent \
  --provider static \
  --candidate-url "https://docs.python.org/3/library/http.server.html"
```

**Results:**
- Exit code: 1
- Valid JSON on stdout (not stderr)
- `status`: "error"
- `research_mode.enabled`: true (present even in error)
- `research_mode.preset_version`: "0.1"
- `failure.reason`: "unknown profile: nonexistent (valid: official-docs, github-repo, security-research)"
- `recovery.websearch_allowed`: false

**Verdict:** PASS

### D. Skill/command docs review

**`.claude/commands/krn-search-research.md`:**
- Uses `python -m search_tool search-query "$ARGUMENTS" --research` as step 1: YES
- Tells Claude to read JSON output first, then compact_summary_path: YES
- Does not claim krn-search answers questions: YES — "produces structured JSON evidence artifacts, not answers"
- No WebSearch fallback suggestion: YES — "Do not suggest WebSearch fallback"
- Note explains preset expansion: YES

**`.claude/skills/krn-search-research/SKILL.md`:**
- Research mode section present with `--research` command: YES
- Documented override behavior (`--no-compact`, `--no-follow-redirects`): YES
- Artifact inspection order updated (JSON → compact → manifest → evidence): YES
- Purpose section: "NOT a search engine — controlled ingestion primitive": YES
- Failure honesty rules: YES
- No WebSearch fallback anywhere: YES

**Verdict:** PASS

### E. Hook recovery test

Hook denies WebSearch with recovery message.
- Recovery mentions `/krn-search-research`: YES
- Recovery does NOT mention WebSearch approval: YES
- Recovery does NOT mention `--research` directly (points to slash command which uses it): ACCEPTABLE

**Verdict:** PASS

## Friction found

1. **`--provider` no longer required** — The task design says `--research` defaults provider to `auto`, but this means `search-query` without `--research` now has an optional `--provider`. The error message "use --research for auto defaults" is clear, but existing scripts that relied on `--provider` being required will now get a later error if they omit it. This is a minor behavioral change for non-research mode.

2. **`effective_values.compact` type** — When `--research` is active and compact is true, `effective_values.compact` is `True` (bool). When `--no-compact` is passed, it's `False`. But when research mode is NOT active and `--compact` is not passed, `args.compact` is `None` (because `BooleanOptionalAction` default is `None`), and `effective_values` doesn't exist at all (research_mode is null). This is correct behavior, but the `None` → `False` conversion is handled by `getattr(args, "compact", False) or False` which is slightly opaque.

3. **No friction on research workflow** — The workflow is comfortable. One flag replaces 6 flags. JSON output, compact summary, and profile biasing are all automatic. Claude can run a single command and get everything it needs.

## Missing docs

1. README search-query section mentions `--research` but does not document `--no-compact` or `--no-follow-redirects` as standalone options.

2. PROJECT_STATE.md CLI listing does not show `--research` in the search-query command line.

## Non-goals verified (no violations)

- No synthesis: CONFIRMED
- No LLM ranking: CONFIRMED
- No WebSearch/WebFetch used: CONFIRMED
- No MCP: CONFIRMED
- No new dependencies: CONFIRMED
- No pyproject.toml changes: CONFIRMED
- No evidence pack schema changes: CONFIRMED
- No hidden filtering: CONFIRMED
- One search-query pipeline: CONFIRMED

## Acceptance verdict

**ACCEPT_MVP1H5**

Research mode preset is implemented correctly, dogfooded successfully, and ready for use. The workflow eliminates the 6-flag cocktail with a single `--research` flag. Override behavior is correct and well-documented in JSON output. Error JSON includes research_mode. Skill/command docs are updated. Hook recovery is consistent.

Minor polish items (README `--no-compact`/`--no-follow-redirects` docs, PROJECT_STATE.md CLI listing) do not block acceptance.

## Recommended next task

Update CLAUDE.md phase to MVP-1H.6 complete. Consider whether to continue feature work or stabilize and port to krn-ai-os.
