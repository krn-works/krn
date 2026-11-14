# MVP-1H.4 Research Mode Preset Design

## Baseline

Full HEAD SHA: `ebba682e577bf5f7e77b084eaef967241235b080`

## Problem

Claude Code now has enough primitives (search-query, --json, --compact, --profile, --work-dir, --provider auto, source_quality, compact_summary_path, error JSON, no-WebSearch guard, /krn-search-research command), but must remember too many flags for a typical research query:

```bash
krn-search search-query "<query>" \
  --provider auto \
  --json \
  --compact \
  --work-dir .local/krn-search-runs \
  --profile official-docs \
  --follow-redirects
```

This flag cocktail is fragile. Claude must remember all of them every time, or the output degrades (no JSON, no compact index, no work-dir isolation, no source preference biasing). One mistake means the agent gets unstructured output it cannot parse, or artifacts scattered in the default evidence directory.

## Existing primitives

| Primitive | Purpose | Current default |
|-----------|---------|-----------------|
| `--json` | Structured JSON output to stdout | `false` |
| `--work-dir <dir>` | Isolated artifact storage | `None` (default evidence dir) |
| `--compact` | Write compact evidence index | `false` (requires `--json`) |
| `--profile <name>` | Deterministic source preference biasing | `None` (no profile) |
| `--provider auto` | Auto-resolve discovery provider | N/A (required flag) |
| `source_quality` | Deterministic quality metadata per source | Always in JSON output |
| `compact_summary_path` | Path to compact index file | `null` unless `--compact` |
| error JSON | Structured error output in --json mode | Automatic |
| no-WebSearch guard | Hook blocks WebSearch/WebFetch | Always active |
| `/krn-search-research` | Slash command wrapper | Delegates to skill |
| krn-search-research skill | Teaches Claude the research workflow | On-demand |

## Goal

One comfortable, deterministic research entrypoint for Claude Code that eliminates the flag cocktail while preserving all existing behavior for non-research use.

## Non-goals

- No synthesis, no answer generation, no AI summarization
- No MCP server or agent framework
- No browser rendering or PDF extraction
- No semantic reranking or LLM scoring
- No changes to evidence pack schema, fetch-list manifest schema, or search-run manifest schema (unless strictly additive)
- No hidden filtering of evidence
- No changes to URL policy or security posture

## Candidate APIs

### Option A — `research-query` subcommand

```bash
krn-search research-query "<query>"
```

**Pros:**
- Clear semantic separation: `search-query` for raw ingestion, `research-query` for Claude-friendly research
- No ambiguity about which defaults apply
- Discoverable in CLI help

**Cons:**
- CLI duplication: `research-query` must mirror every `search-query` option (provider, candidate-url, searxng-url, max-candidates, refresh, etc.)
- Maintenance burden: every new `search-query` flag must also be added to `research-query`
- Code duplication: `_run_research_query()` would call the same internals with different defaults
- Test duplication: every test for `search-query` must be mirrored for `research-query`

**CLI duplication risk:** HIGH. The two subcommands share 90%+ of their code path. Divergence over time is likely.

**Test impact:** ~20-30 new tests minimum (mirror of existing search-query tests plus research-specific defaults). Total test count would exceed 640.

### Option B — `--research` preset flag

```bash
krn-search search-query "<query>" --research
```

**Pros:**
- Smallest runtime surface: one new flag, one code path
- No CLI duplication — `search-query` remains the single entrypoint
- All existing flags still work alongside `--research` (explicit overrides)
- Backward compatible — no `--research` = unchanged behavior
- Discoverable in `search-query --help`
- Compatible with `/krn-search-research` skill wrapper

**Cons:**
- Slightly magical — "what does `--research` actually do?" requires reading help text or docs
- Interaction with explicit flags needs clear precedence rules

**Interaction with explicit flags:**
- `--research` sets defaults; explicit flags override where safe
- `--json` cannot be disabled (research mode requires JSON by definition)
- All other defaults are overridable

**Is it too magical?** No. The help text will document exactly what `--research` expands to. The flag is a preset, not hidden behavior. Compare to `git commit --amend` — a single flag that changes multiple behaviors, all documented.

