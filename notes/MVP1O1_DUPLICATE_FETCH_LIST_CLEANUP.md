# MVP-1O.1 — duplicate `_run_fetch_list` cleanup

**Date:** 2026-05-19
**Baseline:** fc448a003a83acf21baf4aeb8e23104ae6a5ae4e
**Commit:** (local only, not pushed)

## Diagnosis

`search_tool/cli.py` contained **two** `_run_fetch_list` definitions:

1. **Lines 276-304** (dead code) — First definition. Body is correct but ends with `return 0` on line 304, making all following code unreachable.
2. **Lines 306-397** (orphaned code) — After the first `return 0`, there was orphaned text that was originally the body of `write_fetch_list_manifest()` — accidentally pasted into the first `_run_fetch_list` function. It started with a docstring and contained the full manifest-writing logic.
3. **Lines 400-428** (active) — Second definition. Identical body to the reachable code of the first definition. This is the one Python uses via name binding (last definition wins).

The call site on line 171 (`args.fetch_list`) resolves to the second definition (line 400).

**What was removed:** Lines 276-397 — the first `_run_fetch_list` definition (lines 276-304) plus its orphaned `write_fetch_list_manifest` body (lines 306-397) plus the blank separator line.

**What was kept:** The second `_run_fetch_list` at the original line 400 (now 275).

## Behavior change

None. The removed code was entirely dead/unreachable.

## Tests

| Check | Result |
|-------|--------|
| Full test suite | 890/890 passed |
| Compile | OK |
| Whitespace | OK |
| Eval-corpus | 11/11 passed |

## Files changed

- `search_tool/cli.py` — removed dead duplicate `_run_fetch_list` + orphaned code

## Out of scope

- No CLI behavior changes
- No JSON schema changes
- No evidence format changes
- No dedup behavior changes
- No refactoring of `_run_fetch_url`, `write_fetch_list_manifest`, or other CLI functions
