# MVP-1K.7 — Tiny hygiene: dead test prefix fix

## Baseline
- SHA: ad7f49582e4bb651c596d70b9d68b4157ebd9a84
- Tests: 680/680 pass
- MVP-1K.6 fresh install dogfood complete

## Issue

Two test methods in `tests/test_init_claude.py` were missing the `test_` prefix, making them invisible to pytest:

- Line 141: `def command_file_contains_expected_strings` → `def test_command_file_contains_expected_strings`
- Line 148: `def hook_file_contains_expected_strings` → `def test_hook_file_contains_expected_strings`

Both were in the `TestInitClaudeContentVerification` class and contained valid assertions that were never executed.

## Fix

Added `test_` prefix to both methods. Test count: 24 → 26.

## Verification

- `tests/test_init_claude.py`: 26/26 pass (was 24/24)
- Full suite: 682/682 pass (was 680/680)
- Eval-corpus: 10/10 pass
- No runtime code changes
- No new files

## Files changed

- `tests/test_init_claude.py` — 2 method name fixes (2 lines)

## Verdict

**HYGIENE_PASS**

Two hidden tests uncovered. Both pass. Full suite 682/682.