### Option C — No new CLI, documented preset only

```bash
krn-search search-query "<query>" \
  --provider auto \
  --profile official-docs \
  --json \
  --compact \
  --work-dir .local/krn-search-runs
```

**Pros:**
- Zero runtime changes
- Full transparency — every flag is visible

**Cons:**
- Claude must remember all flags every time
- Skill/command docs become the single source of truth for the flag cocktail
- Easy to forget one flag (especially `--compact` or `--work-dir`)
- No mechanical enforcement — a typo or omission degrades output silently

**Risk that Claude keeps forgetting flags:** HIGH. This is exactly the problem we are solving. Documenting the cocktail does not prevent Claude from dropping flags.

### Option D — Slash command only, no CLI change

```bash
/krn-search-research "<query>"
```

**Pros:**
- Zero CLI changes
- Skill already exists and teaches the workflow
- Claude Code automatically expands the command

**Cons:**
- Only works inside Claude Code — not scriptable, not composable
- Skill must be loaded into context (on-demand, not guaranteed)
- Coupling to Claude Code — no use from shell scripts, CI, or other tools
- Skill instructions could still omit flags
- The problem is not solved at the CLI level

**Coupling to Claude Code:** HIGH. A shell user or CI pipeline cannot use `/krn-search-research`.

**Portability:** ZERO. Slash commands are Claude Code-specific.

## Recommended option

**Option B — `search-query --research`**

Rationale:
1. Smallest runtime surface — one flag, no subcommand duplication
2. Keeps one `search-query` code path — no maintenance burden
3. Backward compatible — no `--research` = no change
4. Discoverable in CLI help
5. Scriptable and composable — works from shell, CI, and Claude Code
6. Compatible with `/krn-search-research` skill wrapper — the skill can simply add `--research`

## Proposed behavior if Option B

`--research` expands to deterministic defaults:

| Setting | Default when `--research` | Overridable |
|---------|---------------------------|-------------|
| `provider` | `auto` | Yes — explicit `--provider` wins |
| `json` | `true` | No — research mode requires JSON |
| `compact` | `true` | Yes — explicit `--no-compact` could disable |
| `work-dir` | `.local/krn-search-runs` | Yes — explicit `--work-dir` wins |
| `profile` | `official-docs` | Yes — explicit `--profile` wins |
| `follow-redirects` | `true` | Yes — explicit `--no-follow-redirects` could disable |

**Explicit flags override defaults** (except `--json` which is mandatory in research mode).

### Example

```bash
krn-search search-query "claude code hooks" --research
```

Equivalent to:

```bash
krn-search search-query "claude code hooks" \
  --provider auto \
  --json \
  --compact \
  --profile official-docs \
  --work-dir .local/krn-search-runs \
  --follow-redirects
```

### Override example

```bash
krn-search search-query "OWASP top 10" --research --profile security-research
```

Uses research defaults except `profile` is `security-research` instead of `official-docs`.

## Open question: follow redirects

**Decision: `--research` sets `follow-redirects` to `true`.**

Justification:
1. Default `false` preserves strict MVP policy for `search-query` without `--research` — unchanged.
2. Research mode is specifically for Claude Code research workflows. Redirects are common for documentation URLs (HTTP→HTTPS, trailing-slash normalization, CDN redirects). Following them improves research usability significantly.
3. Redirects are already protected by URL policy — every hop is checked. SSRF risk is mitigated.
4. The SSRF surface increase from redirect following is accepted and documented in MVP-1B. The per-hop policy check is the security boundary, not the default.
5. Setting `follow-redirects` to `true` in research mode is consistent with the "comfortable, deterministic" goal — Claude should not have to remember `--follow-redirects` for every research query.

If a user explicitly passes `--no-follow-redirects` alongside `--research`, the explicit flag wins (assuming argparse supports negation via `store_false` action or similar).

## JSON contract

When `--research` is active, the JSON output includes a top-level `research_mode` object:

