# MVP-1L.5 — Surface llms parser warnings in JSON

**Date:** 2026-05-18
**Baseline:** 4766901fd8e3038a56dd2d73ed9eb5245986684e

## Goal

Expose llms.txt parser warnings in JSON output in a small, backward-compatible way.

## Chosen strategy

**Option A: Append to `limitations` tuple with `llms parser warning:` prefix.**

Rationale:
- `DiscoveryResult.limitations` is already exposed in JSON via `_discovery_result_to_json_dict()` (line 578 of cli.py) and `_print_search_result_json()` (line 775 of cli.py).
- Zero schema risk: no new fields, no field renames, no restructuring.
- Mixed semantics (warnings alongside limitations) documented as acceptable for MVP; dedicated `warnings` field deferred.
- Deduped via `dict.fromkeys()`, capped at 20 to prevent warning spam.

## Implementation

### search_tool/discovery_llms.py

After parsing (line 418), warnings are captured:

```python
entries, parse_warnings = parse_llms_txt(fetch_result.body_bytes, llms_url)

# Surface parser warnings in limitations (deduped, capped)
_llms_warnings = tuple(dict.fromkeys(
    f"llms parser warning: {w}" for w in parse_warnings
))[:20]
```

Success path: appended via `dc_replace()` to extend `DiscoveryResult.limitations`.
No-entries path: directly included in the `limitations` tuple passed to `DiscoveryResult()`.

### Parser warnings produced

| Trigger | Warning format |
|---------|---------------|
| Empty-title link `[](...)` | `line N: skipped empty-title link` |
| Relative URL resolves to blocked scheme | `line N: relative URL resolved to unsupported scheme: '...'` |
| Invalid candidate URL in link | `line N: skipped invalid URL in link: '...'` |
| Invalid raw URL | `line N: skipped invalid raw URL: '...'` |
| Invalid named URL | `line N: skipped invalid named URL: '...'` |

## JSON behavior

### Discovery JSON (discover-query --provider llms --json)

```json
{
  "limitations": [
    "Query redaction is best-effort and not a security boundary.",
    "llms parser warning: line 5: relative URL resolved to unsupported scheme: 'file:///etc/passwd'"
  ]
}
```

### Search JSON (search-query --provider llms --json)

```json
{
  "limitations": [
    "Query redaction is best-effort and not a security boundary.",
    "llms parser warning: line 5: relative URL resolved to unsupported scheme: 'file:///etc/passwd'"
  ]
}
```

The dedup in `_print_search_result_json` via `dict.fromkeys()` prevents the redaction limitation from appearing twice (already fixed in L.4).

### Error JSON

`_print_search_error_json` uses empty `limitations: []` for preflight errors (before parsing). Parse warnings only matter when parsing actually happens.

### Static and SearXNG providers

Unaffected. They don't produce parser warnings. Confirmed by test `test_static_provider_unaffected`.

## Tests added (+7)

| # | Test | What it verifies |
|---|------|-----------------|
| 1 | `test_empty_title_warning_in_limitations` | Empty-title links are silently skipped (no warning) |
| 2 | `test_blocked_scheme_warning_in_limitations` | file:// URLs produce a "unsupported scheme" warning in limitations |
| 3 | `test_warnings_preserve_valid_candidates` | Warnings don't suppress valid candidates |
| 4 | `test_warnings_dont_turn_success_into_error` | Warnings in limitations don't create discovery errors |
| 5 | `test_no_entries_includes_warnings` | no_entries error path still has valid limitations tuple |
| 6 | `test_no_duplicate_warning_spam` | 50 identical bad lines produce <= 20 warnings (capped) |
| 7 | `test_static_provider_unaffected` | Static provider has no llms parser warnings |

## Backward compatibility

- **Schema:** No new fields added. `limitations` tuple already existed.
- **Existing consumers:** Any JSON consumer that reads `limitations` will see new strings prefixed with `llms parser warning:`. This is a additive change to the tuple contents.
- **Error JSON:** Unchanged (uses empty limitations for preflight errors).
- **Discovery JSON:** `limitations` now may contain `llms parser warning:` strings — only for llms provider.
- **Search JSON:** Same as discovery.
- **Non-llms providers:** No change. Static and SearXNG limitations unchanged.

## Known limitations

- Warnings mixed with limitations in a single list; dedicated `warnings` field deferred.
- No per-candidate warning association (warnings are global to the discovery result).
- Capped at 20 warnings — reasonable for MVP, may need per-source granularity later.
- Warnings only on discovery success path. Preflight errors (no URL, empty query) have no parse warnings.
- `discover-query` and `search-query` both surface warnings (consistent).

## Verification

- Parser tests: 51/51
- Provider tests: 50/50 (+7 new)
- Alias tests: 16/16
- Init tests: 26/26
- Full suite: 800/800 (+7)
- Eval-corpus: 11/11
- Compile: OK
- Whitespace: OK
- No generated artifacts tracked in git

## Next recommended task

1. **MVP-1L.6**: Dedicated `warnings` field on `DiscoveryResult` (cleaner semantics, separate from limitations).
2. **Auto-discovery**: Try common llms.txt paths before falling back to explicit `--url`.
3. **llms-full support**: Some sites only publish structured content via llms-full.