```json
{
  "schema_version": "0.1",
  "status": "ok",
  "research_mode": {
    "enabled": true,
    "preset_version": "0.1",
    "expanded_defaults": {
      "provider": "auto",
      "json": true,
      "compact": true,
      "profile": "official-docs",
      "work_dir": ".local/krn-search-runs",
      "follow_redirects": true
    },
    "effective_values": {
      "provider": "searxng",
      "json": true,
      "compact": true,
      "profile": "official-docs",
      "work_dir": ".local/krn-search-runs",
      "follow_redirects": true
    }
  },
  "query": { ... },
  "discovery": { ... },
  "evidence_results": [ ... ],
  "failures": [ ... ],
  "limitations": [ ... ],
  "recovery": { ... },
  "compact_summary_path": "...",
  "profile": { ... }
}
```

**`expanded_defaults`**: the preset values `--research` sets.
**`effective_values`**: the actual values after applying explicit overrides (e.g., if user passed `--profile security-research`, `effective_values.profile` is `"security-research"`).

This distinction lets the consumer know what was preset vs. what was explicitly chosen.

**When `--research` is not active:** `research_mode` is `null`.

Choosing `null` over absent: `null` is explicit and avoids the "was this key forgotten or intentionally omitted?" ambiguity. Consumers can check `json.get("research_mode") is None` or `json.get("research_mode", {}).get("enabled")`.

## Slash command integration

Update `/krn-search-research` slash command (`.claude/commands/krn-search-research.md`) to use `--research`:

```markdown
Use the krn-search-research skill to answer this question: $ARGUMENTS

Steps:
1. Run `python -m search_tool search-query "$ARGUMENTS" --research` with appropriate provider and candidate URLs if needed.
2. Read the search-run manifest to understand the run scope.
3. Read the compact evidence index (`compact_summary_path` from JSON output) for source overview.
4. Read the relevant evidence packs for source content.
5. Produce a concise evidence-based answer with source citations and limitations.
6. If evidence is insufficient, say so explicitly. Do not suggest WebSearch fallback.
```

The skill (`SKILL.md`) should also document `--research` as the recommended invocation pattern.

## Safety constraints

- Research mode must not use WebSearch/WebFetch — enforced by hook, not by `--research`.
- Must preserve `recovery.websearch_allowed=false` in all JSON output (including errors).
- Must not hide failures — `--research` does not filter evidence or suppress error output.
- Must not synthesize answers — research mode is a preset for `search-query`, not an answer generator.
- Must not filter evidence — `--research` does not alter `prefer_not_require` profile policy.
- Must not write outside configured work-dir — `--work-dir .local/krn-search-runs` is a default, artifacts stay under it.
- Must not commit generated artifacts — existing `.gitignore` and postcommit hook enforce this.
- Must not weaken URL policy — redirect following is per-hop policy-checked, same as `--follow-redirects` alone.

## Test plan for implementation

| # | Test | Scope |
|---|------|-------|
| 1 | `--research` enables JSON output | Unit |
| 2 | `--research` creates `compact_summary_path` | Integration |
| 3 | `--research` uses `.local/krn-search-runs` by default | Unit |
| 4 | Explicit `--work-dir` overrides default | Unit |
| 5 | Explicit `--profile` overrides default | Unit |
| 6 | Explicit `--provider` overrides default | Unit |
| 7 | Invalid profile still emits JSON error in research mode | Integration |
| 8 | No generated files tracked (`.local/` in gitignore) | Git |
| 9 | No-`--research` path unchanged | Regression |
| 10 | `/krn-search-research` docs point to research mode | Docs |
| 11 | `research_mode` is `null` when `--research` not set | Unit |
| 12 | `research_mode.enabled` is `true` when `--research` set | Unit |
| 13 | `expanded_defaults` matches documented preset values | Unit |
| 14 | `effective_values` reflect explicit overrides | Unit |
| 15 | `--research --follow-redirects` does not conflict (both true) | Unit |
| 16 | Error JSON in research mode includes `research_mode` | Integration |

Estimated: ~16 new tests. Total test count would reach ~632.

## Decision

**Option B — `search-query --research`** is the recommended design.

It is the smallest surface change that solves the flag cocktail problem. It preserves backward compatibility, avoids CLI duplication, and is compatible with the existing skill/command infrastructure.

## Next task

MVP-1H.5 — implement `--research` preset flag on `search-query` per this design.
